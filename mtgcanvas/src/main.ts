import * as PIXI from "pixi.js";
import {
  planImportPositions,
  computeBestGrid,
  planRectangles,
} from "./placement";
import type { PlacementContext } from "./placement";
import { SelectionStore } from "./state/selectionStore";
import { Camera } from "./scene/camera";
import {
  createCardSprite,
  updateCardSpriteAppearance,
  attachCardInteractions,
  type CardSprite,
  ensureCardImage,
  updateCardTextureForScale,
  getHiResQueueLength,
  getInflightTextureCount,
  enforceGpuBudgetForSprites,
  getDecodeQueueSize,
  getHiResQueueDiagnostics,
  getDecodeQueueStats,
  forceCompactHiResQueue,
} from "./scene/cardNode";
import { configureTextureSettings } from "./config/rendering";
import {
  getImageCacheStats,
  getCacheUsage,
  enableImageCacheDebug,
} from "./services/imageCache";
import {
  createGroupVisual,
  drawGroup,
  layoutGroup,
  type GroupVisual,
  HEADER_HEIGHT,
  autoPackGroup,
  addCardToGroupOrdered,
  removeCardFromGroup,
  updateGroupTextQuality,
  updateGroupMetrics,
  updateGroupZoomPresentation,
  ensureGroupEncapsulates,
  ensureMembersZOrder,
  placeCardInGroup,
} from "./scene/groupNode";
import { SpatialIndex } from "./scene/SpatialIndex";
import { MarqueeSystem } from "./interaction/marquee";
import { initHelp } from "./ui/helpPanel";
import { installModeToggle } from "./ui/modeToggle";
import {
  loadAll,
  queuePosition,
  persistGroupTransform,
  persistGroupRename,
} from "./services/persistenceService";
import { InstancesRepo, GroupsRepo } from "./data/repositories";
// Dataset constants referenced in logs only in dataset service; no usage here
import {
  ensureThemeToggleButton,
  ensureThemeStyles,
  registerThemeListener,
} from "./ui/theme";
import { Colors } from "./ui/theme";
import { installSearchPalette } from "./ui/searchPalette";
import { installImportExport } from "./ui/importExport";
import { searchScryfall, fetchScryfallByNames } from "./services/scryfall";
import {
  addImportedCards,
  getAllImportedCards,
  clearImportedCards,
} from "./services/cardStore";
import { clearImageCache } from "./services/imageCache";

// Phase 1 refactor: this file now bootstraps the Pixi application and delegates to scene modules.

const GRID_SIZE = 8; // global grid size
// To align cards to the grid while keeping them as close as possible, we need (CARD + GAP) % GRID_SIZE === 0.
// Card width=100 -> 100 % 8 = 4, so choose GAP_X=4 (smallest non-zero making 100+4=104 divisible by 8).
// Card height=140 -> 140 % 8 = 4, so choose GAP_Y=4 (makes 140+4=144 divisible by 8).
const CARD_W_GLOBAL = 100,
  CARD_H_GLOBAL = 140;
const GAP_X_GLOBAL = 4,
  GAP_Y_GLOBAL = 4; // minimal gaps achieving grid alignment
const SPACING_X = CARD_W_GLOBAL + GAP_X_GLOBAL;
const SPACING_Y = CARD_H_GLOBAL + GAP_Y_GLOBAL;
function snap(v: number) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

// Build placement context for the planner module
// buildPlacementContext is defined later inside the app bootstrap where world/sprites/groups are available

const app = new PIXI.Application();
// Splash management: keep canvas hidden until persisted layout + groups are restored
const splashEl = document.getElementById("splash");
(async () => {
  await app.init({
    background: Colors.canvasBg() as any,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
  });
  function parseCssHexColor(v: string): number | null {
    try {
      const s = (v || "").trim();
      if (!s) return null;
      if (s.startsWith("#")) {
        let hex = s.slice(1);
        if (hex.length === 3)
          hex = hex
            .split("")
            .map((c) => c + c)
            .join("");
        if (hex.length >= 6) hex = hex.slice(0, 6);
        const n = parseInt(hex, 16);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    } catch {
      return null;
    }
  }
  function applyCanvasBg() {
    try {
      const css = getComputedStyle(document.documentElement);
      const bg = css.getPropertyValue("--canvas-bg").trim();
      const hex = parseCssHexColor(bg);
      if (hex != null) app.renderer.background.color = hex as any;
    } catch {}
  }
  registerThemeListener(() => applyCanvasBg());
  // Will run once theme styles ensured below; calling here just in case dark default already present.
  applyCanvasBg();
  // Keep canvas hidden until ready (avoid pre-restore flicker)
  app.canvas.style.visibility = "hidden";
  document.body.appendChild(app.canvas);

  const world = new PIXI.Container();
  app.stage.addChild(world);
  app.stage.eventMode = "static";
  // World bounds: reduced by 1/2 in each dimension (center preserved)
  app.stage.hitArea = new PIXI.Rectangle(-25000, -25000, 50000, 50000);
  // Ensure world respects zIndex for proper layering (bounds marker behind cards)
  (world as any).sortableChildren = true;
  // Visual marker for the maximum canvas area (world-bounded region)
  let boundsMarker: PIXI.Graphics | null = null;
  let lastBounds: { x: number; y: number; w: number; h: number } | null = null;
  function boundsStrokeColor(): number {
    return Colors.boundsStroke();
  }
  function ensureBoundsMarker(b: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) {
    try {
      if (!boundsMarker) {
        boundsMarker = new PIXI.Graphics();
        boundsMarker.eventMode = "none";
        // Place behind cards/groups; world sorting is enabled later
        (boundsMarker as any).zIndex = -1000000;
        world.addChild(boundsMarker);
      }
      boundsMarker.clear();
      // Wireframe only: outline the bounds rectangle without fill; color depends on theme
      // Draw stroke entirely outside the true bounds so the inner edge equals the bounded area
      boundsMarker.rect(b.x, b.y, b.w, b.h).stroke({
        color: boundsStrokeColor() as any,
        width: 120,
        alignment: 0, // 0 = outside, 0.5 = centered (default), 1 = inside
      });
      lastBounds = { ...b };
    } catch {}
  }

  // Top-of-canvas banner: MTG Slop (fixed to screen, above world)
  const bannerLayer = new PIXI.Container();
  bannerLayer.zIndex = 1000000; // above everything
  bannerLayer.eventMode = "none"; // ignore pointer events
  app.stage.addChild(bannerLayer);
  // Ensure stage sorts by zIndex
  (app.stage as any).sortableChildren = true;
  const bannerText = new PIXI.Text("MTG Slop", {
    fill: Colors.bannerText() as any,
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: "800" as any,
    fontSize: 64,
    dropShadow: true,
    dropShadowColor: Colors.bannerShadow() as any,
    dropShadowBlur: 1,
    dropShadowDistance: 2,
    align: "left",
  } as any);
  bannerText.alpha = 0.9;
  bannerLayer.addChild(bannerText);
  // Keep banner colors in sync with theme changes
  registerThemeListener(() => {
    try {
      (bannerText.style as any).fill = Colors.bannerText() as any;
      (bannerText.style as any).dropShadowColor = Colors.bannerShadow() as any;
    } catch {}
  });
  function layoutBanner() {
    const padX = 16;
    const padY = 12;
    bannerText.x = padX;
    bannerText.y = padY;
  }
  layoutBanner();
  window.addEventListener("resize", layoutBanner);

  // Controls helper overlay (on-canvas) — shown whenever there are zero cards & zero groups
  let ctrlsOverlay: PIXI.Container | null = null;
  let ctrlsOverlayW = 0;
  // Theme helpers for overlay colors
  function overlayTheme() {
    return {
      fg: Colors.panelFg(),
      bg: Colors.panelBgAlt(),
      border: Colors.accent(),
    };
  }
  function createCtrlsOverlay(): PIXI.Container {
    const layer = new PIXI.Container();
    layer.zIndex = 999999; // below banner but above world
    layer.eventMode = "none";
    const theme = overlayTheme();
    const padX = 36;
    const padY = 28;
    const lineGap = 12;
    const bodyStyle = {
      fill: theme.fg as any,
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: 30,
      lineHeight: 28,
    } as any;
    const title = new PIXI.Text({
      text: "Controls",
      style: {
        fill: theme.fg as any,
        fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: "700" as any,
        fontSize: 60,
        lineHeight: 36,
      },
    });
    const lines: PIXI.Text[] = [
      new PIXI.Text({ text: "Import cards: Ctrl+I", style: bodyStyle }),
      new PIXI.Text({ text: "Group selected cards: G", style: bodyStyle }),
      new PIXI.Text({
        text: "Zoom: Mouse Wheel (cursor focus)",
        style: bodyStyle,
      }),
      new PIXI.Text({
        text: "Pan: Right-Click+Drag or Space+Drag",
        style: bodyStyle,
      }),
    ];
    // Measure
    let maxW = title.width;
    let totalH = title.height;
    for (const t of lines) {
      if (t.width > maxW) maxW = t.width;
      totalH += lineGap + t.height;
    }
    const w = Math.ceil(maxW + padX * 2);
    const h = Math.ceil(totalH + padY * 2);
    ctrlsOverlayW = w;
    // Background
    const bg = new PIXI.Graphics();
    const borderColor = theme.border;
    const fillColor = theme.bg;
    bg.roundRect(0, 0, w, h, 12)
      .fill({ color: fillColor as any, alpha: 0.92 })
      .stroke({ color: borderColor, width: 4 });
    layer.addChild(bg);
    // Position text
    let y = padY;
    title.x = padX;
    title.y = y;
    layer.addChild(title);
    y += title.height + lineGap;
    for (const t of lines) {
      t.x = padX;
      t.y = y;
      layer.addChild(t);
      y += t.height + lineGap;
    }
    return layer;
  }
  // Re-theme overlay when theme changes
  registerThemeListener(() => {
    if (!ctrlsOverlay) return;
    try {
      ctrlsOverlay.destroy({ children: true });
    } catch {}
    ctrlsOverlay = createCtrlsOverlay();
    app.stage.addChild(ctrlsOverlay);
    layoutCtrlsOverlay();
  });
  function layoutCtrlsOverlay() {
    if (!ctrlsOverlay) return;
    const cx = Math.round(window.innerWidth / 2 - ctrlsOverlayW / 2);
    const cy = Math.round(window.innerHeight * 0.18);
    ctrlsOverlay.x = Math.max(8, cx);
    ctrlsOverlay.y = Math.max(8, cy);
  }
  function showCtrlsOverlayIfNeeded() {
    try {
      if (ctrlsOverlay) return;
      ctrlsOverlay = createCtrlsOverlay();
      app.stage.addChild(ctrlsOverlay);
      layoutCtrlsOverlay();
    } catch {}
  }
  function hideCtrlsOverlay() {
    if (!ctrlsOverlay) return;
    try {
      ctrlsOverlay.destroy({ children: true });
    } catch {}
    ctrlsOverlay = null;
  }
  function updateEmptyStateOverlay() {
    // Note: relies on groups being initialized before this is called
    try {
      // Show overlay iff there are no cards on the canvas
      const isEmpty = sprites.length === 0;
      if (isEmpty) showCtrlsOverlayIfNeeded();
      else hideCtrlsOverlay();
    } catch {}
  }
  window.addEventListener("resize", layoutCtrlsOverlay);

  // Camera abstraction
  const camera = new Camera({ world });
  // Limit panning/zooming to a very large but finite canvas area
  try {
    const ha: any = app.stage.hitArea as any;
    if (ha && typeof ha.x === "number")
      camera.setWorldBounds({ x: ha.x, y: ha.y, w: ha.width, h: ha.height });
    if (ha && typeof ha.x === "number")
      ensureBoundsMarker({ x: ha.x, y: ha.y, w: ha.width, h: ha.height });
  } catch {}
  // Redraw bounds marker on theme changes with a theme-aware color
  registerThemeListener(() => {
    if (lastBounds) ensureBoundsMarker(lastBounds);
  });
  // Keep camera min zoom accommodating full bounds on viewport resize
  window.addEventListener("resize", () => {
    try {
      const ha: any = app.stage.hitArea as any;
      if (ha && typeof ha.x === "number")
        camera.setWorldBounds({ x: ha.x, y: ha.y, w: ha.width, h: ha.height });
    } catch {}
  });
  const spatial = new SpatialIndex();
  // Global z-order helper: monotonic counter shared across modules via window
  function nextZ(): number {
    const w: any = window as any;
    if (typeof w.__mtgZCounter !== "number") w.__mtgZCounter = 1000;
    w.__mtgZCounter += 1;
    return w.__mtgZCounter;
  }
  (window as any).__mtgNextZ = nextZ;
  // Compute the maximum zIndex among regular world content (cards and groups),
  // ignoring HUD/overlays that live in reserved high bands (>= 900k).
  function currentMaxContentZ(): number {
    const TOP_RESERVED = 1000000;
    let maxZ = 0;
    try {
      sprites.forEach((s) => {
        const z = s.zIndex || 0;
        if (z < TOP_RESERVED && z > maxZ) maxZ = z;
      });
    } catch {}
    try {
      groups.forEach((gv) => {
        const z = gv.gfx?.zIndex || 0;
        if (z < TOP_RESERVED && z > maxZ) maxZ = z;
      });
    } catch {}
    return maxZ;
  }
  // Expose for card layer to use when computing bring-to-front
  (window as any).__mtgMaxContentZ = currentMaxContentZ;
  // Expose a read-only accessor for sprites for cross-module utilities (avoid circular deps)
  (window as any).__mtgGetSprites = () => sprites;

  // Compute the minimum zIndex among regular world content (cards and groups).
  function currentMinContentZ(): number {
    let minZ = Number.POSITIVE_INFINITY;
    try {
      sprites.forEach((s) => {
        const z = s.zIndex || 0;
        if (z < minZ) minZ = z;
      });
    } catch {}
    try {
      groups.forEach((gv) => {
        const z = gv.gfx?.zIndex || 0;
        if (z < minZ) minZ = z;
      });
    } catch {}
    return minZ === Number.POSITIVE_INFINITY ? 0 : minZ;
  }

  // Persistently bring given groups (and their member cards) to the very top.
  function normalizeContentZ() {
    // Build ordered list of all content (groups + cards) by current z, then type, then id for stability
    type Entry =
      | { kind: "group"; id: number; z: number }
      | { kind: "card"; id: number; z: number };
    const entries: Entry[] = [];
    groups.forEach((gv) =>
      entries.push({ kind: "group", id: gv.id, z: gv.gfx?.zIndex || 0 }),
    );
    sprites.forEach((s) =>
      entries.push({ kind: "card", id: s.__id, z: s.zIndex || 0 }),
    );
    if (!entries.length) return;
    entries.sort((a, b) => {
      if (a.z !== b.z) return a.z - b.z;
      // For identical z, put groups before cards so cards get a strictly higher normalized z afterwards
      if (a.kind !== b.kind) return a.kind === "group" ? -1 : 1;
      return a.id - b.id;
    });
    // Assign compact, bounded z in [0, N]
    let zVal = 0;
    for (const e of entries) {
      if (e.kind === "group") {
        const gv = groups.get(e.id);
        if (gv) gv.gfx.zIndex = zVal;
      } else {
        const s = sprites.find((sp) => sp.__id === e.id);
        if (s) {
          s.zIndex = zVal;
          (s as any).__baseZ = zVal;
        }
      }
      zVal += 1;
    }
  }
  (window as any).__mtgNormalizeZ = normalizeContentZ;

  function bringGroupsToFrontPersistent(groupIds: number[]) {
    if (!groupIds || !groupIds.length) return;
    // Normalize first so we operate on a compact, bounded range and preserve relative order
    try {
      normalizeContentZ();
    } catch {}
    const ids = Array.from(new Set(groupIds));
    const draggedGroupIds = new Set<number>(ids);
    const draggedCardIds = new Set<number>();
    ids.forEach((id) => {
      const gg = groups.get(id);
      if (!gg) return;
      gg.items.forEach((cid) => draggedCardIds.add(cid));
    });
    // Compute baseline excluding these groups and their members
    let base = 0;
    sprites.forEach((s) => {
      if (draggedCardIds.has(s.__id)) return;
      const z = s.zIndex || 0;
      if (z > base) base = z;
    });
    groups.forEach((gv, id) => {
      if (draggedGroupIds.has(id)) return;
      const z = gv.gfx?.zIndex || 0;
      if (z > base) base = z;
    });
    base += 1;
    // Stable order: by current z then id, to preserve relative order between raised groups
    const ordered = ids
      .map((id) => ({ id, z: groups.get(id)?.gfx?.zIndex || 0 }))
      .sort((a, b) => (a.z === b.z ? a.id - b.id : a.z - b.z))
      .map((e) => e.id);
    for (const id of ordered) {
      const gg = groups.get(id);
      if (!gg) continue;
      gg.gfx.zIndex = base++;
      gg.order.forEach((cid) => {
        const sp = sprites.find((s) => s.__id === cid);
        if (!sp) return;
        sp.zIndex = base;
        (sp as any).__baseZ = base;
        base += 1;
      });
    }
    // Persist: instances z and groups (which now include z)
    try {
      const data = {
        instances: sprites.map((s) => ({
          id: s.__id,
          x: s.x,
          y: s.y,
          z: s.zIndex || (s as any).__baseZ || 0,
          group_id: (s as any).__groupId ?? null,
          scryfall_id:
            (s as any).__scryfallId || ((s as any).__card?.id ?? null),
        })),
        byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
      };
      try {
        InstancesRepo.updateMany(
          data.instances.map((r) => ({ id: r.id, z: r.z })) as any,
        );
      } catch {}
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {}
    scheduleGroupSave();
  }

  // Card layer & data (persisted instances)
  const sprites: CardSprite[] = [];
  // Groups container + visuals (initialized early so camera fit can consider them)
  const groups = new Map<number, GroupVisual>();
  // Transient z-order rules during drag: use very high z values below HUD/banner
  // Live-refresh groups on theme changes (colors, text fills, overlay presentation)
  registerThemeListener(() => {
    try {
      groups.forEach((gv) => {
        // Ensure overlay/header visibility & overlay text color/position reflect new theme
        updateGroupZoomPresentation(gv, world.scale.x, sprites);
        // Redraw with current theme-derived palette
        drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
      });
    } catch {}
  });
  // Build placement context for planner module (captures live references)
  function buildPlacementContext(): PlacementContext {
    return {
      sprites,
      groups,
      world,
      getCanvasBounds,
      gridSize: GRID_SIZE,
      cardW: CARD_W_GLOBAL,
      cardH: CARD_H_GLOBAL,
      gapX: GAP_X_GLOBAL,
      gapY: GAP_Y_GLOBAL,
      spacingX: SPACING_X,
      spacingY: SPACING_Y,
    } as PlacementContext;
  }
  let zCounter = 1;
  function createSpriteForInstance(inst: {
    id: number;
    x: number;
    y: number;
    z: number;
    group_id?: number | null;
    card?: any;
  }) {
    const s = createCardSprite({
      id: inst.id,
      x: inst.x,
      y: inst.y,
      // Prefer provided z (restored), otherwise assign and advance counter
      z: typeof inst.z === "number" ? inst.z : zCounter++,
      renderer: app.renderer,
      card: inst.card,
    });
    if (inst.group_id) (s as any).__groupId = inst.group_id;
    // Flag for context / pan logic
    (s as any).__cardSprite = true;
    world.addChild(s);
    sprites.push(s);
    // Any card addition should hide the overlay immediately
    updateEmptyStateOverlay();
    spatial.insert({
      id: s.__id,
      minX: s.x,
      minY: s.y,
      maxX: s.x + CARD_W_GLOBAL,
      maxY: s.y + CARD_H_GLOBAL,
    });
    attachCardInteractions(
      s,
      () => sprites,
      world,
      app.stage,
      // onDrop: finalize membership & persist
      (moved) => handleDroppedSprites(moved),
      () => panning,
      (global, additive) => marquee.start(global, additive),
      // onDragMove: only update spatial (no membership changes yet)
      (moved) =>
        moved.forEach((ms) => {
          spatial.update({
            id: ms.__id,
            minX: ms.x,
            minY: ms.y,
            maxX: ms.x + CARD_W_GLOBAL,
            maxY: ms.y + CARD_H_GLOBAL,
          });
        }),
    );
    // Ensure context menu listener
    try {
      (ensureCardContextListeners as any)();
    } catch {}
    // Adding a sprite may end the empty state (safe before groups exist)
    updateEmptyStateOverlay();
    return s;
  }
  // Fast path: create many sprites with minimal side effects and batch spatial index updates
  function createSpritesBulk(
    items: {
      id: number;
      x: number;
      y: number;
      z: number;
      group_id?: number | null;
      card?: any;
    }[],
  ): CardSprite[] {
    if (!items.length) return [];
    const created: CardSprite[] = [];
    // Temporarily suppress UI saves and overlays churn
    const prevSuppress = SUPPRESS_SAVES;
    SUPPRESS_SAVES = true;
    try {
      for (const inst of items) {
        const s = createCardSprite({
          id: inst.id,
          x: inst.x,
          y: inst.y,
          z: inst.z ?? zCounter++,
          renderer: app.renderer,
          card: inst.card,
        });
        if (inst.group_id) (s as any).__groupId = inst.group_id;
        (s as any).__cardSprite = true;
        world.addChild(s);
        sprites.push(s);
        created.push(s);
      }
      // Batch spatial inserts
      spatial.bulkLoad(
        created.map((s) => ({
          id: s.__id,
          minX: s.x,
          minY: s.y,
          maxX: s.x + CARD_W_GLOBAL,
          maxY: s.y + CARD_H_GLOBAL,
        })),
      );
      // Attach interactions for each created sprite so they are immediately clickable/draggable
      created.forEach((s) =>
        attachCardInteractions(
          s,
          () => sprites,
          world,
          app.stage,
          // onDrop
          (moved) => handleDroppedSprites(moved),
          () => panning,
          (global, additive) => marquee.start(global, additive),
          // onDragMove
          (moved) =>
            moved.forEach((ms) => {
              spatial.update({
                id: ms.__id,
                minX: ms.x,
                minY: ms.y,
                maxX: ms.x + CARD_W_GLOBAL,
                maxY: ms.y + CARD_H_GLOBAL,
              });
            }),
        ),
      );
      // Fire image loads after they exist to parallelize
      created.forEach((s) => ensureCardImage(s));
    } finally {
      SUPPRESS_SAVES = prevSuppress;
      updateEmptyStateOverlay();
      try {
        // Ensure right-click context menu listeners are wired for new cards
        (ensureCardContextListeners as any)();
      } catch {}
    }
    return created;
  }
  const loaded = loadAll();
  const LS_KEY = "mtgcanvas_positions_v1";
  const LS_GROUPS_KEY = "mtgcanvas_groups_v1";
  // Suppress any local save side effects (used when clearing data to avoid races that re-save)
  let SUPPRESS_SAVES = false;
  let memoryGroupsData: any = null;
  let groupsRestored = false;
  {
    try {
      const raw = localStorage.getItem(LS_GROUPS_KEY);
      if (raw) memoryGroupsData = JSON.parse(raw);
    } catch {}
  }
  // (index-based pre-parse removed; id-based restore applies in applyStoredPositionsMemory)
  function applyStoredPositionsMemory() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (!obj) return;
      // Primary: id-based
      if (Array.isArray(obj.instances)) {
        const map = new Map<
          number,
          {
            x: number;
            y: number;
            group_id?: number | null;
            scryfall_id?: string | null;
          }
        >();
        obj.instances.forEach((r: any) => {
          if (typeof r.id === "number")
            map.set(r.id, {
              x: r.x,
              y: r.y,
              group_id: r.group_id ?? null,
              scryfall_id: r.scryfall_id ?? null,
            });
        });
        let matched = 0;
        sprites.forEach((s) => {
          const p = map.get(s.__id);
          if (p) {
            // Clamp restored positions to bounds
            const b = getCanvasBounds();
            s.x = Math.min(b.x + b.w - CARD_W_GLOBAL, Math.max(b.x, p.x));
            s.y = Math.min(b.y + b.h - CARD_H_GLOBAL, Math.max(b.y, p.y));
            // Restore z if available on p (populated by LS)
            const anyP: any = p as any;
            if (typeof anyP.z === "number") {
              s.zIndex = anyP.z;
              (s as any).__baseZ = anyP.z;
            }
            if (p.group_id != null) (s as any).__groupId = p.group_id;
            if (p.scryfall_id) (s as any).__scryfallId = p.scryfall_id;
            matched++;
          }
        });
        // Index-based if few matched (ids changed)
        if (matched < sprites.length * 0.5 && Array.isArray(obj.byIndex)) {
          obj.byIndex.forEach((p: any, idx: number) => {
            const s = sprites[idx];
            if (s && p && typeof p.x === "number" && typeof p.y === "number") {
              const b = getCanvasBounds();
              s.x = Math.min(b.x + b.w - CARD_W_GLOBAL, Math.max(b.x, p.x));
              s.y = Math.min(b.y + b.h - CARD_H_GLOBAL, Math.max(b.y, p.y));
            }
          });
        }
        // Refresh spatial index bounds after applying new positions
        sprites.forEach((s) =>
          spatial.update({
            id: s.__id,
            minX: s.x,
            minY: s.y,
            maxX: s.x + CARD_W_GLOBAL,
            maxY: s.y + CARD_H_GLOBAL,
          }),
        );
      }
    } catch {}
  }
  // Rehydrate previously imported Scryfall cards (raw JSON) and attach sprites
  async function rehydrateImportedCards() {
    // IndexedDB-backed store only
    let cards: any[] = [];
    try {
      cards = await getAllImportedCards();
    } catch {}
    if (!cards.length) return;
    // Try to restore stable instance ids and group memberships from saved positions
    let saved: any = null;
    try {
      const raw =
        localStorage.getItem(LS_KEY) ||
        localStorage.getItem("mtgcanvas_positions_v1");
      if (raw) saved = JSON.parse(raw);
    } catch {}
    const savedByScry: Map<
      string,
      {
        id: number;
        x: number;
        y: number;
        z?: number;
        group_id: number | null;
      }[]
    > = new Map();
    if (saved && Array.isArray(saved.instances)) {
      for (const r of saved.instances) {
        const sid = r?.scryfall_id ? String(r.scryfall_id) : null;
        if (!sid || typeof r.id !== "number") continue;
        const arr = savedByScry.get(sid) || [];
        arr.push({
          id: r.id,
          x: r.x ?? 0,
          y: r.y ?? 0,
          z: typeof r.z === "number" ? r.z : undefined,
          group_id: r.group_id ?? null,
        });
        savedByScry.set(sid, arr);
      }
      // Ensure deterministic usage order
      savedByScry.forEach((list) => list.sort((a, b) => a.id - b.id));
    }
    // Track max id to avoid collisions
    let maxId = 0;
    savedByScry.forEach((list) =>
      list.forEach((e) => {
        if (e.id > maxId) maxId = e.id;
      }),
    );
    if (maxId > 0) {
      try {
        (InstancesRepo as any).ensureNextId &&
          (InstancesRepo as any).ensureNextId(maxId + 1);
      } catch {}
    }
    // Create sprites strictly based on saved positions per Scryfall id
    for (const card of cards) {
      const sid = String(card?.id || "");
      const pool = sid && savedByScry.get(sid);
      if (!pool || !pool.length) continue; // no saved instances -> don't recreate
      for (const entry of pool) {
        let id = entry.id;
        const x = entry.x;
        const y = entry.y;
        const z = typeof entry.z === "number" ? entry.z : undefined;
        const gid: number | null = entry.group_id;
        try {
          id = (InstancesRepo as any).createWithId
            ? (InstancesRepo as any).createWithId({
                id,
                card_id: 1,
                x,
                y,
                z: z ?? 0,
                group_id: gid,
              })
            : id;
        } catch {
          try {
            id = InstancesRepo.create(1, x, y);
          } catch {
            id = ++maxId;
          }
        }
        const sp = createSpriteForInstance({
          id,
          x,
          y,
          z: z ?? zCounter++,
          card,
        });
        if (gid != null) (sp as any).__groupId = gid;
        (sp as any).__scryfallId = sid || null;
        ensureCardImage(sp);
      }
    }
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.instances)) {
        obj.instances.forEach((r: any) => {
          const inst = loaded.instances.find((i) => i.id === r.id);
          if (inst) {
            inst.x = r.x;
            inst.y = r.y;
            // Also restore z-order if present
            if (typeof r.z === "number") (inst as any).z = r.z;
            (inst as any).group_id = r.group_id ?? inst.group_id ?? null;
          }
        });
      }
    }
  } catch {}
  let startupComplete = false;
  function finishStartup() {
    if (startupComplete) return;
    startupComplete = true;
    // Show canvas, remove splash
    app.canvas.style.visibility = "visible";
    try {
      splashEl?.parentElement?.removeChild(splashEl);
    } catch {}
  }

  // Smart initial camera framing: fit view to all content once after load
  let initialFitDone = false;
  function computeSceneBounds(): {
    x: number;
    y: number;
    w: number;
    h: number;
  } | null {
    if (!sprites.length && !(groups && groups.size)) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    // Include card sprites
    for (const s of sprites) {
      const x1 = s.x;
      const y1 = s.y;
      const x2 = s.x + CARD_W_GLOBAL;
      const y2 = s.y + CARD_H_GLOBAL;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    // Include group frames if any exist
    try {
      groups?.forEach((gv: any) => {
        const x1 = gv.gfx?.x ?? gv.x ?? 0;
        const y1 = gv.gfx?.y ?? gv.y ?? 0;
        const x2 = x1 + (gv.w ?? 0);
        const y2 = y1 + (gv.h ?? 0);
        if (x1 < minX) minX = x1;
        if (y1 < minY) minY = y1;
        if (x2 > maxX) maxX = x2;
        if (y2 > maxY) maxY = y2;
      });
    } catch {}
    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY)
    )
      return null;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    // Add a little padding so content isn't flush to edges
    const pad = 40;
    return { x: minX - pad, y: minY - pad, w: w + pad * 2, h: h + pad * 2 };
  }

  function tryInitialFit() {
    if (initialFitDone) return;
    const b = computeSceneBounds();
    if (!b) return;
    initialFitDone = true;
    camera.fitBounds(b, { w: window.innerWidth, h: window.innerHeight });
  }
  function focusViewOnContent(duration = 220) {
    const b = computeSceneBounds();
    if (!b) return;
    camera.animateTo(
      { bounds: b, viewport: { w: window.innerWidth, h: window.innerHeight } },
      duration,
    );
  }

  // Disable automatic dataset JSON load: always start without spawning universe
  console.log(
    "[startup] dataset auto-load disabled; starting empty unless DB already has instances",
  );
  if (!loaded.instances.length) {
    // Rehydrate any previously imported cards (from IndexedDB/LS), then apply positions/groups
    await rehydrateImportedCards();
    applyStoredPositionsMemory();
    tryInitialFit();
    finishStartup();
  } else {
    loaded.instances.forEach((inst: any) => createSpriteForInstance(inst));
    // Also add imported cards in memory mode even if repo returned instances (browser fallback only)
    await rehydrateImportedCards();
    applyStoredPositionsMemory();
    tryInitialFit();
  }

  // Batched finalize for many dropped cards: detect target groups once, batch membership updates,
  // and relayout affected groups a single time to avoid O(n^2) redraw/metrics churn.
  function handleDroppedSprites(moved: CardSprite[]) {
    if (!moved || !moved.length) return;
    // 1) Update spatial bounds for all moved sprites
    for (const ms of moved) {
      spatial.update({
        id: ms.__id,
        minX: ms.x,
        minY: ms.y,
        maxX: ms.x + CARD_W_GLOBAL,
        maxY: ms.y + CARD_H_GLOBAL,
      });
    }
    // Helper: find group under sprite center
    const hitGroup = (s: CardSprite): GroupVisual | null => {
      const cx = s.x + CARD_W_GLOBAL / 2;
      const cy = s.y + CARD_H_GLOBAL / 2;
      for (const gv of groups.values()) {
        if (
          cx >= gv.gfx.x &&
          cx <= gv.gfx.x + gv.w &&
          cy >= gv.gfx.y &&
          cy <= gv.gfx.y + gv.h
        )
          return gv;
      }
      return null;
    };
    // 2) Partition by target group and track old groups for removals
    const toAdd = new Map<number, CardSprite[]>();
    const toRemove = new Map<number, CardSprite[]>();
    const noGroup: CardSprite[] = [];
    for (const s of moved) {
      const target = hitGroup(s);
      const oldId = (s as any).__groupId as number | undefined;
      if (target) {
        if (!oldId || oldId !== target.id) {
          if (oldId && groups.has(oldId)) {
            const arr = toRemove.get(oldId) || [];
            arr.push(s);
            toRemove.set(oldId, arr);
          }
          const arr = toAdd.get(target.id) || [];
          arr.push(s);
          toAdd.set(target.id, arr);
        } // else: stayed within same group; no membership change
      } else {
        if (oldId && groups.has(oldId)) {
          const arr = toRemove.get(oldId) || [];
          arr.push(s);
          toRemove.set(oldId, arr);
          noGroup.push(s);
        } else {
          // Remained ungrouped: still queue position for persistence below
        }
      }
    }
    // 3) Apply removals from old groups
    const membershipUpdates: { id: number; group_id: number | null }[] = [];
    toRemove.forEach((spritesToRemove, gid) => {
      const gv = groups.get(gid);
      if (!gv) return;
      for (const s of spritesToRemove) {
        removeCardFromGroup(gv, s.__id);
        (s as any).__groupId = undefined;
      }
      updateGroupMetrics(gv, sprites);
      drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
    });
    // 4) Apply additions to target groups
    toAdd.forEach((spritesToAdd, gid) => {
      const gv = groups.get(gid);
      if (!gv) return;
      // Append in current order; preserve existing ordering
      for (const s of spritesToAdd) {
        addCardToGroupOrdered(gv, s.__id, gv.order.length);
        (s as any).__groupId = gv.id;
        membershipUpdates.push({ id: s.__id, group_id: gv.id });
      }
      // Strategy: if many being added, do a single grid layout; else, place near drop point
      const MANY_THRESHOLD = 8;
      if (spritesToAdd.length >= MANY_THRESHOLD) {
        layoutGroup(gv, sprites, (sp) =>
          spatial.update({
            id: sp.__id,
            minX: sp.x,
            minY: sp.y,
            maxX: sp.x + CARD_W_GLOBAL,
            maxY: sp.y + CARD_H_GLOBAL,
          }),
        );
      } else {
        // Light path: place each near its current position without full relayout
        for (const s of spritesToAdd) {
          placeCardInGroup(
            gv,
            s,
            sprites,
            (sp) =>
              spatial.update({
                id: sp.__id,
                minX: sp.x,
                minY: sp.y,
                maxX: sp.x + CARD_W_GLOBAL,
                maxY: sp.y + CARD_H_GLOBAL,
              }),
            s.x,
            s.y,
          );
        }
      }
      // Overlay: if zoom overlay active, hide new members immediately
      if ((gv._lastZoomPhase || 0) > 0.05) {
        const now = performance.now();
        for (const s of spritesToAdd) {
          (s as any).__groupOverlayActive = true;
          (s as any).eventMode = "none" as any;
          s.cursor = "default";
          s.alpha = 0;
          s.visible = false;
          s.renderable = false;
          (s as any).__hiddenAt = now;
        }
      }
      ensureMembersZOrder(gv, sprites);
      updateGroupMetrics(gv, sprites);
      drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
    });
    // 5) Persist membership changes in one batch
    if (membershipUpdates.length) {
      try {
        InstancesRepo.updateMany(membershipUpdates as any);
      } catch {}
    }
    // 6) Finalize sprite appearances for cards that became ungrouped
    for (const s of noGroup) {
      (s as any).__groupOverlayActive = false;
      (s as any).eventMode = "static";
      s.cursor = "pointer";
      s.alpha = 1;
      s.visible = true;
      s.renderable = true;
      updateCardSpriteAppearance(s, SelectionStore.state.cardIds.has(s.__id));
      membershipUpdates.push({ id: s.__id, group_id: null });
    }
    // 7) Queue all positions and schedule single save
    for (const ms of moved) queuePosition(ms);
    scheduleLocalSave();
    if (toAdd.size || toRemove.size) scheduleGroupSave();
  }
  // Unified group deletion: reset member cards and remove the group
  function deleteGroupById(id: number) {
    const gv = groups.get(id);
    if (!gv) return;
    const ids = [...gv.items];
    const updates: { id: number; group_id: null }[] = [];
    ids.forEach((cid) => {
      const sp = sprites.find((s) => s.__id === cid);
      if (sp) {
        (sp as any).__groupId = undefined;
        (sp as any).__groupOverlayActive = false;
        (sp as any).eventMode = "static";
        sp.cursor = "pointer";
        sp.alpha = 1;
        sp.visible = true;
        sp.renderable = true;
        updateCardSpriteAppearance(
          sp,
          SelectionStore.state.cardIds.has(sp.__id),
        );
      }
      updates.push({ id: cid, group_id: null });
    });
    try {
      if (updates.length) InstancesRepo.updateMany(updates as any);
    } catch {}
    try {
      gv.gfx.destroy();
    } catch {}
    groups.delete(id);
    updateEmptyStateOverlay();
  }
  // Memory mode group persistence helpers
  let lsGroupsTimer: any = null;
  function scheduleGroupSave() {
    if (SUPPRESS_SAVES) return;
    if (lsGroupsTimer) return;
    lsGroupsTimer = setTimeout(persistLocalGroups, 400);
  }
  function persistLocalGroups() {
    if (SUPPRESS_SAVES) {
      lsGroupsTimer = null;
      return;
    }
    lsGroupsTimer = null;
    try {
      const data = {
        groups: [...groups.values()].map((gv) => ({
          id: gv.id,
          x: gv.gfx.x,
          y: gv.gfx.y,
          w: gv.w,
          h: gv.h,
          z: gv.gfx.zIndex || 0,
          name: gv.name,
          collapsed: gv.collapsed,
          // color retired; theme-driven only
          // Faceted sections removed; no layout mode persistence
          membersById: gv.order.slice(),
          membersByIndex: gv.order
            .map((cid) => sprites.findIndex((s) => s.__id === cid))
            .filter((i) => i >= 0),
        })),
      };
      localStorage.setItem(LS_GROUPS_KEY, JSON.stringify(data));
    } catch {}
  }
  // (Older restoreMemoryGroups variant removed to avoid duplication; see final definition below.)
  function restoreMemoryGroups() {
    if (groupsRestored) return;
    groupsRestored = true;
    if (!memoryGroupsData || !Array.isArray(memoryGroupsData.groups)) return;
    memoryGroupsData.groups.forEach((gr: any) => {
      const gv = createGroupVisual(
        gr.id,
        gr.x ?? 0,
        gr.y ?? 0,
        gr.w ?? 300,
        gr.h ?? 300,
      );
      if (gr.name) gv.name = gr.name;
      /* collapse retired: always load expanded */ gv.collapsed = false;
      // color retired; theme-driven only
      // Faceted sections removed; ignore persisted layout/facet
      if (typeof gr.z === "number") {
        try {
          gv.gfx.zIndex = gr.z;
        } catch {}
      }
      groups.set(gv.id, gv);
      world.addChild(gv.gfx);
      attachResizeHandle(gv);
      attachGroupInteractions(gv);
    });
    memoryGroupsData.groups.forEach((gr: any) => {
      const gv = groups.get(gr.id);
      if (!gv) return;
      let matched = 0;
      if (Array.isArray(gr.membersById))
        gr.membersById.forEach((cid: number) => {
          const s = sprites.find((sp) => sp.__id === cid);
          if (s) {
            addCardToGroupOrdered(gv, s.__id, gv.order.length);
            (s as any).__groupId = gv.id;
            matched++;
          }
        });
      if (matched < 1 && Array.isArray(gr.membersByIndex))
        gr.membersByIndex.forEach((idx: number) => {
          const s = sprites[idx];
          if (s) {
            addCardToGroupOrdered(gv, s.__id, gv.order.length);
            (s as any).__groupId = gv.id;
          }
        });
    });
    // Finally, reconcile using each instance's stored group_id as the source of truth
    sprites.forEach((s) => {
      const gid = (s as any).__groupId;
      if (gid && groups.has(gid)) {
        const gv = groups.get(gid)!;
        if (!gv.items.has(s.__id)) {
          addCardToGroupOrdered(gv, s.__id, gv.order.length);
        }
      }
    });
    groups.forEach((gv) => {
      ensureMembersZOrder(gv, sprites);
      // Normalize baseZ of members to their zIndex after restore so future drags are stable
      gv.order.forEach((cid) => {
        const sp = sprites.find((s) => s.__id === cid);
        if (sp) (sp as any).__baseZ = sp.zIndex || (sp as any).__baseZ || 0;
      });
      ensureGroupEncapsulates(gv, sprites);
      updateGroupMetrics(gv, sprites);
      drawGroup(gv, false);
    });
    // Ensure new group creations won't collide with restored ids (memory only)
    try {
      const maxId = Math.max(...[...groups.keys(), 0]);
      (GroupsRepo as any).ensureNextId &&
        (GroupsRepo as any).ensureNextId(maxId + 1);
    } catch {}
    scheduleGroupSave();
    updateEmptyStateOverlay();
  }
  // Rehydrate persisted groups
  if (loaded.groups && (loaded as any).groups.length) {
    (loaded as any).groups.forEach((gr: any) => {
      const t = gr.transform;
      if (!t) return;
      const gv = createGroupVisual(
        gr.id,
        t.x ?? 0,
        t.y ?? 0,
        t.w ?? 300,
        t.h ?? 300,
      );
      gv.name = gr.name || gv.name;
      // Collapse feature retired: ignore persisted collapsed flag so zoom overlay can function
      gv.collapsed = false;
      groups.set(gr.id, gv);
      world.addChild(gv.gfx);
      attachResizeHandle(gv);
      attachGroupInteractions(gv);
      drawGroup(gv, false);
    });
    // After groups exist, attach any sprites with stored group_id
    sprites.forEach((s) => {
      const gid = (s as any).__groupId;
      if (gid && groups.has(gid)) {
        const gv = groups.get(gid)!;
        gv.items.add(s.__id);
        gv.order.push(s.__id);
      }
    });
    // Layout groups with their members and ensure z-order above frames
    groups.forEach((gv) => {
      ensureMembersZOrder(gv, sprites);
      ensureGroupEncapsulates(gv, sprites);
      updateGroupMetrics(gv, sprites);
      drawGroup(gv, false);
    });
    // Ensure new group creations won't collide with restored ids
    try {
      const maxId = Math.max(...[...groups.keys(), 0]);
      (GroupsRepo as any).ensureNextId &&
        (GroupsRepo as any).ensureNextId(maxId + 1);
    } catch {}
    finishStartup();
    tryInitialFit();
    updateEmptyStateOverlay();
  } else {
    // If instances were present at load-time, restore groups from local storage immediately.
    if (loaded.instances.length) {
      restoreMemoryGroups();
    }
    // If we started empty but rehydrated cards earlier, restore groups now that groups exist.
    else if (sprites.length) {
      restoreMemoryGroups();
      tryInitialFit();
    }
  }
  world.sortableChildren = true;

  // Runtime texture/gpu settings (no localStorage). Tune here as needed.
  configureTextureSettings({
    gpuBudgetMB: 5096, // ~60% of 8GB
    allowEvict: true, // reclaim unreferenced textures
    disablePngTier: true, // keep medium-tier only for big boards; toggle off for small projects
    decodeParallelLimit: 8, // safer default to avoid driver/decoder stress on huge datasets
    hiResLimit: 2000, // cap number of hi-res textures retained concurrently
  });
  // (Ticker added later to include overlay presentation updates.)

  const help = initHelp();
  (window as any).__helpAPI = help; // debug access
  // Use a top-right FAB instead of a keyboard shortcut
  help.ensureFab();
  // After help API exists, update empty-state once
  updateEmptyStateOverlay();

  // Inline group renaming (kept local for now)
  function startGroupRename(gv: GroupVisual) {
    // Avoid multiple editors
    if (document.getElementById(`group-rename-${gv.id}`)) return;
    const input = document.createElement("input");
    input.id = `group-rename-${gv.id}`;
    input.type = "text";
    input.value = gv.name;
    input.maxLength = 64;
    // Position over header using screen coordinates
    const bounds = app.renderer.canvas.getBoundingClientRect();
    // Transform group header position to screen
    const global = new PIXI.Point(gv.gfx.x, gv.gfx.y);
    const pt = world.toGlobal(global);
    const scale = world.scale.x; // approximate uniform scale
    input.style.position = "fixed";
    input.style.left = `${bounds.left + pt.x + 6}px`;
    input.style.top = `${bounds.top + pt.y + 4}px`;
    input.style.zIndex = "10000";
    input.style.padding = "3px 6px";
    input.style.font = '12px "Inter", system-ui, sans-serif';
    // Use theme variables for colors
    input.style.color = "var(--input-fg)";
    input.style.background = "var(--input-bg)";
    input.style.border = "1px solid var(--input-border)";
    input.style.borderRadius = "4px";
    input.style.outline = "none";
    input.style.width = `${Math.max(80, Math.min(240, gv.w * scale - 20))}px`;
    document.body.appendChild(input);
    input.select();
    function commit(save: boolean) {
      if (save) {
        const val = input.value.trim();
        if (val) {
          gv.name = val;
          drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
          persistGroupRename(gv.id, val);
          scheduleGroupSave();
        }
      }
      input.remove();
    }
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        commit(true);
      } else if (ev.key === "Escape") {
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));
  }

  // ---- Side Group Info Panel (replaces floating rename buttons) ----
  let groupInfoPanel: HTMLDivElement | null = null;
  let groupInfoNameInput: HTMLInputElement | null = null;
  function ensureGroupInfoPanel() {
    if (groupInfoPanel) return groupInfoPanel;
    const el = document.createElement("div");
    el.id = "group-info-panel";
    // Match card info panel geometry, anchored bottom-right
    el.style.cssText =
      "position:fixed;right:14px;bottom:14px;width:520px;max-width:55vw;max-height:80vh;z-index:10015;display:flex;flex-direction:column;pointer-events:auto;font-size:18px;";
    el.className = "ui-panel";

    // Header (mirrors card panel header)
    const header = document.createElement("div");
    header.id = "gip-header";
    header.style.cssText =
      "padding:10px 14px 6px;font-size:14px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--panel-accent);display:flex;align-items:center;gap:8px;justify-content:space-between;";
    const headerTitle = document.createElement("div");
    headerTitle.textContent = "Group";
    header.appendChild(headerTitle);
    // Optional clear button on header
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "×";
    clearBtn.title = "Clear selection";
    clearBtn.className = "ui-btn";
    clearBtn.style.cssText =
      "width:32px;height:32px;padding:0;font-size:18px;line-height:18px;";
    clearBtn.onclick = () => {
      SelectionStore.clear();
      updateGroupInfoPanel();
    };
    header.appendChild(clearBtn);
    el.appendChild(header);

    // Scrollable content container
    const scroll = document.createElement("div");
    scroll.id = "gip-scroll";
    scroll.style.cssText =
      "overflow:auto;padding:0 14px 18px;display:flex;flex-direction:column;gap:14px;";
    el.appendChild(scroll);

    // Name editor
    const nameWrap = document.createElement("div");
    nameWrap.style.display = "flex";
    nameWrap.style.flexDirection = "column";
    nameWrap.style.gap = "4px";
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Name";
    nameLabel.style.fontSize = "11px";
    nameLabel.style.opacity = "0.75";
    nameWrap.appendChild(nameLabel);
    const nameInput = document.createElement("input");
    groupInfoNameInput = nameInput;
    nameInput.type = "text";
    nameInput.maxLength = 64;
    nameInput.className = "ui-input";
    nameInput.style.fontSize = "16px";
    nameInput.style.padding = "8px 10px";
    nameWrap.appendChild(nameInput);
    scroll.appendChild(nameWrap);

    // Metrics
    const metrics = document.createElement("div");
    metrics.id = "group-info-metrics";
    metrics.style.cssText =
      "display:grid;grid-template-columns:auto 1fr;column-gap:12px;row-gap:4px;font-size:16px;min-width:140px;";
    scroll.appendChild(metrics);

    // Actions
    const actions = document.createElement("div");
    actions.style.cssText =
      "display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;";
    function makeBtn(label: string, handler: () => void) {
      const b = document.createElement("button");
      b.textContent = label;
      b.type = "button";
      b.className = "ui-btn";
      b.style.fontSize = "15px";
      b.style.padding = "8px 12px";
      b.onclick = handler;
      return b;
    }
    const autoBtn = makeBtn("Auto-pack", () => {
      const gv = currentPanelGroup();
      if (!gv) return;
      autoPackGroup(gv, sprites, (s) =>
        spatial.update({
          id: s.__id,
          minX: s.x,
          minY: s.y,
          maxX: s.x + CARD_W_GLOBAL,
          maxY: s.y + CARD_H_GLOBAL,
        }),
      );
      updateGroupMetrics(gv, sprites);
      drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
      scheduleGroupSave();
      updateGroupInfoPanel();
    });
    const deleteBtn = makeBtn("Delete", () => {
      const gv = currentPanelGroup();
      if (!gv) return;
      deleteGroupById(gv.id);
      SelectionStore.clear();
      scheduleGroupSave();
      updateGroupInfoPanel();
    });
    deleteBtn.classList.add("danger");
    actions.append(autoBtn, deleteBtn);
    scroll.appendChild(actions);

    // Name input commit
    nameInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        commitName();
        nameInput.blur();
      }
    });
    nameInput.addEventListener("blur", () => commitName());
    function commitName() {
      const gv = currentPanelGroup();
      if (!gv) return;
      const v = nameInput.value.trim();
      if (v && v !== gv.name) {
        gv.name = v;
        drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
        persistGroupRename(gv.id, v);
        scheduleGroupSave();
        updateGroupInfoPanel();
      }
    }
    document.body.appendChild(el);
    groupInfoPanel = el;
    return el;
  }
  function currentPanelGroup(): GroupVisual | null {
    const gids = SelectionStore.getGroups();
    if (gids.length !== 1) return null;
    const gv = groups.get(gids[0]) || null;
    return gv;
  }
  function updateGroupInfoPanel() {
    const panel = ensureGroupInfoPanel();
    const gv = currentPanelGroup();
    if (!gv) {
      panel.style.display = "none";
      return;
    }
    panel.style.display = "flex";
    // Ensure mutual exclusivity with card panel
    try {
      hideCardInfoPanel();
    } catch {}
    if (groupInfoNameInput) groupInfoNameInput.value = gv.name;
    // Update metrics grid
    const metrics = panel.querySelector(
      "#group-info-metrics",
    ) as HTMLDivElement | null;
    if (metrics) {
      metrics.innerHTML = "";
      const addRow = (k: string, v: string) => {
        const kEl = document.createElement("div");
        kEl.textContent = k;
        kEl.style.opacity = "0.65";
        const vEl = document.createElement("div");
        vEl.textContent = v;
        metrics.append(kEl, vEl);
      };
      updateGroupMetrics(gv, sprites);
      addRow("Cards", gv.items.size.toString());
      addRow("Price", `$${gv.totalPrice.toFixed(2)}`);
    }
  }
  function hideGroupInfoPanel() {
    if (groupInfoPanel) groupInfoPanel.style.display = "none";
  }

  // ---- Card Info Side Pane ----
  let cardInfoPanel: HTMLDivElement | null = null;
  function ensureCardInfoPanel() {
    if (cardInfoPanel) return cardInfoPanel;
    const el = document.createElement("div");
    cardInfoPanel = el;
    el.id = "card-info-panel";
    // Auto-height panel anchored to bottom-right; capped height; contents scroll if needed
    el.style.cssText =
      "position:fixed;right:14px;bottom:14px;width:560px;max-width:60vw;max-height:70vh;z-index:10015;display:flex;flex-direction:column;pointer-events:auto;font-size:16px;";
    el.className = "ui-panel";
    el.innerHTML =
      '<div id="cip-header" style="padding:12px 18px 8px;font-size:16px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--panel-accent);display:flex;align-items:center;gap:10px;">Card</div>' +
      '<div id="cip-scroll" style="overflow:auto;padding:0 18px 22px;display:flex;flex-direction:column;gap:18px;">' +
      '<div id="cip-empty" style="opacity:.55;padding:18px 6px;font-size:16px;">No card selected</div>' +
      '<div id="cip-content" style="display:none;flex-direction:column;gap:32px;">' +
      '<div id="cip-name" style="font-size:40px;font-weight:600;line-height:1.25;"></div>' +
      '<div id="cip-meta" style="display:flex;flex-direction:column;gap:12px;font-size:20px;line-height:1.6;opacity:.95;"></div>' +
      '<div id="cip-type" style="font-size:20px;opacity:.85;"></div>' +
      '<div id="cip-oracle" class="ui-input" style="white-space:pre-wrap;font-size:20px;line-height:1.75;padding:18px 20px;min-height:220px;"></div>' +
      "</div>" +
      "</div>";
    document.body.appendChild(el);
    return el;
  }
  function hideCardInfoPanel() {
    if (cardInfoPanel) cardInfoPanel.style.display = "none";
  }
  function showCardInfoPanel() {
    const el = ensureCardInfoPanel();
    el.style.display = "flex";
  }
  function updateCardInfoPanel() {
    const ids = SelectionStore.getCards();
    // Only show when exactly 1 card is selected (ignore when groups selected or multi-selection)
    if (ids.length !== 1) {
      hideCardInfoPanel();
      return;
    }
    const sprite = sprites.find((s) => s.__id === ids[0]);
    if (!sprite || !sprite.__card) {
      hideCardInfoPanel();
      return;
    }
    const card = sprite.__card;
    showCardInfoPanel();
    // Ensure mutual exclusivity with group panel
    try {
      hideGroupInfoPanel();
    } catch {}
    const panel = ensureCardInfoPanel();
    const empty = panel.querySelector("#cip-empty") as HTMLElement | null;
    const content = panel.querySelector("#cip-content") as HTMLElement | null;
    if (empty) empty.style.display = "none";
    if (content) content.style.display = "flex";
    const nameEl = panel.querySelector("#cip-name") as HTMLElement | null;
    if (nameEl) nameEl.textContent = card.name || "(Unnamed)"; // provisional; overwritten below
    const typeEl = panel.querySelector("#cip-type") as HTMLElement | null;
    const oracleEl = panel.querySelector("#cip-oracle") as HTMLElement | null;
    const faces: any[] = Array.isArray((card as any).card_faces)
      ? ((card as any).card_faces as any[])
      : [];
    const hasMultiFaces = faces.length >= 2;
    // If multi-face, hide the top-level name and show per-face names inside each section
    if (nameEl) nameEl.style.display = hasMultiFaces ? "none" : "block";
    // Prepare or locate a faces container
    let facesEl = panel.querySelector("#cip-faces") as HTMLElement | null;
    if (!facesEl) {
      facesEl = document.createElement("div");
      facesEl.id = "cip-faces";
      facesEl.style.display = "none";
      facesEl.style.flexDirection = "column";
      facesEl.style.gap = "12px";
      const contentWrap = panel.querySelector("#cip-content");
      if (contentWrap) contentWrap.appendChild(facesEl);
    }
    // Toggle single-face vs multi-face sections
    if (hasMultiFaces) {
      if (typeEl) typeEl.style.display = "none";
      if (oracleEl) oracleEl.style.display = "none";
      if (nameEl) nameEl.style.display = "none";
      if (facesEl) {
        facesEl.style.display = "flex";
        // Render two rows (one per face)
        facesEl.innerHTML = faces
          .slice(0, 2)
          .map((f) => {
            const fname = escapeHtml(f?.name || "");
            const ftype = escapeHtml(f?.type_line || "");
            let stats = "";
            if (f?.power !== undefined && f?.toughness !== undefined) {
              stats = ` ${escapeHtml(String(f.power))}/${escapeHtml(String(f.toughness))}`;
            } else if (f?.loyalty !== undefined) {
              stats = ` ${escapeHtml(String(f.loyalty))}`;
            } else if (f?.defense !== undefined) {
              stats = ` ${escapeHtml(String(f.defense))}`;
            }
            const cost = f?.mana_cost
              ? renderManaCostHTML(f.mana_cost, 26)
              : "";
            // Match single-face icon sizing for oracle text (24) and container font-size (20)
            const oracle = renderTextWithManaIcons(f?.oracle_text || "", 24);
            return (
              `<div class="cip-face-row" style="display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:10px;background:var(--panel-bg-alt);">` +
              `<div class="cip-face-head" style="display:flex;align-items:center;gap:10px;">` +
              `<div class="cip-face-name" style="font-weight:600;font-size:26px;">${fname}</div>` +
              (cost
                ? `<div class="cip-face-cost" style="display:flex;align-items:center;">${cost}</div>`
                : "") +
              `</div>` +
              `<div class="cip-face-type" style="font-size:20px;opacity:.9;">${ftype}${stats}</div>` +
              `<div class="cip-face-oracle ui-input" style="white-space:pre-wrap;font-size:20px;line-height:1.75;padding:18px 20px;">${oracle}</div>` +
              `</div>`
            );
          })
          .join("");
      }
    } else {
      // Single-face: show name and render cost inline next to it for higher density
      if (nameEl) {
        nameEl.style.display = "block";
        const nm = escapeHtml(card.name || "(Unnamed)");
        const costHtml = card.mana_cost
          ? `<span class="cip-name-cost" style="margin-left:10px;display:inline-flex;align-items:center;">${renderManaCostHTML(card.mana_cost, 26)}</span>`
          : "";
        nameEl.innerHTML = nm + costHtml;
      }
      if (facesEl) {
        facesEl.style.display = "none";
        facesEl.innerHTML = "";
      }
      if (typeEl) typeEl.style.display = "block";
      if (oracleEl) oracleEl.style.display = "block";
      if (typeEl) typeEl.textContent = card.type_line || "";
      if (oracleEl)
        oracleEl.innerHTML = renderTextWithManaIcons(
          card.oracle_text || "",
          24,
        );
    }
    const metaEl = panel.querySelector("#cip-meta") as HTMLElement | null;
    if (metaEl) {
      const rows: string[] = [];
      // Cost now rendered inline with the name for single-face cards; multi-face handled per-face above.
      // Price (USD or USD Foil)
      const price = getCardPriceUSD(card);
      if (price)
        rows.push(
          `<div><span style="font-weight:600;">Price:</span> $${price}</div>`,
        );
      // CMC
      if (card.cmc !== undefined)
        rows.push(
          `<div><span style="font-weight:600;">CMC:</span> ${card.cmc}</div>`,
        );
      // P/T shown per-face when multi-faced; keep only for single-face
      if (
        !hasMultiFaces &&
        card.power !== undefined &&
        card.toughness !== undefined
      )
        rows.push(
          `<div><span style="font-weight:600;">P/T:</span> ${card.power}/${card.toughness}</div>`,
        );
      // Color identity as icons
      if (Array.isArray(card.color_identity) && card.color_identity.length)
        rows.push(
          `<div style="display:flex;align-items:center;gap:6px;"><span style="font-weight:600;">Color Identity:</span> ${renderColorIdentityIcons(card.color_identity, 26)}</div>`,
        );
      // Rarity
      if (card.rarity)
        rows.push(
          `<div><span style="font-weight:600;">Rarity:</span> ${escapeHtml(card.rarity)}</div>`,
        );
      // Set icon + full name + abbrev
      if (card.set) {
        const setCode = String(card.set).toLowerCase();
        const setName = escapeHtml(card.set_name || "");
        const setImg = `<img class="cip-set-icon" src="https://svgs.scryfall.io/sets/${setCode}.svg" alt="${setCode.toUpperCase()}" style="width:38px;height:38px;vertical-align:-9px;margin-right:12px;"/>`;
        const label = setName
          ? `${setName} (${setCode.toUpperCase()})`
          : setCode.toUpperCase();
        rows.push(
          `<div><span style="font-weight:600;">Set:</span> ${setImg}${label}</div>`,
        );
      }
      // Language
      if (card.lang && card.lang !== "en")
        rows.push(
          `<div><span style="font-weight:600;">Lang:</span> ${escapeHtml(card.lang)}</div>`,
        );
      metaEl.innerHTML = rows.join("");
      try {
        attachManaIconFallbacks(metaEl);
        const oracle = panel.querySelector("#cip-oracle") as HTMLElement | null;
        if (oracle) attachManaIconFallbacks(oracle);
        const faces = panel.querySelector("#cip-faces") as HTMLElement | null;
        if (faces) attachManaIconFallbacks(faces);
      } catch {}
    }
    // Image: use existing sprite texture (copy into a canvas for crispness) if loaded; else trigger ensureCardImage then copy later
    // Image removed per user request.
  }
  function escapeHtml(s: string) {
    return s.replace(
      /[&<>"']/g,
      (c) =>
        (
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          }) as any
        )[c] || c,
    );
  }

  // --- Scryfall Symbology mapping (optional, to guarantee exact URIs) ---
  let __symbologyMap: Record<string, { svg_uri: string; english?: string }> =
    {};
  let __symbologyLoaded = false;
  let __symbologyLoading = false;
  async function ensureSymbologyLoaded() {
    if (__symbologyLoaded || __symbologyLoading) return;
    __symbologyLoading = true;
    try {
      const res = await fetch("https://api.scryfall.com/symbology");
      if (res.ok) {
        const json = await res.json();
        if (json && Array.isArray(json.data)) {
          const m: Record<string, { svg_uri: string; english?: string }> = {};
          json.data.forEach((cs: any) => {
            const key =
              typeof cs.symbol === "string"
                ? String(cs.symbol).toUpperCase()
                : "";
            if (key && cs.svg_uri)
              m[key] = { svg_uri: String(cs.svg_uri), english: cs.english };
          });
          __symbologyMap = m;
          __symbologyLoaded = true;
          // Repaint info panels to replace any text placeholders once symbols are known
          try {
            updateCardInfoPanel();
          } catch {}
        }
      }
    } catch {
    } finally {
      __symbologyLoading = false;
    }
  }
  function symbolSvgFromMap(rawToken: string): string | null {
    const upper = rawToken.trim().toUpperCase();
    const key = upper.startsWith("{") ? upper : `{${upper}}`;
    return __symbologyMap[key]?.svg_uri || null;
  }
  function filenameCodeFromRaw(rawToken: string): string {
    // Return the Scryfall filename code (uppercase, order preserved, slashes removed)
    let t = rawToken.trim().toUpperCase();
    if (t.startsWith("{") && t.endsWith("}")) t = t.slice(1, -1);
    // Common direct forms
    if (/^[0-9]+$/.test(t)) return t; // numeric
    if (
      [
        "X",
        "Y",
        "Z",
        "W",
        "U",
        "B",
        "R",
        "G",
        "C",
        "S",
        "L",
        "E",
        "D",
        "P",
        "T",
        "Q",
        "PW",
        "CHAOS",
        "TK",
        "A",
        "HALF",
        "INFINITY",
      ].includes(t)
    )
      return t;
    if (t.includes("/")) return t.replaceAll("/", ""); // e.g., W/U -> WU, 2/W -> 2W, G/U/P -> GUP
    return t; // default
  }
  function chooseSymbolUrl(rawToken: string): { src: string; code: string } {
    // Prefer exact URI from symbology when available; otherwise derive filename code.
    const fromMap = symbolSvgFromMap(rawToken);
    if (fromMap) {
      // Derive a plausible code for host by stripping path
      const m = fromMap.match(/\/card-symbols\/([^./]+)\.svg/i);
      const code = m ? m[1] : filenameCodeFromRaw(rawToken);
      return { src: fromMap, code };
    }
    const code = filenameCodeFromRaw(rawToken);
    return {
      src: `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(code)}.svg`,
      code,
    };
  }
  // Render mana cost like "{1}{U}{U}" into inline SVG icons from Scryfall.
  function renderManaCostHTML(cost: string, size: number = 22): string {
    // Begin background load of symbology in case we need exact mappings
    try {
      ensureSymbologyLoaded();
    } catch {}
    const out: string[] = [];
    const re = /\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cost))) {
      const raw = m[1];
      const { src, code } = chooseSymbolUrl(raw);
      out.push(
        `<img class="mana-icon" data-code="${encodeURIComponent(code)}" src="${src}" alt="{${escapeHtml(raw)}}" title="{${escapeHtml(raw)}}" style="width:${size}px;height:${size}px;vertical-align:-7px;margin:0 1px;" loading="lazy" decoding="async"/>`,
      );
    }
    if (!out.length) return escapeHtml(cost);
    return out.join("");
  }
  // Render any text with embedded mana symbols like "Tap: {T}: Add {G}{G}" into HTML with icons, preserving newlines as <br>.
  function renderTextWithManaIcons(text: string, size: number = 22): string {
    try {
      ensureSymbologyLoaded();
    } catch {}
    if (!text) return "";
    const re = /\{([^}]+)\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    const out: string[] = [];
    while ((m = re.exec(text))) {
      const before = text.slice(last, m.index);
      if (before) out.push(escapeHtml(before).replace(/\n/g, "<br/>"));
      const raw = m[1];
      const { src, code } = chooseSymbolUrl(raw);
      out.push(
        `<img class="mana-icon" data-code="${encodeURIComponent(code)}" src="${src}" alt="{${escapeHtml(raw)}}" title="{${escapeHtml(raw)}}" style="width:${size}px;height:${size}px;vertical-align:-7px;margin:0 1px;" loading="lazy" decoding="async"/>`,
      );
      last = re.lastIndex;
    }
    const tail = text.slice(last);
    if (tail) out.push(escapeHtml(tail).replace(/\n/g, "<br/>"));
    return out.join("");
  }
  function attachManaIconFallbacks(scope: HTMLElement) {
    const imgs = scope.querySelectorAll("img.mana-icon");
    imgs.forEach((img) => {
      const el = img as HTMLImageElement;
      // happy path: do nothing if it loads
      el.onerror = () => {
        const code = el.getAttribute("data-code") || "";
        const alt = `https://c2.scryfall.com/file/scryfall-symbols/card-symbols/${code}.svg`;
        if (el.src !== alt) {
          el.src = alt;
          el.onerror = () => {
            // final: readable text token (no custom icons)
            try {
              el.outerHTML = `<span style="display:inline-block;min-width:22px;text-align:center;font-weight:700;">{${code}}</span>`;
            } catch {}
          };
        }
      };
    });
  }
  function renderColorIdentityIcons(ci: string[], size: number = 22): string {
    const order = ["W", "U", "B", "R", "G"];
    const sorted = ci
      .slice()
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return sorted
      .map((sym) => {
        const raw = sym.toUpperCase();
        const { src, code } = chooseSymbolUrl(raw);
        return `<img class="mana-icon" data-code="${encodeURIComponent(code)}" src="${src}" alt="{${escapeHtml(sym)}}" title="${escapeHtml(sym)}" style="width:${size}px;height:${size}px;vertical-align:-7px;margin:0 1px;opacity:.97;" loading="lazy" decoding="async"/>`;
      })
      .join("");
  }
  // canonicalManaCode replaced with filenameCodeFromRaw + chooseSymbolUrl
  function getCardPriceUSD(card: any): string | null {
    const p = card?.prices || {};
    const usd = p.usd && !isNaN(parseFloat(p.usd)) ? parseFloat(p.usd) : null;
    const usdFoil =
      p.usd_foil && !isNaN(parseFloat(p.usd_foil))
        ? parseFloat(p.usd_foil)
        : null;
    const val = usd ?? usdFoil;
    return val != null ? val.toFixed(2) : null;
  }
  SelectionStore.on(() => {
    updateGroupInfoPanel();
    updateCardInfoPanel();
  });

  // --- Bounds helpers ---
  function getCanvasBounds() {
    const ha: any = app.stage.hitArea as any;
    return ha && typeof ha.x === "number"
      ? {
          x: ha.x as number,
          y: ha.y as number,
          w: ha.width as number,
          h: ha.height as number,
        }
      : { x: -25000, y: -25000, w: 50000, h: 50000 };
  }
  function clampGroupXY(gv: GroupVisual, x: number, y: number) {
    const b = getCanvasBounds();
    const minX = b.x;
    const minY = b.y;
    const maxX = b.x + b.w - gv.w;
    const maxY = b.y + b.h - gv.h;
    return {
      x: Math.min(maxX, Math.max(minX, x)),
      y: Math.min(maxY, Math.max(minY, y)),
    };
  }
  function clampDeltaForGroup(gv: GroupVisual, ddx: number, ddy: number) {
    const b = getCanvasBounds();
    const minDx = b.x - gv.gfx.x;
    const maxDx = b.x + b.w - (gv.gfx.x + gv.w);
    const minDy = b.y - gv.gfx.y;
    const maxDy = b.y + b.h - (gv.gfx.y + gv.h);
    return {
      dx: Math.min(maxDx, Math.max(minDx, ddx)),
      dy: Math.min(maxDy, Math.max(minDy, ddy)),
    };
  }
  function clampDeltaForMultipleGroups(
    primary: GroupVisual,
    ddx: number,
    ddy: number,
    otherIds: Set<number>,
  ) {
    // Instead compute min/max range from bounds for each group
    const b = getCanvasBounds();
    let allowMinDx = b.x - primary.gfx.x;
    let allowMaxDx = b.x + b.w - (primary.gfx.x + primary.w);
    let allowMinDy = b.y - primary.gfx.y;
    let allowMaxDy = b.y + b.h - (primary.gfx.y + primary.h);
    otherIds.forEach((id) => {
      const og = groups.get(id);
      if (!og) return;
      allowMinDx = Math.max(allowMinDx, b.x - og.gfx.x);
      allowMaxDx = Math.min(allowMaxDx, b.x + b.w - (og.gfx.x + og.w));
      allowMinDy = Math.max(allowMinDy, b.y - og.gfx.y);
      allowMaxDy = Math.min(allowMaxDy, b.y + b.h - (og.gfx.y + og.h));
    });
    const cdx = Math.min(allowMaxDx, Math.max(allowMinDx, ddx));
    const cdy = Math.min(allowMaxDy, Math.max(allowMinDy, ddy));
    return { dx: cdx, dy: cdy };
  }

  function attachResizeHandle(gv: GroupVisual) {
    const r = gv.resize;
    let resizing = false;
    let startW = 0;
    let startH = 0;
    let anchorX = 0;
    let anchorY = 0;
    let startX = 0;
    let startY = 0;
    let resizeMode: "" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" = "";
    const MIN_W = 160;
    const MIN_H = HEADER_HEIGHT + 80;
    const EDGE_PX = 16; // edge handle thickness in screen pixels

    // Debug overlay to visualize interactive edge bands (screen-relative)
    if ((window as any).__debugResizeTargets === undefined)
      (window as any).__debugResizeTargets = false; // default OFF
    function ensureDebugG() {
      let dbg: PIXI.Graphics = (gv.gfx as any).__resizeDbg;
      if (!dbg) {
        dbg = new PIXI.Graphics();
        (gv.gfx as any).__resizeDbg = dbg;
        dbg.eventMode = "none";
        dbg.zIndex = 999999;
        gv.gfx.addChild(dbg);
      }
      return dbg;
    }
    function updateResizeDebug() {
      const enabled = !!(window as any).__debugResizeTargets;
      const dbg = ensureDebugG();
      dbg.visible = enabled;
      if (!enabled) {
        dbg.clear();
        return;
      }
      const edgeWorld = EDGE_PX / (world.scale.x || 1);
      dbg.clear();
      // Top (blue)
      dbg
        .rect(0, 0, gv.w, edgeWorld)
        .fill({ color: Colors.debugBlue(), alpha: 0.25 });
      // Bottom (blue)
      dbg
        .rect(0, gv.h - edgeWorld, gv.w, edgeWorld)
        .fill({ color: Colors.debugBlue(), alpha: 0.25 });
      // Left (green)
      dbg
        .rect(0, 0, edgeWorld, gv.h)
        .fill({ color: Colors.debugGreen(), alpha: 0.25 });
      // Right (green)
      dbg
        .rect(gv.w - edgeWorld, 0, edgeWorld, gv.h)
        .fill({ color: Colors.debugGreen(), alpha: 0.25 });
      // Corners (red) overdraw so they stand out
      dbg
        .rect(0, 0, edgeWorld, edgeWorld)
        .fill({ color: Colors.debugRed(), alpha: 0.35 }); // NW
      dbg
        .rect(gv.w - edgeWorld, 0, edgeWorld, edgeWorld)
        .fill({ color: Colors.debugRed(), alpha: 0.35 }); // NE
      dbg
        .rect(0, gv.h - edgeWorld, edgeWorld, edgeWorld)
        .fill({ color: Colors.debugRed(), alpha: 0.35 }); // SW
      dbg
        .rect(gv.w - edgeWorld, gv.h - edgeWorld, edgeWorld, edgeWorld)
        .fill({ color: Colors.debugRed(), alpha: 0.35 }); // SE
    }

    function modeFromPoint(
      localX: number,
      localY: number,
      edgeWorld: number,
    ): typeof resizeMode {
      const w = gv.w,
        h = gv.h;
      const left = localX <= edgeWorld;
      const right = localX >= w - edgeWorld;
      const top = localY <= edgeWorld;
      const bottom = localY >= h - edgeWorld;
      if (top && left) return "nw";
      if (top && right) return "ne";
      if (bottom && left) return "sw";
      if (bottom && right) return "se";
      if (top) return "n";
      if (bottom) return "s";
      if (left) return "w";
      if (right) return "e";
      return "";
    }
    function cursorFor(mode: typeof resizeMode) {
      switch (mode) {
        case "n":
        case "s":
          return "ns-resize";
        case "e":
        case "w":
          return "ew-resize";
        case "ne":
        case "sw":
          return "nesw-resize";
        case "nw":
        case "se":
          return "nwse-resize";
        default:
          return "default";
      }
    }

    // Existing bottom-right triangle -> always se resize
    r.on("pointerdown", (e) => {
      if (gv.collapsed) return;
      e.stopPropagation();
      const local = world.toLocal(e.global);
      resizing = true;
      resizeMode = "se";
      startW = gv.w;
      startH = gv.h;
      startX = gv.gfx.x;
      startY = gv.gfx.y;
      anchorX = local.x;
      anchorY = local.y;
    });

    // Edge / corner resize via frame body
    gv.frame.on("pointermove", (e: any) => {
      if (resizing || gv.collapsed) return;
      const local = world.toLocal(e.global);
      const lx = local.x - gv.gfx.x;
      const ly = local.y - gv.gfx.y;
      const edgeWorld = EDGE_PX / (world.scale.x || 1);
      const mode = modeFromPoint(lx, ly, edgeWorld);
      gv.frame.cursor = cursorFor(mode);
      updateResizeDebug();
    });
    gv.frame.on("pointerout", () => {
      if (!resizing && gv.frame.cursor !== "default")
        gv.frame.cursor = "default";
    });
    gv.frame.on("pointerdown", (e: any) => {
      if (gv.collapsed) return;
      if (e.button !== 0) return; // only left button
      const local = world.toLocal(e.global);
      const lx = local.x - gv.gfx.x;
      const ly = local.y - gv.gfx.y;
      const edgeWorld = EDGE_PX / (world.scale.x || 1);
      const mode = modeFromPoint(lx, ly, edgeWorld);
      if (!mode) return; // not on edge -> allow other handlers (drag / marquee)
      e.stopPropagation();
      resizing = true;
      resizeMode = mode;
      startW = gv.w;
      startH = gv.h;
      startX = gv.gfx.x;
      startY = gv.gfx.y;
      anchorX = local.x;
      anchorY = local.y;
      updateResizeDebug();
    });

    // Header resize support for top/left/right edges (screen-relative thickness)
    gv.header.on("pointermove", (e: any) => {
      if (resizing || gv.collapsed) return;
      const local = world.toLocal(e.global);
      const lx = local.x - gv.gfx.x;
      const ly = local.y - gv.gfx.y;
      const edgeWorld = EDGE_PX / (world.scale.x || 1);
      const w = gv.w;
      const left = lx <= edgeWorld;
      const right = lx >= w - edgeWorld;
      const top = ly <= edgeWorld;
      let mode: typeof resizeMode = "";
      if (top && left) mode = "nw";
      else if (top && right) mode = "ne";
      else if (left) mode = "w";
      else if (right) mode = "e";
      else if (top) mode = "n";
      gv.header.cursor = cursorFor(mode) || "move";
      updateResizeDebug();
    });
    gv.header.on("pointerout", () => {
      if (!resizing) gv.header.cursor = "move";
    });
    gv.header.on("pointerdown", (e: any) => {
      if (gv.collapsed) return;
      if (e.button !== 0) return; // left only
      const local = world.toLocal(e.global);
      const lx = local.x - gv.gfx.x;
      const ly = local.y - gv.gfx.y;
      const edgeWorld = EDGE_PX / (world.scale.x || 1);
      const w = gv.w;
      const left = lx <= edgeWorld;
      const right = lx >= w - edgeWorld;
      const top = ly <= edgeWorld;
      let mode: typeof resizeMode = "";
      if (top && left) mode = "nw";
      else if (top && right) mode = "ne";
      else if (left) mode = "w";
      else if (right) mode = "e";
      else if (top) mode = "n";
      if (!mode) return; // not near top edge -> let normal drag logic run
      e.stopPropagation(); // prevent header drag
      resizing = true;
      resizeMode = mode;
      startW = gv.w;
      startH = gv.h;
      startX = gv.gfx.x;
      startY = gv.gfx.y;
      anchorX = local.x;
      anchorY = local.y;
      updateResizeDebug();
    });

    app.stage.on("pointermove", (e) => {
      if (!resizing) return;
      const local = world.toLocal(e.global);
      const dx = local.x - anchorX;
      const dy = local.y - anchorY;
      const rightEdge = startX + startW;
      const bottomEdge = startY + startH;
      let newW = startW;
      let newH = startH;
      let newX = startX;
      let newY = startY;
      // Horizontal adjustments
      if (resizeMode.includes("e")) {
        newW = startW + dx;
      }
      if (resizeMode.includes("w")) {
        newW = startW - dx; /* keep right edge fixed */
      }
      // Vertical adjustments
      if (resizeMode.includes("s")) {
        newH = startH + dy;
      }
      if (resizeMode.includes("n")) {
        newH = startH - dy;
      }
      // Clamp & snap
      if (resizeMode.includes("w")) {
        newW = Math.max(MIN_W, newW);
        newW = snap(newW);
        newX = rightEdge - newW;
      } else if (resizeMode.includes("e")) {
        newW = Math.max(MIN_W, newW);
        newW = snap(newW);
      }
      if (resizeMode.includes("n")) {
        newH = Math.max(MIN_H, newH);
        newH = snap(newH);
        newY = bottomEdge - newH;
      } else if (resizeMode.includes("s")) {
        newH = Math.max(MIN_H, newH);
        newH = snap(newH);
      }
      // Clamp group rect to canvas bounds so it cannot be resized out of bounds
      const clampedPos = clampGroupXY(gv, newX, newY);
      // Further clamp width/height so right/bottom stay within bounds
      const b = getCanvasBounds();
      const maxW = Math.max(MIN_W, Math.floor(b.x + b.w - clampedPos.x));
      const maxH = Math.max(MIN_H, Math.floor(b.y + b.h - clampedPos.y));
      newW = Math.min(newW, maxW);
      newH = Math.min(newH, maxH);
      // Apply
      gv.w = newW;
      gv.h = newH;
      gv.gfx.x = clampedPos.x;
      gv.gfx.y = clampedPos.y;
      gv._expandedH = gv.h;
      drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
      updateGroupMetrics(gv, sprites);
      updateResizeDebug();
    });
    const endResize = () => {
      if (resizing) {
        resizing = false;
        resizeMode = "";
        gv.frame.cursor = "default";
      }
    };
    app.stage.on("pointerup", endResize);
    app.stage.on("pointerupoutside", endResize);
    // Initial draw
    updateResizeDebug();
  }

  function attachGroupInteractions(gv: GroupVisual) {
    let drag = false;
    let dx = 0;
    let dy = 0;
    const g = gv.gfx;
    let memberOffsets: { sprite: CardSprite; ox: number; oy: number }[] = [];
    // Temporary z-order raising while dragging a group using a dynamic baseline
    const prevGroupZ = new Map<number, number>(); // groupId -> original z (pre-drag)
    const prevCardZ = new Map<number, number>(); // cardId -> original z (pre-drag)
    function beginGroupDragZRaise(primary: GroupVisual) {
      // Persistently bring to front: primary + selected groups
      const dragging = new Set(SelectionStore.getGroups());
      dragging.add(primary.id);
      bringGroupsToFrontPersistent([...dragging]);
    }
    function endGroupDragZRestore() {
      // No-op: we persistently raised on pointerdown
      prevGroupZ.clear();
      prevCardZ.clear();
    }
    gv.header.eventMode = "static";
    gv.header.cursor = "move";
    gv.header.on("pointerdown", (e: any) => {
      e.stopPropagation();
      if (e.button === 2) return; // right-click handled separately
      // If near resize edges, do not start drag (resize handler will take over)
      try {
        const local = world.toLocal(e.global);
        const lx = local.x - gv.gfx.x;
        const ly = local.y - gv.gfx.y;
        const edgeWorld = 16 / (world.scale.x || 1);
        const w = gv.w;
        const nearLeft = lx <= edgeWorld;
        const nearRight = lx >= w - edgeWorld;
        const nearTop = ly <= edgeWorld;
        if (nearLeft || nearRight || nearTop) return; // let resize path handle
      } catch {}
      if (!e.shiftKey && !SelectionStore.state.groupIds.has(gv.id))
        SelectionStore.selectOnlyGroup(gv.id);
      else if (e.shiftKey) SelectionStore.toggleGroup(gv.id);
      // Persistently bring to front on click/drag start
      const dragging = new Set(SelectionStore.getGroups());
      dragging.add(gv.id);
      bringGroupsToFrontPersistent([...dragging]);
      const local = world.toLocal(e.global);
      drag = true;
      dx = local.x - g.x;
      dy = local.y - g.y;
      beginGroupDragZRaise(gv);
      memberOffsets = [...gv.items]
        .map((id) => {
          const s = sprites.find((sp) => sp.__id === id);
          return s ? { sprite: s, ox: s.x - g.x, oy: s.y - g.y } : null;
        })
        .filter(Boolean) as any;
    });
    gv.header.on("pointertap", (e: any) => {
      if (e.detail === 2 && e.button !== 2) startGroupRename(gv);
    });
    // Overlay drag surface (when zoomed out). Acts like header.
    if ((gv as any)._overlayDrag) {
      const ds: any = (gv as any)._overlayDrag;
      ds.on("pointerdown", (e: any) => {
        if (e.button !== 0) return;
        if (!ds.visible) return;
        e.stopPropagation();
        if (!SelectionStore.state.groupIds.has(gv.id))
          SelectionStore.selectOnlyGroup(gv.id);
        // Persistently bring to front on click/drag start
        const dragging = new Set(SelectionStore.getGroups());
        dragging.add(gv.id);
        bringGroupsToFrontPersistent([...dragging]);
        const local = world.toLocal(e.global);
        drag = true;
        dx = local.x - g.x;
        dy = local.y - g.y;
        beginGroupDragZRaise(gv);
        memberOffsets = [...gv.items]
          .map((id) => {
            const s = sprites.find((sp) => sp.__id === id);
            return s ? { sprite: s, ox: s.x - g.x, oy: s.y - g.y } : null;
          })
          .filter(Boolean) as any;
      });
    }
    // When zoom overlay active (cards hidden / faded) allow dragging from the whole body area.
    // Reuse same drag logic; only trigger if overlay phase recently > 0 (tracked via _lastZoomPhase).
    gv.frame.cursor = "default";
    gv.frame.eventMode = "static";
    gv.frame.on("pointerdown", (e: any) => {
      if (e.button !== 0) return;
      // Only consider using the frame as a drag surface if overlay is active AND there's no dedicated drag surface.
      if (!gv._lastZoomPhase || gv._lastZoomPhase < 0.05) return; // overlay not active enough
      if ((gv as any)._overlayDrag) return; // defer to overlay drag surface to avoid conflicts with resize
      // Fallback: avoid starting drag when near edges so resize can take precedence
      try {
        const local = world.toLocal(e.global);
        const lx = local.x - gv.gfx.x;
        const ly = local.y - gv.gfx.y;
        const edgeWorld = 16 / (world.scale.x || 1);
        const w = gv.w;
        const nearEdge =
          lx <= edgeWorld ||
          lx >= w - edgeWorld ||
          ly <= edgeWorld ||
          ly >= gv.h - edgeWorld;
        if (nearEdge) return; // let resize path handle
      } catch {}
      // Avoid starting drag when clicking resize triangle
      const hit = e.target;
      if (hit === gv.resize) return;
      e.stopPropagation();
      if (!SelectionStore.state.groupIds.has(gv.id))
        SelectionStore.selectOnlyGroup(gv.id);
      // Persistently bring to front on click/drag start
      const dragging = new Set(SelectionStore.getGroups());
      dragging.add(gv.id);
      bringGroupsToFrontPersistent([...dragging]);
      const local = world.toLocal(e.global);
      drag = true;
      dx = local.x - g.x;
      dy = local.y - g.y;
      beginGroupDragZRaise(gv);
      memberOffsets = [...gv.items]
        .map((id) => {
          const s = sprites.find((sp) => sp.__id === id);
          return s ? { sprite: s, ox: s.x - g.x, oy: s.y - g.y } : null;
        })
        .filter(Boolean) as any;
    });
    // Click body (non-overlay zoom): select group without starting a drag
    gv.frame.on("pointertap", (e: any) => {
      if (e.button === 2) return; // ignore right-click here
      // If overlay active, drag handler above already selected the group
      if (gv._lastZoomPhase && gv._lastZoomPhase > 0.05) return;
      // Do not handle if click targets the resize handle
      if (e.target === gv.resize) return;
      // Select/toggle group on simple click in body area
      if (!e.shiftKey && !SelectionStore.state.groupIds.has(gv.id))
        SelectionStore.selectOnlyGroup(gv.id);
      else if (e.shiftKey) SelectionStore.toggleGroup(gv.id);
      e.stopPropagation();
    });
    // Context menu (right-click)
    // Show context menu only if no significant right-drag (panning) occurred.
    gv.header.on("rightclick", (e: any) => {
      e.stopPropagation();
      if (rightPanning) return; // if we dragged, skip menu
      showGroupContextMenu(gv, e.global);
    });
    // Group body interactions handled globally like canvas now.
    app.stage.on("pointermove", (e) => {
      if (!drag) return;
      const local = world.toLocal(e.global);
      let nx = local.x - dx;
      let ny = local.y - dy;
      // Compute clamped delta allowed for the primary group
      let ddx = nx - g.x;
      let ddy = ny - g.y;
      const selected = new Set(SelectionStore.getGroups());
      selected.delete(gv.id);
      if (selected.size) {
        const c = clampDeltaForMultipleGroups(gv, ddx, ddy, selected);
        ddx = c.dx;
        ddy = c.dy;
      } else {
        const c = clampDeltaForGroup(gv, ddx, ddy);
        ddx = c.dx;
        ddy = c.dy;
      }
      nx = g.x + ddx;
      ny = g.y + ddy;
      g.x = nx;
      g.y = ny;
      memberOffsets.forEach((m) => {
        m.sprite.x = g.x + m.ox;
        m.sprite.y = g.y + m.oy;
      });
      // If multiple groups are selected, move them in lockstep (already clamped above)
      if (selected.size) {
        selected.forEach((id) => {
          const og = groups.get(id);
          if (!og) return;
          og.gfx.x += ddx;
          og.gfx.y += ddy; // shift member cards
          [...og.items].forEach((cid) => {
            const s = sprites.find((sp) => sp.__id === cid);
            if (s) {
              s.x += ddx;
              s.y += ddy;
            }
          });
        });
      }
    });
    const endGroupDrag = () => {
      if (!drag) return;
      drag = false;
      endGroupDragZRestore();
      // Snap and re-clamp to bounds the primary group
      const p = clampGroupXY(gv, snap(g.x), snap(g.y));
      g.x = p.x;
      g.y = p.y;
      memberOffsets.forEach((m) => {
        m.sprite.x = snap(m.sprite.x);
        m.sprite.y = snap(m.sprite.y);
        spatial.update({
          id: m.sprite.__id,
          minX: m.sprite.x,
          minY: m.sprite.y,
          maxX: m.sprite.x + CARD_W_GLOBAL,
          maxY: m.sprite.y + CARD_H_GLOBAL,
        });
      });
      persistGroupTransform(gv.id, { x: g.x, y: g.y, w: gv.w, h: gv.h });

      // Snap and re-clamp any other selected groups moved in lockstep
      const selected = new Set(SelectionStore.getGroups());
      selected.delete(gv.id);
      if (selected.size) {
        selected.forEach((id) => {
          const og = groups.get(id);
          if (!og) return;
          const p2 = clampGroupXY(og, snap(og.gfx.x), snap(og.gfx.y));
          og.gfx.x = p2.x;
          og.gfx.y = p2.y;
          [...og.items].forEach((cid) => {
            const s = sprites.find((sp) => sp.__id === cid);
            if (s) {
              s.x = snap(s.x);
              s.y = snap(s.y);
              spatial.update({
                id: s.__id,
                minX: s.x,
                minY: s.y,
                maxX: s.x + CARD_W_GLOBAL,
                maxY: s.y + CARD_H_GLOBAL,
              });
            }
          });
          persistGroupTransform(og.id, {
            x: og.gfx.x,
            y: og.gfx.y,
            w: og.w,
            h: og.h,
          });
        });
      }
      scheduleGroupSave();
    };
    app.stage.on("pointerup", endGroupDrag);
    app.stage.on("pointerupoutside", endGroupDrag);
  }

  // ---- Group context menu (Groups V2) ----
  let groupMenu: HTMLDivElement | null = null;
  function ensureGroupMenu() {
    if (groupMenu) return groupMenu;
    const el = document.createElement("div");
    groupMenu = el;
    el.style.cssText = "position:fixed;z-index:10001;min-width:200px;";
    el.className = "ui-menu";
    // Prevent both mouse and pointer events from bubbling (so global pointerdown doesn't instantly hide menu)
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    document.body.appendChild(el);
    return el;
  }
  function hideGroupMenu() {
    if (groupMenu) {
      groupMenu.style.display = "none";
    }
  }
  window.addEventListener("pointerdown", (e) => {
    const tgt = e.target as Node | null;
    if (groupMenu && tgt && groupMenu.contains(tgt)) return; // inside menu
    hideGroupMenu();
  });
  function showGroupContextMenu(gv: GroupVisual, globalPt: PIXI.Point) {
    const el = ensureGroupMenu();
    el.innerHTML = "";
    function addItem(label: string, action: () => void) {
      const it = document.createElement("div");
      it.textContent = label;
      it.className = "ui-menu-item";
      it.onclick = () => {
        action();
        hideGroupMenu();
      };
      el.appendChild(it);
    }
    // Collapse feature removed
    addItem("Auto-pack", () => {
      autoPackGroup(gv, sprites, (s) =>
        spatial.update({
          id: s.__id,
          minX: s.x,
          minY: s.y,
          maxX: s.x + 100,
          maxY: s.y + 140,
        }),
      );
      updateGroupMetrics(gv, sprites);
      drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
      scheduleGroupSave();
    });
    // Layout submenu removed (group sections/faceted layout no longer supported)
    addItem("Rename", () => startGroupRename(gv));
    // Recolor removed; theme-driven
    addItem("Delete", () => {
      deleteGroupById(gv.id);
      SelectionStore.clear();
      scheduleGroupSave();
    });
    // Palette removed
    const bounds = app.renderer.canvas.getBoundingClientRect();
    el.style.left = `${bounds.left + globalPt.x + 4}px`;
    el.style.top = `${bounds.top + globalPt.y + 4}px`;
    el.style.display = "block";
  }

  // ---- Card context menu (Add to open group) ----
  let cardMenu: HTMLDivElement | null = null;
  function ensureCardMenu() {
    if (cardMenu) return cardMenu;
    const el = document.createElement("div");
    cardMenu = el;
    el.style.cssText = "position:fixed;z-index:10001;min-width:220px;";
    el.className = "ui-menu";
    el.addEventListener("mousedown", (ev) => ev.stopPropagation());
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    document.body.appendChild(el);
    return el;
  }
  function hideCardMenu() {
    if (cardMenu) {
      cardMenu.style.display = "none";
    }
  }
  window.addEventListener("pointerdown", (e) => {
    const tgt = e.target as Node | null;
    if (cardMenu && tgt && cardMenu.contains(tgt)) return;
    hideCardMenu();
  });
  function showCardContextMenu(card: CardSprite, globalPt: PIXI.Point) {
    const el = ensureCardMenu();
    el.innerHTML = "";
    const header = document.createElement("div");
    header.textContent = "Add to Group";
    header.style.cssText =
      "font-size:22px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;opacity:.7;padding:4px 6px 10px;";
    el.appendChild(header);
    // All groups considered open (collapse removed)
    const openGroups = [...groups.values()];
    function addItem(label: string, action: () => void, disabled = false) {
      const it = document.createElement("div");
      it.textContent = label;
      it.className = "ui-menu-item";
      it.style.display = "flex";
      it.style.alignItems = "center";
      it.style.gap = "6px";
      if (disabled) {
        it.classList.add("disabled");
      } else {
        it.onclick = () => {
          action();
          hideCardMenu();
        };
      }
      el.appendChild(it);
      return it;
    }
    if (!openGroups.length) {
      addItem("(No open groups)", () => {}, true);
    } else {
      openGroups
        .sort((a, b) => a.id - b.id)
        .forEach((gv) => {
          const already = !!card.__groupId && card.__groupId === gv.id;
          const it = addItem(gv.name || `Group ${gv.id}`, () => {
            if (already) return; // no-op
            // Remove from previous group if any
            if (card.__groupId) {
              const old = groups.get(card.__groupId);
              if (old) {
                removeCardFromGroup(old, card.__id);
                updateGroupMetrics(old, sprites);
                drawGroup(old, SelectionStore.state.groupIds.has(old.id));
              }
              // Ensure sprite reappears if group overlay had hidden it
              (card as any).__groupOverlayActive = false;
              (card as any).eventMode = "static";
              card.cursor = "pointer";
              card.alpha = 1;
              card.visible = true;
              card.renderable = true;
              updateCardSpriteAppearance(
                card,
                SelectionStore.state.cardIds.has(card.__id),
              );
            }
            console.log("[cardMenu] add card", card.__id, "to group", gv.id);
            addCardToGroupOrdered(gv, card.__id, gv.order.length);
            card.__groupId = gv.id;
            try {
              InstancesRepo.updateMany([{ id: card.__id, group_id: gv.id }]);
            } catch {}
            placeCardInGroup(gv, card, sprites, (s) =>
              spatial.update({
                id: s.__id,
                minX: s.x,
                minY: s.y,
                maxX: s.x + 100,
                maxY: s.y + 140,
              }),
            );
            updateGroupMetrics(gv, sprites);
            drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
            scheduleGroupSave();
            // Update appearance for membership (non-image placeholder style) & selection outline
            updateCardSpriteAppearance(
              card,
              SelectionStore.state.cardIds.has(card.__id),
            );
          });
          if (already) {
            it.style.opacity = "0.8";
            const badge = document.createElement("span");
            badge.textContent = "✓";
            badge.style.cssText =
              "margin-left:auto;color:var(--success-accent);font-size:24px;";
            it.appendChild(badge);
          }
        });
    }
    if (card.__groupId) {
      const divider = document.createElement("div");
      divider.style.cssText =
        "height:1px;background:var(--menu-divider-bg);margin:6px 4px;";
      el.appendChild(divider);
      addItem("Remove from current group", () => {
        const old = card.__groupId ? groups.get(card.__groupId) : null;
        if (old) {
          console.log(
            "[cardMenu] remove card",
            card.__id,
            "from group",
            old.id,
          );
          removeCardFromGroup(old, card.__id);
          card.__groupId = undefined;
          try {
            InstancesRepo.updateMany([{ id: card.__id, group_id: null }]);
          } catch {}
          // Ensure sprite reappears and is interactive after removal
          (card as any).__groupOverlayActive = false;
          (card as any).eventMode = "static";
          card.cursor = "pointer";
          card.alpha = 1;
          card.visible = true;
          card.renderable = true;
          updateGroupMetrics(old, sprites);
          drawGroup(old, SelectionStore.state.groupIds.has(old.id));
          scheduleGroupSave();
          updateCardSpriteAppearance(
            card,
            SelectionStore.state.cardIds.has(card.__id),
          );
        }
      });
    }
    const bounds = app.renderer.canvas.getBoundingClientRect();
    el.style.left = `${bounds.left + globalPt.x + 4}px`;
    el.style.top = `${bounds.top + globalPt.y + 4}px`;
    el.style.display = "block";
  }
  // Attach right-click listeners to existing cards once (after menu helpers defined)
  // Right-click gesture logic: open on button release if not dragged beyond threshold.
  const RIGHT_THRESHOLD_PX = 6; // screen-space threshold
  const rightPresses = new Map<
    number,
    { x: number; y: number; sprite: CardSprite; moved: boolean }
  >();
  function ensureCardContextListeners() {
    sprites.forEach((s) => {
      const anyS: any = s as any;
      if (anyS.__ctxAttached) return;
      anyS.__ctxAttached = true;
      s.on("pointerdown", (e: any) => {
        if (e.button === 2) {
          rightPresses.set(e.pointerId, {
            x: e.global.x,
            y: e.global.y,
            sprite: s,
            moved: false,
          });
        }
      });
    });
  }
  // Global move/up handling
  app.stage.on("pointermove", (e: any) => {
    const rp = rightPresses.get(e.pointerId);
    if (!rp) return;
    if (!rp.moved) {
      const dx = e.global.x - rp.x;
      const dy = e.global.y - rp.y;
      if (dx * dx + dy * dy > RIGHT_THRESHOLD_PX * RIGHT_THRESHOLD_PX) {
        rp.moved = true;
        // Start a right-button pan if not already panning
        if (!rightPanning) {
          rightPanning = true;
          beginPan(e.global.x, e.global.y);
        }
      }
    }
  });
  function handleRightPointerUp(e: any) {
    if (e.button !== 2) return;
    const rp = rightPresses.get(e.pointerId);
    if (!rp) return;
    const sprite = rp.sprite;
    const moved = rp.moved;
    rightPresses.delete(e.pointerId);
    if (!moved) {
      // Open menu at release point
      showCardContextMenu(sprite, e.global);
    }
  }
  app.stage.on("pointerup", handleRightPointerUp);
  app.stage.on("pointerupoutside", handleRightPointerUp);
  // We'll call ensureCardContextListeners after sprite creation.

  // Simple button: press G to create group around selection bounds
  function computeSelectionBounds() {
    const ids = SelectionStore.getCards();
    if (!ids.length) return null;
    const selectedSprites = sprites.filter((s) => ids.includes(s.__id));
    const minX = Math.min(...selectedSprites.map((s) => s.x));
    const minY = Math.min(...selectedSprites.map((s) => s.y));
    const maxX = Math.max(...selectedSprites.map((s) => s.x + CARD_W_GLOBAL));
    const maxY = Math.max(...selectedSprites.map((s) => s.y + CARD_H_GLOBAL));
    return { minX, minY, maxX, maxY };
  }

  window.addEventListener("keydown", async (e) => {
    // If focus is in a text-editing element, don't run canvas shortcuts (allows Ctrl+A, arrows, etc.)
    const ae = document.activeElement as HTMLElement | null;
    if (
      ae &&
      (ae.tagName === "INPUT" ||
        ae.tagName === "TEXTAREA" ||
        ae.isContentEditable)
    ) {
      // Allow Ctrl+F to reopen search, Esc handled elsewhere; block canvas fits (F / Shift+F) and others.
      if ((e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey)) {
        // handled later by global search palette section
      } else {
        return; // swallow other canvas shortcuts while editing text
      }
    }
    if (e.key === "g" || e.key === "G") {
      let id = groups.size ? Math.max(...groups.keys()) + 1 : 1;
      const b = computeSelectionBounds();
      if (b) {
        const w = b.maxX - b.minX + 40;
        const h = b.maxY - b.minY + 40;
        const gx = b.minX - 20;
        const gy = b.minY - 20;
        try {
          id = (GroupsRepo as any).create
            ? (GroupsRepo as any).create(null, null, gx, gy, w, h)
            : id;
        } catch {}
        const gv = createGroupVisual(id, gx, gy, w, h);
        const ids = SelectionStore.getCards();
        const membershipBatch: { id: number; group_id: number }[] = [];
        const touchedOld = new Set<number>();
        ids.forEach((cid) => {
          const s = sprites.find((sp) => sp.__id === cid);
          if (!s) return;
          // Remove from previous group if any
          if (s.__groupId && s.__groupId !== gv.id) {
            const old = groups.get(s.__groupId);
            if (old) {
              removeCardFromGroup(old, s.__id);
              touchedOld.add(old.id);
            }
          }
          addCardToGroupOrdered(gv, cid, gv.order.length);
          s.__groupId = gv.id;
          membershipBatch.push({ id: cid, group_id: gv.id });
        });
        if (membershipBatch.length) {
          try {
            InstancesRepo.updateMany(membershipBatch);
          } catch {}
        }
        groups.set(id, gv);
        world.addChild(gv.gfx);
        attachResizeHandle(gv);
        attachGroupInteractions(gv);
        // Update any old groups affected
        touchedOld.forEach((gid) => {
          const og = groups.get(gid);
          if (!og) return;
          updateGroupMetrics(og, sprites);
          drawGroup(og, SelectionStore.state.groupIds.has(og.id));
        });
        layoutGroup(gv, sprites, (s) =>
          spatial.update({
            id: s.__id,
            minX: s.x,
            minY: s.y,
            maxX: s.x + CARD_W_GLOBAL,
            maxY: s.y + CARD_H_GLOBAL,
          }),
        );
        updateGroupMetrics(gv, sprites);
        drawGroup(gv, true);
        scheduleGroupSave();
        SelectionStore.clear();
        SelectionStore.toggleGroup(id);
        updateEmptyStateOverlay();
      } else {
        const center = new PIXI.Point(
          window.innerWidth / 2,
          window.innerHeight / 2,
        );
        const worldCenter = world.toLocal(center);
        const gx = snap(worldCenter.x - 150);
        const gy = snap(worldCenter.y - 150);
        try {
          id = (GroupsRepo as any).create
            ? (GroupsRepo as any).create(null, null, gx, gy, 300, 300)
            : id;
        } catch {}
        const gv = createGroupVisual(id, gx, gy, 300, 300);
        groups.set(id, gv);
        world.addChild(gv.gfx);
        attachResizeHandle(gv);
        attachGroupInteractions(gv);
        layoutGroup(gv, sprites, (s) =>
          spatial.update({
            id: s.__id,
            minX: s.x,
            minY: s.y,
            maxX: s.x + CARD_W_GLOBAL,
            maxY: s.y + CARD_H_GLOBAL,
          }),
        );
        updateGroupMetrics(gv, sprites);
        drawGroup(gv, true);
        scheduleGroupSave();
        SelectionStore.clear();
        SelectionStore.toggleGroup(id);
        updateEmptyStateOverlay();
      }
    }

    // Select all (Ctrl+A)
    if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      SelectionStore.replace({
        cardIds: new Set(sprites.map((s) => s.__id)),
        groupIds: new Set(),
      });
    }
    // Clear selection (Esc)
    if (e.key === "Escape") {
      SelectionStore.clear();
    }
    // Zoom / fit shortcuts (+ / - / 0 reset, F fit all (no modifier), Shift+F fit selection, Z fit selection)
    if ((e.key === "+" || e.key === "=") && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      keyboardZoom(1.1);
    }
    if (e.key === "-" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      keyboardZoom(0.9);
    }
    if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      resetZoom();
    }
    // Guard: don't treat Ctrl+F / Cmd+F as fitAll so browser / custom search palette can use it
    if (!e.ctrlKey && !e.metaKey && (e.key === "f" || e.key === "F")) {
      if (e.shiftKey) fitSelection();
      else fitAll();
    }
    if (e.key === "z" || e.key === "Z") {
      fitSelection();
    }
    // Help hotkey disabled in favor of FAB
    if (e.key === "Delete") {
      const cardIds = SelectionStore.getCards();
      const groupIds = SelectionStore.getGroups();
      if (cardIds.length) {
        // Track backing repo ids and scryfall ids for cleanup
        const sfIds: string[] = [];
        const touchedGroups = new Set<number>();
        cardIds.forEach((id) => {
          const idx = sprites.findIndex((s) => s.__id === id);
          if (idx >= 0) {
            const s = sprites[idx];
            const anyS: any = s as any;
            const gid = s.__groupId;
            if (gid) {
              const gv = groups.get(gid);
              gv && gv.items.delete(s.__id);
              touchedGroups.add(gid);
            }
            // Collect Scryfall id for removal from imported store (memory mode)
            const sid = anyS.__scryfallId || anyS.__card?.id;
            if (sid) sfIds.push(String(sid));
            s.destroy();
            sprites.splice(idx, 1);
          }
        });
        // Delete from repository so DB/memory won't restore
        try {
          if (cardIds.length) InstancesRepo.deleteMany(cardIds);
        } catch {}
        touchedGroups.forEach((gid) => {
          const gv = groups.get(gid);
          if (gv) {
            ensureGroupEncapsulates(gv, sprites);
          }
        });
        if (touchedGroups.size) scheduleGroupSave();
        // If no cards and no groups remain, surface overlay
        updateEmptyStateOverlay();
        // Persist updated positions to reflect removals
        try {
          if (!SUPPRESS_SAVES) {
            const data = {
              instances: sprites.map((s) => ({
                id: s.__id,
                x: s.x,
                y: s.y,
                z: s.zIndex || (s as any).__baseZ || 0,
                group_id: (s as any).__groupId ?? null,
                scryfall_id:
                  (s as any).__scryfallId || ((s as any).__card?.id ?? null),
              })),
              byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
            };
            localStorage.setItem(LS_KEY, JSON.stringify(data));
          }
        } catch {}
      }
      if (groupIds.length) {
        groupIds.forEach((id) => deleteGroupById(id));
        scheduleGroupSave();
      }
      SelectionStore.clear();
    }
  });

  world.sortableChildren = true;

  // Selection visualization (simple outline)
  SelectionStore.on(() => {
    const ids = SelectionStore.getCards();
    const gsel = SelectionStore.getGroups();
    groups.forEach((gv) => drawGroup(gv, gsel.includes(gv.id)));
    sprites.forEach((s) => updateCardSpriteAppearance(s, ids.includes(s.__id)));
    updateGroupInfoPanel();
  });

  // Unified marquee + drag/resize state handlers
  const marquee = new MarqueeSystem(
    world,
    app.stage,
    () => sprites,
    (rect) => {
      const x1 = rect.x,
        y1 = rect.y,
        x2 = rect.x + rect.w,
        y2 = rect.y + rect.h;
      // Determine if any group with active overlay intersects selection rect
      const activeGroups: number[] = [];
      groups.forEach((gv) => {
        if ((gv._lastZoomPhase || 0) > 0.05) {
          const gx1 = gv.gfx.x,
            gy1 = gv.gfx.y,
            gx2 = gv.gfx.x + gv.w,
            gy2 = gv.gfx.y + gv.h;
          const intersects = !(x2 < gx1 || x1 > gx2 || y2 < gy1 || y1 > gy2);
          if (intersects) activeGroups.push(gv.id);
        }
      });
      if (activeGroups.length) {
        // In overlay mode: select groups, but also include ungrouped cards in rect
        const found = spatial.search(
          rect.x,
          rect.y,
          rect.x + rect.w,
          rect.y + rect.h,
        );
        const idSet = new Set(found.map((f) => f.id));
        const cardIds = sprites
          .filter((s) => {
            if (!idSet.has(s.__id)) return false;
            if ((s as any).__groupId) return false;
            const cx = s.x + 50;
            const cy = s.y + 70;
            return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
          })
          .map((s) => s.__id);
        return { groupIds: activeGroups, cardIds };
      } else {
        // Normal mode: select cards only
        const found = spatial.search(
          rect.x,
          rect.y,
          rect.x + rect.w,
          rect.y + rect.h,
        );
        const idSet = new Set(found.map((f) => f.id));
        const cardIds = sprites
          .filter((s) => {
            if (!idSet.has(s.__id)) return false;
            const cx = s.x + 50;
            const cy = s.y + 70;
            return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
          })
          .map((s) => s.__id);
        return { cardIds, groupIds: [] };
      }
    },
  );

  app.stage.on("pointerdown", (e) => {
    if (panning || (e as any).button === 2) return;
    const tgt: any = e.target;
    const groupBody = tgt && tgt.__groupBody;
    if (e.target === app.stage || e.target === world || groupBody) {
      // Clear selection unless additive
      if (!e.shiftKey) SelectionStore.clear();
      marquee.start(e.global, e.shiftKey);
    }
  });
  app.stage.on("pointermove", (e) => {
    if (marquee.isActive()) marquee.update(e.global);
  });
  app.stage.on("pointerup", () => {
    if (marquee.isActive()) marquee.finish();
  });
  app.stage.on("pointerupoutside", () => {
    if (marquee.isActive()) marquee.finish();
  });

  // (Old marquee code removed; unified handlers added later.)

  // Zoom helpers (declared early so keyboard shortcuts can reference)
  let applyZoom = (scaleFactor: number, centerGlobal: PIXI.Point) => {
    camera.zoomAt(scaleFactor, centerGlobal);
  };
  // Defer upgrades to the per-frame upgrader to avoid burst decode/upload spikes on rapid zoom
  const origApplyZoom = applyZoom;
  applyZoom = (f: number, pt: PIXI.Point) => {
    origApplyZoom(f, pt);
  };
  function keyboardZoom(f: number) {
    const center = new PIXI.Point(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );
    applyZoom(f, center);
  }
  function resetZoom() {
    const center = new PIXI.Point(
      window.innerWidth / 2,
      window.innerHeight / 2,
    );
    world.scale.set(1);
    world.position.set(0, 0);
    applyZoom(1, center);
  }
  function computeBoundsFromSprites(list: CardSprite[]) {
    if (!list.length) return null;
    const rects = list.map((s) => ({ x: s.x, y: s.y, w: 100, h: 140 }));
    return mergeRects(rects);
  }
  function mergeRects(rects: { x: number; y: number; w: number; h: number }[]) {
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  function computeAllBounds() {
    return computeBoundsFromSprites(sprites);
  }
  function fitBounds(b: { x: number; y: number; w: number; h: number } | null) {
    camera.fitBounds(b, { w: window.innerWidth, h: window.innerHeight });
  }
  function computeSelectionOrGroupsBounds() {
    const ids = SelectionStore.getCards();
    const gids = SelectionStore.getGroups();
    const cardSprites = sprites.filter((s) => ids.includes(s.__id));
    const groupSprites = gids
      .map((id) => groups.get(id))
      .filter(Boolean) as GroupVisual[];
    if (!cardSprites.length && !groupSprites.length) return null;
    const rects: { x: number; y: number; w: number; h: number }[] = [];
    cardSprites.forEach((s) => rects.push({ x: s.x, y: s.y, w: 100, h: 140 }));
    groupSprites.forEach((gv) =>
      rects.push({ x: gv.gfx.x, y: gv.gfx.y, w: gv.w, h: gv.h }),
    );
    return mergeRects(rects);
  }
  function fitAll() {
    fitBounds(computeAllBounds());
  }
  function fitSelection() {
    const b = computeSelectionOrGroupsBounds();
    if (b) fitBounds(b);
  }
  window.addEventListener(
    "wheel",
    (e) => {
      // Ignore wheel when pointer is over UI panels/inputs so lists can scroll without zooming
      try {
        const t = e.target as HTMLElement | null;
        if (t && t instanceof HTMLElement) {
          const inUi = t.closest(
            ".ui-panel, .ui-panel-scroll, .ui-menu, textarea, input, select",
          );
          if (inUi) return; // let the UI consume the wheel normally
        }
      } catch {}
      const mousePos = new PIXI.Point(
        app.renderer.events.pointer.global.x,
        app.renderer.events.pointer.global.y,
      );
      applyZoom(e.deltaY < 0 ? 1.1 : 0.9, mousePos);
    },
    { passive: true },
  );

  // Pan modes: space+left, middle button, or right button drag (on empty canvas/world area)
  let panning = false; // spacebar modifier for left button
  let rightPanning = false; // active right-button pan
  let midPanning = false; // active middle-button pan
  let lastX = 0;
  let lastY = 0;
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      panning = true;
      document.body.style.cursor = "grab";
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      panning = false;
      camera.endPan();
      if (!rightPanning && !midPanning) document.body.style.cursor = "default";
    }
  });
  app.stage.eventMode = "static";
  function beginPan(x: number, y: number) {
    lastX = x;
    lastY = y;
    document.body.style.cursor = "grabbing";
    camera.startPan();
  }
  function applyPan(e: PIXI.FederatedPointerEvent) {
    const dx = e.global.x - lastX;
    const dy = e.global.y - lastY;
    camera.panBy(dx, dy);
    lastX = e.global.x;
    lastY = e.global.y;
  }
  app.stage.on("pointerdown", (e) => {
    try {
      camera.stopMomentum();
    } catch {}
    const tgt: any = e.target;
    if (panning && e.button === 0) beginPan(e.global.x, e.global.y);
    if (e.button === 2) {
      // If right-clicked directly on a card sprite, DON'T start a pan so we can show context menu.
      if (tgt && tgt.__cardSprite) {
        // Stop propagation so stage-level pan suppression doesn't interfere
        // (We still rely on sprite's own rightclick handler.)
        return; // skip initiating rightPanning
      }
      rightPanning = true;
      beginPan(e.global.x, e.global.y);
    }
  });
  app.stage.on("pointermove", (e) => {
    if (
      (panning && e.buttons & 1) ||
      (rightPanning && e.buttons & 2) ||
      (midPanning && e.buttons & 4)
    )
      applyPan(e);
  });
  const endPan = (e: PIXI.FederatedPointerEvent) => {
    if (e.button === 2 && rightPanning) {
      rightPanning = false;
      if (!panning && !midPanning) document.body.style.cursor = "default";
    }
    // End of any pan gesture -> let camera glide if velocity is sufficient
    if (!(e.buttons & 1) && !(e.buttons & 2) && !(e.buttons & 4))
      camera.endPan();
  };
  app.stage.on("pointerup", endPan);
  app.stage.on("pointerupoutside", endPan);
  // Middle button (direct on canvas element)
  app.canvas.addEventListener("pointerdown", (ev) => {
    const pev = ev as PointerEvent;
    try {
      camera.stopMomentum();
    } catch {}
    if (pev.button === 1) {
      midPanning = true;
      beginPan(pev.clientX, pev.clientY);
    }
  });
  app.canvas.addEventListener("pointerup", (ev) => {
    const pev = ev as PointerEvent;
    if (pev.button === 1) {
      midPanning = false;
      camera.endPan();
      if (!panning && !rightPanning) document.body.style.cursor = "default";
    }
  });
  app.canvas.addEventListener("mouseleave", () => {
    if (midPanning || rightPanning) {
      midPanning = false;
      rightPanning = false;
      camera.endPan();
      if (!panning) document.body.style.cursor = "default";
    }
  });
  app.canvas.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
  });

  // Deselect when clicking empty space (ignore while panning via any mode)

  // Debug: log card count after seeding
  console.log("[mtgcanvas] Seeded cards:", sprites.length);

  // (Removed blocking hi-res preload progress bar; images now load lazily as needed.)

  // ---- Performance overlay ----
  ensureThemeStyles();
  // Ensure modern day/night toggle (flat pill)
  try {
    ensureThemeToggleButton();
  } catch {}
  const perfEl = document.createElement("div");
  perfEl.id = "perf-overlay";
  // Use shared panel theme (ensure fixed positioning & stacking above canvas)
  perfEl.className = "ui-panel perf-grid";
  perfEl.style.position = "fixed";
  perfEl.style.left = "10px";
  perfEl.style.bottom = "10px";
  perfEl.style.zIndex = "10002";
  perfEl.style.minWidth = "280px";
  perfEl.style.padding = "14px 16px";
  perfEl.style.fontSize = "15px";
  perfEl.style.pointerEvents = "none";
  document.body.appendChild(perfEl);
  (window as any).__perfOverlay = perfEl;
  // Quick debug toggles surfaced to window
  (window as any).__imgDebug = (on: boolean) => enableImageCacheDebug(!!on);
  (window as any).__dumpHiRes = () => {
    try {
      console.log("[HiRes dump]", getHiResQueueDiagnostics());
    } catch (e) {
      console.warn("dumpHiRes failed", e);
    }
  };
  (window as any).__dumpDecodeQ = () => {
    try {
      console.log("[DecodeQ dump]", getDecodeQueueStats());
    } catch (e) {
      console.warn("dumpDecodeQ failed", e);
    }
  };
  (window as any).__forceCompact = () => {
    try {
      forceCompactHiResQueue();
      console.log("[HiRes] forced compaction");
    } catch (e) {
      console.warn("forceCompact failed", e);
    }
  };
  let frameCount = 0;
  let lastFpsTime = performance.now();
  let fps = 0;
  let lsTimer: any = null;
  function scheduleLocalSave() {
    if (SUPPRESS_SAVES) return;
    if (lsTimer) return;
    lsTimer = setTimeout(persistLocalPositions, 350);
  }
  function persistLocalPositions() {
    if (SUPPRESS_SAVES) {
      lsTimer = null;
      return;
    }
    lsTimer = null;
    try {
      const data = {
        instances: sprites.map((s) => ({
          id: s.__id,
          x: s.x,
          y: s.y,
          z: s.zIndex || (s as any).__baseZ || 0,
          group_id: (s as any).__groupId ?? null,
          scryfall_id:
            (s as any).__scryfallId || ((s as any).__card?.id ?? null),
        })),
        byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
      };
      // Mirror z into repository for in-memory consistency
      try {
        InstancesRepo.updateMany(
          data.instances.map((r) => ({ id: r.id, z: r.z })) as any,
        );
      } catch {}
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {}
  }
  let lastMemSample = 0;
  let jsHeapLine = "JS ?";
  let texLine = "Tex ?";
  let texResLine = "Res ?";
  let hiResPendingLine = "GlobalPending ?";
  let qualLine = "Qual ?";
  let decodeQLine = "DecodeQ ?";
  let hiResDiagLine = "HiResDiag ?";
  let decodeDiagLine = "DecodeDiag ?";
  function sampleMemory() {
    // JS heap (Chrome only):
    const anyPerf: any = performance as any;
    if (anyPerf && anyPerf.memory) {
      const used = anyPerf.memory.usedJSHeapSize;
      const mb = used / 1048576;
      jsHeapLine = `JS ${mb.toFixed(1)} MB`;
    } else jsHeapLine = "JS n/a";
    // Rough texture memory estimate (unique baseTextures)
    const seen = new Set<any>();
    let bytes = 0;
    let hi = 0,
      med = 0,
      low = 0,
      pending = 0;
    let q0 = 0,
      q1 = 0,
      q2 = 0,
      loading = 0;
    for (const s of sprites) {
      const tex: any = s.texture;
      const bt = tex?.baseTexture || tex?.source?.baseTexture || tex?.source;
      if (!bt) continue;
      if (!seen.has(bt)) {
        seen.add(bt);
        const w = bt.width || bt.realWidth || bt.resource?.width;
        const h = bt.height || bt.realHeight || bt.resource?.height;
        if (w && h) bytes += w * h * 4;
        if (h >= 1000) hi++;
        else if (h >= 500) med++;
        else low++;
      }
    }
    // Global pending (ignores visibility)
    for (const s of sprites) {
      if (s.__imgLoaded && s.__qualityLevel !== 2) pending++;
      const q = s.__qualityLevel;
      if (q === 0) q0++;
      else if (q === 1) q1++;
      else if (q === 2) q2++;
      if (s.__hiResLoading || s.__imgLoading) loading++;
    }
    texResLine = `TexRes low:${low} med:${med} hi:${hi}`;
    hiResPendingLine = `GlobalPending ${pending}`;
    qualLine = `Qual q0:${q0} q1:${q1} q2:${q2} load:${loading}`;
    try {
      decodeQLine = `DecodeQ ${getDecodeQueueSize()}`;
      const dqs = getDecodeQueueStats?.();
      if (dqs)
        decodeDiagLine = `Decodes act:${dqs.active} q:${dqs.queued} oldest:${dqs.oldestWaitMs.toFixed(0)}ms avg:${dqs.avgWaitMs.toFixed(0)}ms`;
    } catch {
      decodeQLine = "DecodeQ n/a";
      decodeDiagLine = "DecodeDiag n/a";
    }
    try {
      const hq = getHiResQueueDiagnostics?.();
      if (hq)
        hiResDiagLine = `HiRes loaded:${hq.loaded} loading:${hq.loading} stale:${hq.stale} vis:${hq.visible} oldest:${(hq.oldestMs || 0).toFixed(0)}ms`;
    } catch {
      hiResDiagLine = "HiResDiag n/a";
    }
    texLine = `Tex ~${(bytes / 1048576).toFixed(1)} MB`;
  }
  function updatePerf() {
    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime > 500) {
      fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
      frameCount = 0;
      lastFpsTime = now;
    }
    if (now - lastMemSample > 1000) {
      sampleMemory();
      lastMemSample = now;
    }
    const stats = getImageCacheStats();
    if ((now & 0x3ff) === 0) {
      // periodic usage refresh
      getCacheUsage().then((u) => {
        (perfEl as any).__usage = u;
      });
    }
    const usage = (perfEl as any).__usage;
    const zMin = currentMinContentZ();
    const zMax = (window as any).__mtgMaxContentZ
      ? Number((window as any).__mtgMaxContentZ())
      : 0;
    perfEl.textContent =
      `Status / Performance\n` +
      ` FPS: ${fps}\n` +
      ` Zoom: ${world.scale.x.toFixed(2)}x\n` +
      ` JS Heap: ${jsHeapLine.replace("JS ", "")}\n` +
      `\nCards\n` +
      ` Total Cards: ${sprites.length}\n` +
      ` Z Min/Max: ${zMin} / ${zMax}\n` +
      `\nImages / Textures\n` +
      ` GPU Tex Mem: ${texLine.replace("Tex ", "")}\n` +
      ` Unique Tex Res: ${texResLine.replace("TexRes ", "")}\n` +
      ` Hi-Res Pending: ${hiResPendingLine.replace("GlobalPending ", "")}\n` +
      ` Quality Levels: ${qualLine.replace("Qual ", "").replace(/q0:/, "small:").replace(/q1:/, "mid:").replace(/q2:/, "hi:").replace("load:", "loading:")}\n` +
      ` Hi-Res Queue Len: ${getHiResQueueLength()}\n` +
      ` ${hiResDiagLine}\n` +
      ` In-Flight Decodes: ${getInflightTextureCount()}\n` +
      ` Decode Queue: ${decodeQLine.replace("DecodeQ ", "")}\n` +
      ` ${decodeDiagLine}\n` +
      `\nCache Layers\n` +
      ` Session Hits: ${stats.sessionHits}  IDB Hits: ${stats.idbHits}  Canonical Hits: ${stats.canonicalHits}\n` +
      `\nNetwork\n` +
      ` Fetches: ${stats.netFetches}  Data: ${(stats.netBytes / 1048576).toFixed(1)} MB\n` +
      ` Errors: ${stats.netErrors}  Resource Exhaust: ${stats.resourceErrors}\n` +
      ` Active Fetches: ${stats.activeFetches}  Queued: ${stats.queuedFetches}\n` +
      ` Last Fetch Duration: ${stats.lastNetMs.toFixed(1)} ms\n` +
      `\nStorage\n` +
      (usage
        ? ` IDB Usage: ${(usage.bytes / 1048576).toFixed(1)} / ${(usage.budget / 1048576).toFixed(0)} MB (${usage.count} objects)${usage.over ? "  OVER BUDGET (evicting on new writes)" : ""}`
        : " IDB Usage: pending...");
  }

  // ---- Debug Panel (layout & grouping resets) ----
  function ensureDebugPanel() {
    let el = document.getElementById("debug-panel");
    if (el) return el as HTMLDivElement;
    el = document.createElement("div");
    el.id = "debug-panel";
    // Base styling; precise position continuously synced below perf overlay each frame
    el.style.cssText =
      "position:fixed;left:6px;top:300px;z-index:10005;display:flex;flex-direction:column;gap:6px;min-width:220px;transition:top .08s linear;";
    el.className = "ui-panel";
    // No header; this panel serves general user tools
    function addBtn(label: string, handler: (ev: MouseEvent) => void) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = "ui-btn";
      b.style.fontSize = "16px";
      b.style.padding = "10px 14px";
      b.onclick = handler as any;
      el!.appendChild(b);
    }
    addBtn("Auto-Layout", () => {
      gridUngroupedCards();
      gridGroupedCards();
      gridRepositionGroups();
      // After tidying, center the view on the resulting content for clarity
      focusViewOnContent(180);
    });
    // Auto-Group tools (hold Shift/Alt to include singletons)
    addBtn("Auto-Group by Set", (ev) => {
      autoGroupUngroupedBy("set", {
        includeSingletons: ev.shiftKey || ev.altKey,
      });
    });
    addBtn("Auto-Group by Color Identity", (ev) => {
      autoGroupUngroupedBy("color-id", {
        includeSingletons: ev.shiftKey || ev.altKey,
      });
    });
    addBtn("Auto-Group by Type", (ev) => {
      autoGroupUngroupedBy("type", {
        includeSingletons: ev.shiftKey || ev.altKey,
      });
    });
    addBtn("Auto-Group by Rarity", (ev) => {
      autoGroupUngroupedBy("rarity", {
        includeSingletons: ev.shiftKey || ev.altKey,
      });
    });
    addBtn("Auto-Group by CMC", (ev) => {
      autoGroupUngroupedBy("cmc", {
        includeSingletons: ev.shiftKey || ev.altKey,
      });
    });
    addBtn("Reset Layout", () => {
      const ok = window.confirm(
        "Full Reset will clear all groups and auto-layout all card. This cannot be undone. Proceed?",
      );
      if (!ok) return;
      clearGroupsOnly();
      resetLayout(true);
    });
    // Clear persisted data (moved from Import/Export panel)
    addBtn("Clear All Data", async (ev) => {
      const ok = window.confirm(
        "Clear persisted MTGCanvas data (positions, groups, imported cards)?\nThis will reload the page.",
      );
      if (!ok) return;
      const btn = ev?.currentTarget as HTMLButtonElement | null;
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Clearing…";
      }
      try {
        (importExportUI as any)?.hide?.();
      } catch {}
      try {
        await clearAllData();
      } catch {}
      setTimeout(() => location.reload(), 200);
    });
    document.body.appendChild(el);
    // Continuous sync each frame so it's always directly below perf overlay regardless of dynamic height changes
    const syncDebugPosition = () => {
      const perf = document.getElementById("perf-overlay");
      if (!perf) return;
      const r = perf.getBoundingClientRect();
      const desiredLeft = r.left;
      const viewportH = window.innerHeight;
      const panelH = el!.getBoundingClientRect().height || 0;
      // If perf overlay is in the top half, place panel below it; otherwise place above it.
      const desiredTop =
        r.top < viewportH / 2
          ? r.bottom + 10
          : Math.max(10, r.top - panelH - 10);
      if (el!.style.left !== desiredLeft + "px")
        el!.style.left = desiredLeft + "px";
      if (el!.style.top !== desiredTop + "px")
        el!.style.top = desiredTop + "px";
    };
    // Hook into PIXI ticker (defined earlier). If unavailable, use rAF.
    try {
      (app.ticker as any).add(syncDebugPosition);
    } catch {
      requestAnimationFrame(function loop() {
        syncDebugPosition();
        requestAnimationFrame(loop);
      });
    }
    syncDebugPosition();
    return el;
  }
  function gridGroupedCards() {
    // Auto-pack each group with minimal translation: keep group center fixed while packing
    groups.forEach((gv) => {
      const oldW = gv.w;
      const oldH = gv.h;
      const oldX = gv.gfx.x;
      const oldY = gv.gfx.y;
      const centerX = oldX + oldW / 2;
      const centerY = oldY + oldH / 2;
      // Pack to update w/h and card positions relative to group origin
      autoPackGroup(gv, sprites, (s) =>
        spatial.update({
          id: s.__id,
          minX: s.x,
          minY: s.y,
          maxX: s.x + CARD_W_GLOBAL,
          maxY: s.y + CARD_H_GLOBAL,
        }),
      );
      // Shift group so its center remains the same after pack
      let dx = Math.round(centerX - (gv.gfx.x + gv.w / 2));
      let dy = Math.round(centerY - (gv.gfx.y + gv.h / 2));
      if (dx !== 0 || dy !== 0) {
        // Snap then clamp the new origin
        const p = clampGroupXY(gv, snap(gv.gfx.x + dx), snap(gv.gfx.y + dy));
        dx = p.x - gv.gfx.x;
        dy = p.y - gv.gfx.y;
        gv.gfx.x = p.x;
        gv.gfx.y = p.y;
        // Move member sprites by the same delta to preserve layout relative to world
        gv.order.forEach((cid) => {
          const sp = sprites.find((s) => s.__id === cid);
          if (!sp) return;
          sp.x = snap(sp.x + dx);
          sp.y = snap(sp.y + dy);
          spatial.update({
            id: sp.__id,
            minX: sp.x,
            minY: sp.y,
            maxX: sp.x + CARD_W_GLOBAL,
            maxY: sp.y + CARD_H_GLOBAL,
          });
        });
      }
      // Persist group dimensions/position changes if any
      try {
        persistGroupTransform(gv.id, {
          x: gv.gfx.x,
          y: gv.gfx.y,
          w: gv.w,
          h: gv.h,
        });
      } catch {}
    });
    // Save (memory mode) after batch operation
    try {
      scheduleGroupSave();
    } catch {}
  }
  // Auto-group ungrouped cards by property
  type AutoGroupKind = "set" | "color-id" | "type" | "rarity" | "cmc";
  function primaryType(typeLine: string | undefined): string {
    if (!typeLine) return "Unknown";
    const tl = typeLine;
    const order = [
      "Creature",
      "Instant",
      "Sorcery",
      "Artifact",
      "Enchantment",
      "Planeswalker",
      "Battle",
      "Land",
    ];
    for (const t of order) if (tl.includes(t)) return t;
    // Fallback: token before dash or first word
    const beforeDash = tl.split("—")[0].trim();
    const first = beforeDash.split(/\s+/)[0] || "Unknown";
    return first;
  }
  function autoGroupUngroupedBy(
    kind: AutoGroupKind,
    opts?: { includeSingletons?: boolean },
  ): void {
    const includeSingles = !!opts?.includeSingletons;
    const ungrouped = sprites.filter((s) => !(s as any).__groupId && s.__card);
    if (!ungrouped.length) return;
    const buckets = new Map<string, number[]>();
    const labels = new Map<string, string>();
    for (const s of ungrouped) {
      const c: any = (s as any).__card;
      let key = "";
      let label = "";
      switch (kind) {
        case "set": {
          const code = (c?.set || "unknown").toString().toLowerCase();
          key = code;
          const nm = c?.set_name || code.toUpperCase();
          label = `Set: ${nm} (${code.toUpperCase()})`;
          break;
        }
        case "color-id": {
          const arr = Array.isArray(c?.color_identity) ? c.color_identity : [];
          if (!arr.length) {
            key = "colorless";
            label = "Colorless";
          } else {
            const sorted = arr.slice().sort().join("");
            key = sorted;
            label = `CI: ${sorted.split("").join(" ")}`;
          }
          break;
        }
        case "type": {
          const pt = primaryType(c?.type_line);
          key = pt.toLowerCase();
          label = `Type: ${pt}`;
          break;
        }
        case "rarity": {
          const r = (c?.rarity || "unknown").toString();
          key = r;
          label = `Rarity: ${r}`;
          break;
        }
        case "cmc": {
          const cmc = Number.isFinite(c?.cmc) ? Math.floor(c.cmc) : -1;
          key = String(cmc);
          label = cmc >= 0 ? `CMC: ${cmc}` : "CMC: Unknown";
          break;
        }
      }
      if (!buckets.has(key)) {
        buckets.set(key, []);
        labels.set(key, label);
      }
      buckets.get(key)!.push(s.__id);
    }
    const entries = [...buckets.entries()];
    // Sort by size desc then key asc for stable, pleasing creation order
    entries.sort((a, b) => {
      if (b[1].length !== a[1].length) return b[1].length - a[1].length;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    let created = 0;
    for (const [key, ids] of entries) {
      if (!ids || (!includeSingles && ids.length < 2)) continue;
      const name = labels.get(key) || key;
      try {
        (createGroupWithCardIds as any)(ids, name, { silent: true });
        created++;
      } catch {}
    }
    if (created > 0) {
      // Arrange the new groups compactly near ungrouped centroid
      gridRepositionGroups();
      // Persist after batch
      try {
        scheduleGroupSave();
      } catch {}
    }
  }
  function clearGroupsOnly() {
    // Remove membership on sprites
    const updates: { id: number; group_id: null }[] = [];
    sprites.forEach((s) => {
      const anyS: any = s as any;
      if (anyS.__groupId) {
        anyS.__groupId = undefined;
        updates.push({ id: s.__id, group_id: null });
      }
      // Important: if zoom overlay was active, cards may be hidden/non-interactive -> restore defaults
      if (anyS.__groupOverlayActive) anyS.__groupOverlayActive = false;
      if (anyS.eventMode !== "static") anyS.eventMode = "static";
      if (s.cursor !== "pointer") s.cursor = "pointer";
      s.alpha = 1;
      s.visible = true;
      s.renderable = true;
      // Refresh placeholder appearance & selection outline
      try {
        updateCardSpriteAppearance(s, SelectionStore.state.cardIds.has(s.__id));
      } catch {}
    });
    if (updates.length) {
      try {
        InstancesRepo.updateMany(updates);
      } catch {}
    }
    // Destroy visuals
    const ids = [...groups.keys()];
    ids.forEach((id) => {
      const gv = groups.get(id);
      if (gv) {
        gv.gfx.destroy();
      }
    });
    if (ids.length) {
      try {
        GroupsRepo.deleteMany(ids);
      } catch {}
    }
    groups.clear();
    // Clear persisted group transforms so they don't rehydrate
    try {
      localStorage.removeItem(LS_GROUPS_KEY);
    } catch {}
  }
  function resetLayout(alreadyCleared: boolean) {
    // Assign default grid positions based on current sprite order
    // Ensure all sprites are interactive/visible (in case reset called while overlays active)
    sprites.forEach((s) => {
      const anyS: any = s as any;
      if (anyS.__groupOverlayActive) anyS.__groupOverlayActive = false;
      if (anyS.eventMode !== "static") anyS.eventMode = "static";
      s.cursor = "pointer";
      s.alpha = 1;
      s.visible = true;
      s.renderable = true;
      try {
        updateCardSpriteAppearance(s, SelectionStore.state.cardIds.has(s.__id));
      } catch {}
    });
    const n = sprites.length || 1;
    // Choose grid shape that maximizes squaredness (same as Auto-Layout)
    let bestCols = 1;
    let bestRows = n;
    let bestW = bestRows * CARD_W_GLOBAL + (bestRows - 1) * GAP_X_GLOBAL;
    let bestH = CARD_H_GLOBAL;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const w = c * CARD_W_GLOBAL + (c - 1) * GAP_X_GLOBAL;
      const h = r * CARD_H_GLOBAL + (r - 1) * GAP_Y_GLOBAL;
      let score = Math.abs(w - h);
      const lastRowCount = n - (r - 1) * c;
      const underfill = c > 0 ? (c - lastRowCount) / c : 0;
      score += underfill * Math.min(CARD_W_GLOBAL, CARD_H_GLOBAL) * 0.2;
      if (score < bestScore) {
        bestScore = score;
        bestCols = c;
        bestRows = r;
        bestW = w;
        bestH = h;
      }
    }
    const blockW = bestW;
    const blockH = bestH;
    const b = getCanvasBounds();
    // Start centered within bounds, then clamp so the whole block fits
    let startX = snap(Math.round(b.x + (b.w - blockW) / 2));
    let startY = snap(Math.round(b.y + (b.h - blockH) / 2));
    startX = Math.min(Math.max(b.x, startX), b.x + b.w - blockW);
    startY = Math.min(Math.max(b.y, startY), b.y + b.h - blockH);
    const batch: { id: number; x: number; y: number }[] = [];
    sprites.forEach((s, idx) => {
      const col = idx % bestCols;
      const row = Math.floor(idx / bestCols);
      let x = startX + col * (CARD_W_GLOBAL + GAP_X_GLOBAL);
      let y = startY + row * (CARD_H_GLOBAL + GAP_Y_GLOBAL);
      // Safety clamp per-card
      x = Math.min(b.x + b.w - CARD_W_GLOBAL, Math.max(b.x, x));
      y = Math.min(b.y + b.h - CARD_H_GLOBAL, Math.max(b.y, y));
      s.x = x;
      s.y = y;
      spatial.update({
        id: s.__id,
        minX: x,
        minY: y,
        maxX: x + CARD_W_GLOBAL,
        maxY: y + CARD_H_GLOBAL,
      });
      batch.push({ id: s.__id, x, y });
    });
    if (batch.length) {
      try {
        InstancesRepo.updatePositions(batch);
      } catch {}
    }
    if (!SUPPRESS_SAVES) {
      try {
        const data = {
          instances: sprites.map((s) => ({
            id: s.__id,
            x: s.x,
            y: s.y,
            z: s.zIndex || (s as any).__baseZ || 0,
            group_id: (s as any).__groupId ?? null,
            scryfall_id:
              (s as any).__scryfallId || ((s as any).__card?.id ?? null),
          })),
          byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
        };
        localStorage.setItem(LS_KEY, JSON.stringify(data));
      } catch {}
    }
    if (!alreadyCleared) clearGroupsOnly();
    // After resetting positions, move camera to frame the cards so it doesn't feel like teleporting
    focusViewOnContent(220);
  }
  function gridUngroupedCards() {
    const ungrouped = sprites.filter((s) => !(s as any).__groupId);
    if (!ungrouped.length) return;
    // Compute current cluster bounds of ungrouped to preserve its overall position
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const s of ungrouped) {
      const x1 = s.x;
      const y1 = s.y;
      const x2 = s.x + CARD_W_GLOBAL;
      const y2 = s.y + CARD_H_GLOBAL;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    if (!Number.isFinite(minX)) return;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    // Choose the grid that maximizes "squaredness" (minimize |W - H| in pixels)
    const n = ungrouped.length;
    let bestCols = 1;
    let bestRows = n;
    let bestW = bestRows * CARD_W_GLOBAL + (bestRows - 1) * GAP_X_GLOBAL;
    let bestH = CARD_H_GLOBAL;
    let bestScore = Number.POSITIVE_INFINITY;
    // Try all feasible column counts; O(n) arithmetic is cheap and avoids surprises
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const w = c * CARD_W_GLOBAL + (c - 1) * GAP_X_GLOBAL;
      const h = r * CARD_H_GLOBAL + (r - 1) * GAP_Y_GLOBAL;
      // Primary: pixel difference between width and height
      let score = Math.abs(w - h);
      // Gentle penalty for underfilled last row to avoid extremely ragged final line
      const lastRowCount = n - (r - 1) * c;
      const underfill = c > 0 ? (c - lastRowCount) / c : 0;
      score += underfill * Math.min(CARD_W_GLOBAL, CARD_H_GLOBAL) * 0.2;
      if (score < bestScore) {
        bestScore = score;
        bestCols = c;
        bestRows = r;
        bestW = w;
        bestH = h;
      }
    }
    // Anchor the new grid so its center matches the previous cluster center (minimal translation)
    let startX = snap(Math.round(cx - bestW / 2));
    let startY = snap(Math.round(cy - bestH / 2));
    // Clamp starting origin to keep the whole grid visible within bounds
    const b = getCanvasBounds();
    const maxStartX = b.x + b.w - bestW;
    const maxStartY = b.y + b.h - bestH;
    startX = Math.min(Math.max(b.x, startX), maxStartX);
    startY = Math.min(Math.max(b.y, startY), maxStartY);
    const batch: { id: number; x: number; y: number }[] = [];
    ungrouped.forEach((s, idx) => {
      const col = idx % bestCols;
      const row = Math.floor(idx / bestCols);
      let x = startX + col * (CARD_W_GLOBAL + GAP_X_GLOBAL);
      let y = startY + row * (CARD_H_GLOBAL + GAP_Y_GLOBAL);
      // Extra safety clamp for each card
      x = Math.min(b.x + b.w - CARD_W_GLOBAL, Math.max(b.x, x));
      y = Math.min(b.y + b.h - CARD_H_GLOBAL, Math.max(b.y, y));
      s.x = x;
      s.y = y;
      spatial.update({
        id: s.__id,
        minX: x,
        minY: y,
        maxX: x + CARD_W_GLOBAL,
        maxY: y + CARD_H_GLOBAL,
      });
      batch.push({ id: s.__id, x, y });
    });
    if (batch.length) {
      try {
        InstancesRepo.updatePositions(batch);
      } catch {}
    }
    if (!SUPPRESS_SAVES) {
      try {
        const data = {
          instances: sprites.map((s) => ({
            id: s.__id,
            x: s.x,
            y: s.y,
            z: s.zIndex || (s as any).__baseZ || 0,
            group_id: (s as any).__groupId ?? null,
            scryfall_id:
              (s as any).__scryfallId || ((s as any).__card?.id ?? null),
          })),
          byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
        };
        localStorage.setItem(LS_KEY, JSON.stringify(data));
      } catch {}
    }
  }
  function gridRepositionGroups() {
    const list = Array.from(groups.values());
    // Tighter visual order: largest groups first, then by name, then by id for stability
    list.sort((a, b) => {
      const as = a.order.length;
      const bs = b.order.length;
      if (bs !== as) return bs - as; // larger first
      const an = (a.name || "").toLowerCase();
      const bn = (b.name || "").toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return a.id - b.id;
    });
    if (!list.length) return;
    // Seed strictly from stable content: center of ungrouped cards if any, else canvas center.
    let gx: number, gy: number;
    let ux = 0,
      uy = 0,
      uc = 0;
    for (const s of sprites) {
      if ((s as any).__groupId) continue; // only ungrouped
      ux += s.x + CARD_W_GLOBAL / 2;
      uy += s.y + CARD_H_GLOBAL / 2;
      uc++;
    }
    if (uc > 0) {
      gx = ux / uc;
      gy = uy / uc;
    } else {
      const b = getCanvasBounds();
      gx = b.x + b.w / 2;
      gy = b.y + b.h / 2;
    }
    const rects = list.map((gv) => ({ w: gv.w, h: gv.h }));
    const ctx: PlacementContext = {
      sprites,
      groups,
      world,
      getCanvasBounds,
      gridSize: GRID_SIZE,
      cardW: CARD_W_GLOBAL,
      cardH: CARD_H_GLOBAL,
      gapX: GAP_X_GLOBAL,
      gapY: GAP_Y_GLOBAL,
      spacingX: CARD_W_GLOBAL + GAP_X_GLOBAL,
      spacingY: CARD_H_GLOBAL + GAP_Y_GLOBAL,
    };
    // Make groups mutually attractive by giving them the same label
    const labels = list.map(() => "group");
    // Build an organized grid next to the ungrouped cluster with strict alignment.
    const sepX = Math.max(GAP_X_GLOBAL * 6, 24);
    const sepY = Math.max(GAP_Y_GLOBAL * 6, 24);
    function computeMetrics(cols: number) {
      const rows = Math.max(1, Math.ceil(list.length / Math.max(1, cols)));
      const maxW = new Array<number>(cols).fill(0);
      const maxH = new Array<number>(rows).fill(0);
      for (let i = 0; i < list.length; i++) {
        const c = i % cols;
        const r = Math.floor(i / cols);
        if (list[i].w > maxW[c]) maxW[c] = list[i].w;
        if (list[i].h > maxH[r]) maxH[r] = list[i].h;
      }
      const prefixX = new Array<number>(cols).fill(0);
      for (let c = 1; c < cols; c++)
        prefixX[c] = prefixX[c - 1] + maxW[c - 1] + sepX;
      const prefixY = new Array<number>(rows).fill(0);
      for (let r = 1; r < rows; r++)
        prefixY[r] = prefixY[r - 1] + maxH[r - 1] + sepY;
      const gridW =
        maxW.reduce((a, v) => a + v, 0) + sepX * Math.max(0, cols - 1);
      const gridH =
        maxH.reduce((a, v) => a + v, 0) + sepY * Math.max(0, rows - 1);
      return { cols, rows, maxW, maxH, prefixX, prefixY, gridW, gridH };
    }
    // Compute ungrouped bounds if available
    let haveUngroupedBounds = false;
    let uminX = Number.POSITIVE_INFINITY,
      uminY = Number.POSITIVE_INFINITY,
      umaxX = Number.NEGATIVE_INFINITY,
      umaxY = Number.NEGATIVE_INFINITY;
    if (uc > 0) {
      for (const s of sprites) {
        if ((s as any).__groupId) continue;
        const x1 = s.x,
          y1 = s.y,
          x2 = s.x + CARD_W_GLOBAL,
          y2 = s.y + CARD_H_GLOBAL;
        if (x1 < uminX) uminX = x1;
        if (y1 < uminY) uminY = y1;
        if (x2 > umaxX) umaxX = x2;
        if (y2 > umaxY) umaxY = y2;
      }
      haveUngroupedBounds = Number.isFinite(uminX);
    }
    const bnds = getCanvasBounds();
    const margin = Math.max(24, Math.max(GAP_X_GLOBAL, GAP_Y_GLOBAL) * 6);
    // Candidate choices: side + columns. Evaluate to align grid dimension with ungrouped.
    type Cand = {
      name: "right" | "below" | "left" | "above";
      cols: number;
      tlx: number;
      tly: number;
      gridW: number;
      gridH: number;
      score: number;
      metric: ReturnType<typeof computeMetrics>;
    };
    const cands: Cand[] = [];
    function clampTL(x: number, y: number, gw: number, gh: number) {
      const tlx = Math.min(Math.max(bnds.x, snap(x)), bnds.x + bnds.w - gw);
      const tly = Math.min(Math.max(bnds.y, snap(y)), bnds.y + bnds.h - gh);
      return { tlx, tly };
    }
    function addCand(name: Cand["name"], baseX: number, baseY: number) {
      const MAX_COLS = Math.min(24, Math.max(1, list.length));
      for (let cTry = 1; cTry <= MAX_COLS; cTry++) {
        const met = computeMetrics(cTry);
        // Side-specific anchor proposal before clamp
        let x = baseX,
          y = baseY;
        if (name === "left") x = baseX - met.gridW; // baseX represents ungrouped minX - margin
        if (name === "above") y = baseY - met.gridH; // baseY represents ungrouped minY - margin
        const { tlx, tly } = clampTL(x, y, met.gridW, met.gridH);
        // Reject if overlapping ungrouped bounds (with margin)
        if (haveUngroupedBounds) {
          const gx1 = tlx,
            gy1 = tly,
            gx2 = tlx + met.gridW,
            gy2 = tly + met.gridH;
          const ux1 = uminX - margin,
            uy1 = uminY - margin,
            ux2 = umaxX + margin,
            uy2 = umaxY + margin;
          const overlaps = !(
            gx2 <= ux1 ||
            gx1 >= ux2 ||
            gy2 <= uy1 ||
            gy1 >= uy2
          );
          if (overlaps) continue;
        }
        // Score by minimizing union area of ungrouped + grid, with slight compactness and distance penalties
        const gx1 = tlx,
          gy1 = tly,
          gx2 = tlx + met.gridW,
          gy2 = tly + met.gridH;
        const ux1 = uminX,
          uy1 = uminY,
          ux2 = umaxX,
          uy2 = umaxY;
        const minX = Math.min(ux1, gx1);
        const minY = Math.min(uy1, gy1);
        const maxX = Math.max(ux2, gx2);
        const maxY = Math.max(uy2, gy2);
        const unionW = Math.max(1, maxX - minX);
        const unionH = Math.max(1, maxY - minY);
        const area = unionW * unionH;
        const compactness = unionW / unionH + unionH / unionW; // >= 2, closer to 2 is squarer
        const cx = tlx + met.gridW / 2;
        const cy = tly + met.gridH / 2;
        const dx = cx - gx;
        const dy = cy - gy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const score = area + compactness * 1000 + dist * 10;
        cands.push({
          name,
          cols: cTry,
          tlx,
          tly,
          gridW: met.gridW,
          gridH: met.gridH,
          score,
          metric: met,
        });
      }
    }
    if (haveUngroupedBounds) {
      addCand("right", umaxX + margin, uminY);
      addCand("below", uminX, umaxY + margin);
      addCand("left", uminX - margin, uminY);
      addCand("above", uminX, uminY - margin);
    }
    // Choose the best side/cols combo; fallback to seed-centered square-ish if none
    let metric = computeMetrics(Math.max(1, Math.ceil(Math.sqrt(list.length))));
    let originTLX = snap(gx - metric.gridW / 2);
    let originTLY = snap(gy - metric.gridH / 2);
    if (cands.length) {
      const pref = { right: 0, below: 1, left: 2, above: 3 } as any;
      cands.sort(
        (a, b) =>
          a.score - b.score || pref[a.name] - pref[b.name] || a.cols - b.cols,
      );
      const best = cands[0];
      metric = best.metric;
      originTLX = best.tlx;
      originTLY = best.tly;
    }
    // Preferred: shelf packer minimizing union area of (ungrouped + groups). Fallback to metric grid.
    function packShelves(
      sizes: { w: number; h: number }[],
      binW: number,
      sepX: number,
      sepY: number,
    ) {
      const pos: { x: number; y: number }[] = new Array(sizes.length);
      let x = 0,
        y = 0,
        rowH = 0,
        maxWUsed = 0;
      let countInRow = 0;
      for (let i = 0; i < sizes.length; i++) {
        const r = sizes[i];
        const need = (countInRow > 0 ? sepX : 0) + r.w;
        if (countInRow > 0 && x + need > binW) {
          // new row
          y += rowH + sepY;
          x = 0;
          rowH = 0;
          countInRow = 0;
        }
        if (countInRow > 0) x += sepX;
        pos[i] = { x, y };
        x += r.w;
        if (x > maxWUsed) maxWUsed = x;
        if (r.h > rowH) rowH = r.h;
        countInRow++;
      }
      const usedH = y + rowH;
      return { positions: pos, usedW: maxWUsed, usedH };
    }
    let desiredSeeds: { x: number; y: number }[];
    if (haveUngroupedBounds) {
      type Best = {
        side: "right" | "below" | "left" | "above";
        tlx: number;
        tly: number;
        usedW: number;
        usedH: number;
        positions: { x: number; y: number }[];
        score: number;
      };
      let best: Best | null = null;
      const totalArea = list.reduce((a, g) => a + g.w * g.h, 0);
      const base = Math.sqrt(Math.max(1, totalArea));
      const scales = [0.6, 0.75, 0.9, 1.0, 1.15, 1.3, 1.5];
      const minWNeeded = Math.max(...list.map((g) => g.w));
      const sides: (
        | ["right", number, number]
        | ["below", number, number]
        | ["left", number, number]
        | ["above", number, number]
      )[] = [
        ["right", umaxX + margin, uminY],
        ["below", uminX, umaxY + margin],
        ["left", uminX - margin, uminY],
        ["above", uminX, uminY - margin],
      ];
      for (const [side, baseX, baseY] of sides) {
        for (const s of scales) {
          let targetW = Math.max(minWNeeded, Math.round(base * s));
          // Available width by side
          let availW = bnds.w;
          if (side === "right") availW = bnds.x + bnds.w - baseX;
          else if (side === "left") availW = baseX - bnds.x;
          else availW = bnds.w; // below/above can use full width; clamp later
          targetW = Math.max(minWNeeded, Math.min(targetW, availW));
          if (targetW < minWNeeded) continue;
          const packed = packShelves(
            list.map((g) => ({ w: g.w, h: g.h })),
            targetW,
            sepX,
            sepY,
          );
          // Proposed top-left before clamp by side
          let px = baseX,
            py = baseY;
          if (side === "left") px = baseX - packed.usedW;
          if (side === "above") py = baseY - packed.usedH;
          const { tlx, tly } = clampTL(px, py, packed.usedW, packed.usedH);
          // Reject overlap with ungrouped (tight) to keep separation
          const gx1 = tlx,
            gy1 = tly,
            gx2 = tlx + packed.usedW,
            gy2 = tly + packed.usedH;
          const ux1 = uminX,
            uy1 = uminY,
            ux2 = umaxX,
            uy2 = umaxY;
          const overlaps = !(
            gx2 <= ux1 ||
            gx1 >= ux2 ||
            gy2 <= uy1 ||
            gy1 >= uy2
          );
          if (overlaps) continue;
          // Score by union area + compactness + small distance to seed
          const minX = Math.min(ux1, gx1);
          const minY = Math.min(uy1, gy1);
          const maxX = Math.max(ux2, gx2);
          const maxY = Math.max(uy2, gy2);
          const unionW = Math.max(1, maxX - minX);
          const unionH = Math.max(1, maxY - minY);
          const area = unionW * unionH;
          const compactness = unionW / unionH + unionH / unionW;
          const cx = tlx + packed.usedW / 2;
          const cy = tly + packed.usedH / 2;
          const dx = cx - gx;
          const dy = cy - gy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const score = area + compactness * 1000 + dist * 10;
          if (!best || score < best.score) {
            best = {
              side,
              tlx,
              tly,
              usedW: packed.usedW,
              usedH: packed.usedH,
              positions: packed.positions,
              score,
            };
          }
        }
      }
      if (best) {
        const originTLX2 = best.tlx;
        const originTLY2 = best.tly;
        desiredSeeds = list.map((g, i) => {
          const p = best!.positions[i];
          return {
            x: originTLX2 + p.x + g.w / 2,
            y: originTLY2 + p.y + g.h / 2,
          };
        });
      } else {
        // fallback to metric grid
        desiredSeeds = list.map((g, i) => {
          const c = i % metric.cols;
          const r = Math.floor(i / metric.cols);
          const tlx = originTLX + metric.prefixX[c];
          const tly = originTLY + metric.prefixY[r];
          return { x: tlx + g.w / 2, y: tly + g.h / 2 };
        });
      }
    } else {
      // No ungrouped bounds; center grid by metric
      desiredSeeds = list.map((g, i) => {
        const c = i % metric.cols;
        const r = Math.floor(i / metric.cols);
        const tlx = originTLX + metric.prefixX[c];
        const tly = originTLY + metric.prefixY[r];
        return { x: tlx + g.w / 2, y: tly + g.h / 2 };
      });
    }
    const { positions } = planRectangles(rects, ctx, {
      seed: { x: gx, y: gy },
      pad: 16,
      labels,
      attractStrength: 0,
      preserveOrder: true,
      // Avoid treating the current groups as obstacles; we are replacing their positions
      excludeGroupIds: list.map((g) => g.id),
      excludeSpriteGroupIds: list.map((g) => g.id),
      obstacleMode: "cardsOnly",
      desiredSeeds,
    });
    const batch: { id: number; x: number; y: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      const gv = list[i];
      const p = positions[i];
      if (!p) continue;
      const newX = snap(p.x);
      const newY = snap(p.y);
      const dx = newX - gv.gfx.x;
      const dy = newY - gv.gfx.y;
      if (dx === 0 && dy === 0) continue;
      gv.gfx.x = newX;
      gv.gfx.y = newY;
      gv.order.forEach((cid) => {
        const sp = sprites.find((s) => s.__id === cid);
        if (!sp) return;
        sp.x = snap(sp.x + dx);
        sp.y = snap(sp.y + dy);
        spatial.update({
          id: sp.__id,
          minX: sp.x,
          minY: sp.y,
          maxX: sp.x + CARD_W_GLOBAL,
          maxY: sp.y + CARD_H_GLOBAL,
        });
        batch.push({ id: sp.__id, x: sp.x, y: sp.y });
      });
    }
    if (batch.length) {
      try {
        InstancesRepo.updatePositions(batch);
      } catch {}
    }
    if (!SUPPRESS_SAVES) {
      try {
        const data = {
          instances: sprites.map((s) => ({
            id: s.__id,
            x: s.x,
            y: s.y,
            z: s.zIndex || (s as any).__baseZ || 0,
            group_id: (s as any).__groupId ?? null,
            scryfall_id:
              (s as any).__scryfallId || ((s as any).__card?.id ?? null),
          })),
          byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
        };
        localStorage.setItem(LS_KEY, JSON.stringify(data));
      } catch {}
    }
  }
  ensureDebugPanel();

  // --- Smart placement helper for groups ---
  // Finds a non-overlapping spot for a group near an anchor (viewport top-left by default),
  // scanning left-to-right then top-to-bottom in shelf rows. Considers existing groups and loose cards.
  function placeGroupSmart(
    gv: GroupVisual,
    opts?: { anchor?: "view" | "centroid"; pad?: number },
  ) {
    const pad = opts?.pad ?? 16;
    // Determine anchor
    let startX = 0,
      startY = 0;
    if (opts?.anchor === "centroid") {
      // Use centroid of current members if available; fall back to view
      const ids = gv.order.slice();
      const members = ids
        .map((id) => sprites.find((s) => s.__id === id))
        .filter(Boolean) as CardSprite[];
      if (members.length) {
        const minX = Math.min(...members.map((s) => s.x));
        const minY = Math.min(...members.map((s) => s.y));
        startX = snap(minX);
        startY = snap(minY);
      } else {
        const invScale = 1 / world.scale.x;
        startX = snap(-world.position.x * invScale + 40);
        startY = snap(-world.position.y * invScale + 40);
      }
    } else {
      const invScale = 1 / world.scale.x;
      startX = snap(-world.position.x * invScale + 40);
      startY = snap(-world.position.y * invScale + 40);
    }
    // Collision test against existing groups and free cards
    function collides(x: number, y: number): boolean {
      const gx1 = x - pad,
        gy1 = y - pad,
        gx2 = x + gv.w + pad,
        gy2 = y + gv.h + pad;
      for (const eg of groups.values()) {
        if (eg.id === gv.id) continue;
        const x1 = eg.gfx.x - pad,
          y1 = eg.gfx.y - pad,
          x2 = eg.gfx.x + eg.w + pad,
          y2 = eg.gfx.y + eg.h + pad;
        if (gx1 < x2 && gx2 > x1 && gy1 < y2 && gy2 > y1) return true;
      }
      for (const s of sprites) {
        if ((s as any).__groupId === gv.id) continue;
        const x1 = s.x - 4,
          y1 = s.y - 4,
          x2 = s.x + CARD_W_GLOBAL + 4,
          y2 = s.y + CARD_H_GLOBAL + 4;
        if (gx1 < x2 && gx2 > x1 && gy1 < y2 && gy2 > y1) return true;
      }
      return false;
    }
    // Compute search steps so rows/columns feel tidy regardless of group size.
    const stepX = snap(Math.max(gv.w + 48, 320));
    const stepY = snap(Math.max(gv.h + 48, 260));
    const searchCols = 48;
    const searchRows = 48;
    let bestX = gv.gfx.x,
      bestY = gv.gfx.y;
    let found = false;
    outer: for (let row = 0; row < searchRows; row++) {
      for (let col = 0; col < searchCols; col++) {
        const x = snap(startX + col * stepX);
        const y = snap(startY + row * stepY);
        if (!collides(x, y)) {
          bestX = x;
          bestY = y;
          found = true;
          break outer;
        }
      }
    }
    if (!found) {
      // Fallback: place to the far right of current max extent
      let maxX = 0,
        minY = 0;
      let initialized = false;
      sprites.forEach((s) => {
        if (!initialized) {
          maxX = s.x + CARD_W_GLOBAL;
          minY = s.y;
          initialized = true;
        } else {
          if (s.x + CARD_W_GLOBAL > maxX) maxX = s.x + CARD_W_GLOBAL;
          if (s.y < minY) minY = s.y;
        }
      });
      groups.forEach((eg) => {
        if (eg.id === gv.id) return;
        if (eg.gfx.x + eg.w > maxX) maxX = eg.gfx.x + eg.w;
        if (eg.gfx.y < minY) minY = eg.gfx.y;
      });
      bestX = snap(maxX + 120);
      bestY = snap(minY);
    }
    // Clamp chosen position to canvas bounds so the full group frame stays inside
    const clamped = clampGroupXY(gv, bestX, bestY);
    const dx = clamped.x - gv.gfx.x;
    const dy = clamped.y - gv.gfx.y;
    if (dx || dy) {
      gv.gfx.x = clamped.x;
      gv.gfx.y = clamped.y;
      // Shift member cards with the group pre-layout so their relative ordering is preserved during initial paint
      for (const cid of gv.order) {
        const s = sprites.find((sp) => sp.__id === cid);
        if (s) {
          s.x += dx;
          s.y += dy;
          spatial.update({
            id: s.__id,
            minX: s.x,
            minY: s.y,
            maxX: s.x + CARD_W_GLOBAL,
            maxY: s.y + CARD_H_GLOBAL,
          });
        }
      }
    }
  }

  // (placement helpers moved to src/placement.ts)

  // Explicit hi-res upgrade pass: ensure visible cards promote quickly (not limited by LOAD_PER_FRAME small image loader)
  let hiResCursor = 0;
  function upgradeVisibleHiRes() {
    const scale = world.scale.x;
    // Detect if any group overlay is active; if so, clamp throughput and avoid upgrades for cards hidden by overlay
    let anyOverlay = false;
    try {
      groups.forEach((gv) => {
        if ((gv._lastZoomPhase || 0) > 0.5) anyOverlay = true;
      });
    } catch {}
    const visibles = sprites.filter(
      (s) => s.visible && s.__imgLoaded && !(s as any).__groupOverlayActive,
    );
    if (!visibles.length) return;
    // Adaptive throughput based on decode queue pressure
    const q = getDecodeQueueSize();
    // Base throughput
    let perFrame = anyOverlay ? 8 : 60;
    if (q > 600) perFrame = 10;
    else if (q > 400) perFrame = 20;
    else if (q > 200) perFrame = 40;
    else if (q < 50) perFrame = 80;
    if (anyOverlay) perFrame = Math.min(perFrame, 12);
    if (scale > 5) perFrame = 90;
    if (scale > 8) perFrame = 120;
    if (scale > 10) perFrame = 160;
    perFrame = Math.min(perFrame, visibles.length);
    // Boost priority for sprites at or near the viewport center to prevent starvation
    const cx = window.innerWidth / 2,
      cy = window.innerHeight / 2;
    const scored = visibles.map((s) => {
      const gp =
        (s.parent as any)?.toGlobal?.(new PIXI.Point(s.x, s.y)) ??
        new PIXI.Point(0, 0);
      const dx = gp.x - cx,
        dy = gp.y - cy;
      const dist2 = dx * dx + dy * dy;
      return { s, dist2 };
    });
    scored.sort((a, b) => a.dist2 - b.dist2);
    let processed = 0;
    // First pass: upgrade closest N, but stop early under extreme pressure
    const burst = q > 600 ? 4 : q > 400 ? 8 : 20;
    for (
      let i = 0;
      i < scored.length && processed < Math.min(burst, perFrame);
      i++
    ) {
      updateCardTextureForScale(scored[i].s, scale);
      processed++;
    }
    // Second pass: round-robin remainder to keep breadth
    for (let i = 0; i < visibles.length && processed < perFrame; i++) {
      hiResCursor = (hiResCursor + 1) % visibles.length;
      updateCardTextureForScale(visibles[hiResCursor], scale);
      processed++;
    }
  }

  // Hotkey: press 'U' to force immediate hi-res request for all visible cards
  window.addEventListener("keydown", (e) => {
    // If typing in an input/textarea/contentEditable, allow native editing keys (arrows, Ctrl+A, etc.)
    const active = document.activeElement as HTMLElement | null;
    const editing =
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable);
    // Skip global handlers that would conflict with text editing
    if (editing) {
      // Allow palette-specific Esc (handled elsewhere) and Enter (handled in palette) to bubble.
      // Prevent canvas-wide shortcuts below from firing while editing.
      // Exceptions: Ctrl+F still opens new search (avoid recursion) so if already in search input ignore.
      if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) return; // let browser select-all
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key))
        return; // let caret move
      if (
        (e.key === "g" || e.key === "G") &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      )
        return; // prevent accidental group creation
      if ((e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey)) return; // rely on browser find when inside other inputs (search palette already overrides inside itself)
    }
    // Search palette open shortcuts
    // Ctrl/Cmd+F: open search (override default find) when not in another input
    if (
      (e.key === "f" || e.key === "F") &&
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      searchUI.show("");
      return; // prevent falling through to fit logic below
    }
    // '/' quick open (common in web apps). Ignore if typing inside an editable element.
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement | null;
      const editingTarget =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (!editingTarget) {
        e.preventDefault();
        searchUI.show("");
        return;
      }
    }
    if (e.key === "u" || e.key === "U") {
      const scale = world.scale.x;
      sprites.forEach((s) => {
        if (s.visible && s.__imgLoaded) updateCardTextureForScale(s, scale);
      });
    }
  });

  installModeToggle();

  // Centralized clear function used by Debug and Import/Export integration
  async function clearAllData(): Promise<void> {
    // Clear persisted artifacts
    SUPPRESS_SAVES = true;
    try {
      if (lsTimer) {
        clearTimeout(lsTimer);
        lsTimer = null;
      }
    } catch {}
    try {
      if (lsGroupsTimer) {
        clearTimeout(lsGroupsTimer);
        lsGroupsTimer = null;
      }
    } catch {}
    try {
      await clearImageCache();
    } catch {}
    try {
      await clearImportedCards();
    } catch {}
    try {
      localStorage.removeItem(LS_KEY);
    } catch {}
    try {
      localStorage.removeItem(LS_GROUPS_KEY);
    } catch {}
    try {
      (window as any).indexedDB?.deleteDatabase?.("mtgCanvas");
    } catch {}
    try {
      (window as any).indexedDB?.deleteDatabase?.("mtgImageCache");
    } catch {}
    try {
      const instIds = (InstancesRepo.list() || [])
        .map((r: any) => r.id)
        .filter((n: any) => typeof n === "number");
      if (instIds.length) InstancesRepo.deleteMany(instIds);
      const grpIds = (GroupsRepo.list() || [])
        .map((g: any) => g.id)
        .filter((n: any) => typeof n === "number");
      if (grpIds.length) GroupsRepo.deleteMany(grpIds);
    } catch {}
    try {
      sessionStorage.setItem("mtgcanvas_start_empty_once", "1");
    } catch {}
  }

  // Import/Export decklists (basic)
  const importExportUI = installImportExport({
    getAllNames: () => sprites.map((s) => (s as any).__card?.name || ""),
    getSelectedNames: () =>
      SelectionStore.getCards()
        .map((id) => sprites.find((s) => s.__id === id))
        .filter(Boolean)
        .map((s) => (s as any).__card?.name || ""),
    getGroupsExportScoped: (scope) => {
      const considerAll = scope === "all";
      const selected = new Set<number>(SelectionStore.getCards());
      const isSel = (id: number) => considerAll || selected.has(id);
      const lines: string[] = [];
      const grouped = [...groups.values()].sort((a, b) => a.id - b.id);
      let anyGroupPrinted = false;
      for (const gv of grouped) {
        // Collect names from selected members of this group (or all if scope=all)
        const names = gv.order
          .map((cid) =>
            isSel(cid) ? sprites.find((s) => s.__id === cid) : null,
          )
          .filter(Boolean)
          .map((s) => {
            const raw = ((s as any).__card?.name || "").trim();
            const i = raw.indexOf("//");
            return i >= 0 ? raw.slice(0, i).trim() : raw;
          })
          .filter((n) => n);
        if (!names.length) continue; // skip empty groups in selection scope
        const title = gv.name || `Group ${gv.id}`;
        lines.push(`# ${title}`);
        // Aggregate counts preserving first-seen order
        const order: string[] = [];
        const counts = new Map<string, number>();
        for (const n of names) {
          if (!counts.has(n)) order.push(n);
          counts.set(n, (counts.get(n) || 0) + 1);
        }
        for (const n of order) {
          const c = counts.get(n) || 1;
          lines.push(`${c} ${n}`);
        }
        lines.push("");
        anyGroupPrinted = true;
      }
      // Ungrouped
      const ungroupedNames: string[] = [];
      for (const s of sprites) {
        if ((s as any).__groupId) continue;
        if (!isSel(s.__id)) continue;
        const raw = ((s as any).__card?.name || "").trim();
        const i = raw.indexOf("//");
        const n = i >= 0 ? raw.slice(0, i).trim() : raw;
        if (n) ungroupedNames.push(n);
      }
      // Aggregate counts preserving order
      const orderU: string[] = [];
      const countsU = new Map<string, number>();
      for (const n of ungroupedNames) {
        if (!countsU.has(n)) orderU.push(n);
        countsU.set(n, (countsU.get(n) || 0) + 1);
      }
      const ungroupedLines = orderU.map((n) => `${countsU.get(n) || 1} ${n}`);
      if (anyGroupPrinted) {
        lines.push("#ungrouped");
        if (!ungroupedLines.length) lines.push("(none)");
        else lines.push(...ungroupedLines);
      } else {
        if (ungroupedLines.length) lines.push(...ungroupedLines);
      }
      return lines.join("\n");
    },
    getGroupsExport: () => {
      // Build groups lines
      const lines: string[] = [];
      const grouped = [...groups.values()].sort((a, b) => a.id - b.id);
      grouped.forEach((gv) => {
        const title = gv.name || `Group ${gv.id}`;
        lines.push(`# ${title}`);
        // Members in current order by id
        const names = gv.order
          .map((cid) => sprites.find((s) => s.__id === cid))
          .filter(Boolean)
          .map((s) => {
            const raw = ((s as any).__card?.name || "").trim();
            const i = raw.indexOf("//");
            return i >= 0 ? raw.slice(0, i).trim() : raw;
          })
          .filter((n) => n);
        if (!names.length) {
          lines.push("(empty)");
        } else {
          // Aggregate counts while preserving first-seen order
          const order: string[] = [];
          const counts = new Map<string, number>();
          for (const n of names) {
            if (!counts.has(n)) order.push(n);
            counts.set(n, (counts.get(n) || 0) + 1);
          }
          for (const n of order) {
            const c = counts.get(n) || 1;
            lines.push(`${c} ${n}`);
          }
        }
        lines.push("");
      });
      // Ungrouped (conditionally add header)
      const ungrouped = sprites.filter((s) => !(s as any).__groupId);
      // Build name list and aggregate counts preserving order
      const order: string[] = [];
      const counts = new Map<string, number>();
      for (const s of ungrouped) {
        const raw = ((s as any).__card?.name || "").trim();
        const i = raw.indexOf("//");
        const n = i >= 0 ? raw.slice(0, i).trim() : raw;
        if (!n) continue;
        if (!counts.has(n)) order.push(n);
        counts.set(n, (counts.get(n) || 0) + 1);
      }
      const ungroupedLines = order.map((n) => `${counts.get(n) || 1} ${n}`);
      if (grouped.length > 0) {
        lines.push("#ungrouped");
        if (!ungroupedLines.length) lines.push("(none)");
        else lines.push(...ungroupedLines);
      } else {
        // No groups: just output the ungrouped lines without a header
        if (ungroupedLines.length) lines.push(...ungroupedLines);
      }
      return lines.join("\n");
    },
    importGroups: async (data, opt) => {
      // Build lookup by lowercase name from currently loaded sprites; extend by fetching from Scryfall if needed.
      const byName = new Map<string, any>();
      for (const s of sprites) {
        const c = (s as any).__card;
        if (!c) continue;
        const nm = (c.name || "").toLowerCase();
        if (nm && !byName.has(nm)) byName.set(nm, c);
      }
      // Collect original input names preserving user casing for better error messages
      const allInputNames: string[] = [
        ...data.groups.flatMap((g) => g.cards),
        ...data.ungrouped,
      ].filter((n) => typeof n === "string" && n.trim().length);
      // Resolve missing names using Scryfall collection API
      let unknown: string[] = [];
      const unresolvedOriginal = allInputNames.filter(
        (n) => !byName.has((n || "").toLowerCase()),
      );
      if (unresolvedOriginal.length) {
        try {
          const { byName: fetched, unknown: notFound } =
            await fetchScryfallByNames(unresolvedOriginal, {
              signal: (opt as any)?.signal,
              onProgress: opt?.onProgress,
            });
          // Merge into byName map
          fetched.forEach((card, key) => {
            if (!byName.has(key)) byName.set(key, card);
          });
          // Compute unknowns based on what remains unresolved
          const notFoundSet = new Set<string>(notFound);
          unknown = unresolvedOriginal.filter((n) =>
            notFoundSet.has(n.toLowerCase()),
          );
        } catch (e) {
          console.warn("[importGroups] scryfall collection failed", e);
          // If the fetch failed entirely, mark all unresolved as unknown
          unknown = unresolvedOriginal.slice();
        }
      }
      // Helper to create instances for a list of names
      function resolveCards(names: string[]): any[] {
        return names
          .map((n) => byName.get((n || "").toLowerCase()))
          .filter(Boolean);
      }
      const groupDefs = data.groups.map((g) => ({
        name: g.name || "Group",
        cards: resolveCards(g.cards),
      }));
      const ungroupedCards = resolveCards(data.ungrouped);
      // unknown was already computed from Scryfall not_found (if any).
      let imported = 0;
      // Create groups with cards
      for (const g of groupDefs) {
        if (!g.cards.length) continue;
        // Create instances for these cards; leverage existing placement/group helper
        const ids: number[] = [];
        let maxId = sprites.length
          ? Math.max(...sprites.map((s) => s.__id))
          : 0;
        // Place temporarily at origin (they’ll be moved by group placement helper)
        for (const card of g.cards) {
          let id: number;
          const x = 0,
            y = 0;
          try {
            id = InstancesRepo.create(1, x, y);
          } catch {
            id = ++maxId;
          }
          const sp = createSpriteForInstance({ id, x, y, z: zCounter++, card });
          ensureCardImage(sp);
          ids.push(sp.__id);
          imported++;
        }
        try {
          if (ids.length) (createGroupWithCardIds as any)(ids, g.name);
        } catch {}
      }
      // Place ungrouped cards using the shared import planner (flow-around when applicable)
      if (ungroupedCards.length) {
        const planned = planImportPositions(
          ungroupedCards.length,
          buildPlacementContext(),
        );
        const positions = planned.positions;
        let maxId = sprites.length
          ? Math.max(...sprites.map((s) => s.__id))
          : 0;
        const bulkItems = positions.map(
          ({ x, y }: { x: number; y: number }, i: number) => {
            let id: number;
            try {
              id = InstancesRepo.create(1, x, y);
            } catch {
              id = ++maxId;
            }
            return { id, x, y, z: zCounter++, card: ungroupedCards[i] };
          },
        );
        const made = createSpritesBulk(bulkItems);
        made.forEach((s) => ensureCardImage(s));
        imported += made.length;
        camera.fitBounds(planned.block, {
          w: window.innerWidth,
          h: window.innerHeight,
        });
      }
      // Persist raw imported cards for rehydration
      try {
        const allCards: any[] = [
          ...groupDefs.flatMap((g) => g.cards),
          ...ungroupedCards,
        ];
        if (allCards.length) {
          await addImportedCards(allCards);
        }
      } catch {}
      // Persist positions
      try {
        if (!SUPPRESS_SAVES) {
          const data = {
            instances: sprites.map((s) => ({
              id: s.__id,
              x: s.x,
              y: s.y,
              z: s.zIndex || (s as any).__baseZ || 0,
              group_id: (s as any).__groupId ?? null,
              scryfall_id:
                (s as any).__scryfallId || ((s as any).__card?.id ?? null),
            })),
            byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
          };
          localStorage.setItem(LS_KEY, JSON.stringify(data));
        }
      } catch {}
      return { imported, unknown };
    },
    importByNames: async (items, opt) => {
      // Build lookup from currently loaded sprites by lowercase name -> card object
      const byName = new Map<string, any>();
      for (const s of sprites) {
        const c = (s as any).__card;
        if (!c) continue;
        const nm = (c.name || "").toLowerCase();
        if (nm && !byName.has(nm)) byName.set(nm, c);
      }
      let unknown: string[] = [];
      // Prepare placement variables (anchor computed after we know total count)
      // Choose near-square grid for the deck block; adjust after we know total count
      let placed = 0;
      let maxId = sprites.length ? Math.max(...sprites.map((s) => s.__id)) : 0;
      const created: CardSprite[] = [];
      const toPlace: { card: any; count: number }[] = [];
      const originalUnknown: string[] = [];
      for (const it of items) {
        const card = byName.get((it.name || "").toLowerCase());
        if (!card) {
          originalUnknown.push(it.name);
          continue;
        }
        toPlace.push({ card, count: Math.max(1, Math.min(999, it.count | 0)) });
      }
      // If any names weren't found locally, fetch them from Scryfall
      if (originalUnknown.length) {
        try {
          const { byName: fetched } = await fetchScryfallByNames(
            originalUnknown,
            {
              signal: (opt as any)?.signal,
              onProgress: opt?.onProgress,
            },
          );
          fetched.forEach((card, key) => {
            if (!byName.has(key)) byName.set(key, card);
          });
          // Re-check unresolved and enqueue for placement
          for (const nm of originalUnknown) {
            const card = byName.get((nm || "").toLowerCase());
            if (card) toPlace.push({ card, count: 1 });
          }
          // Now compute still-unknown by comparing items again
          unknown = originalUnknown.filter(
            (nm) => !byName.has((nm || "").toLowerCase()),
          );
        } catch (e) {
          console.warn("[importByNames] scryfall collection failed", e);
          unknown = originalUnknown.slice();
        }
      }
      // Decide final block anchor and plan positions
      const totalToPlace = toPlace.reduce((sum, p) => sum + p.count, 0);
      const { positions: planned, block: blk } = planImportPositions(
        totalToPlace,
        buildPlacementContext(),
      );
      const persistedCards: any[] = [];
      // Pre-allocate instance records and build bulk creation list
      const bulkItems: {
        id: number;
        x: number;
        y: number;
        z: number;
        card: any;
      }[] = [];
      for (const pl of toPlace) {
        for (let i = 0; i < pl.count; i++) {
          const pos = planned[placed++];
          const x = pos.x,
            y = pos.y;
          let id: number;
          try {
            id = InstancesRepo.create(1, x, y);
          } catch {
            id = ++maxId;
          }
          bulkItems.push({ id, x, y, z: zCounter++, card: pl.card });
          persistedCards.push(pl.card);
        }
      }
      const bulkSprites = createSpritesBulk(bulkItems);
      created.push(...bulkSprites);
      // Persist raw imported cards so they rehydrate on reload
      try {
        if (persistedCards.length) await addImportedCards(persistedCards);
      } catch {}
      try {
        if (!SUPPRESS_SAVES) {
          const data = {
            instances: sprites.map((s) => ({
              id: s.__id,
              x: s.x,
              y: s.y,
              group_id: (s as any).__groupId ?? null,
              scryfall_id:
                (s as any).__scryfallId || ((s as any).__card?.id ?? null),
            })),
            byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
          };
          localStorage.setItem(LS_KEY, JSON.stringify(data));
        }
      } catch {}
      // Fit to planned block for predictable framing
      if (created.length) {
        camera.fitBounds(blk, { w: window.innerWidth, h: window.innerHeight });
      }
      return { imported: created.length, unknown };
    },
    scryfallSearchAndPlace: async (query, opt) => {
      // Prevent overlapping runs at the backend level as well
      const anyWin = window as any;
      if (anyWin.__mtg_scry_inflight) {
        return {
          imported: 0,
          error: "Another Scryfall import is already in progress.",
        };
      }
      try {
        anyWin.__mtg_scry_inflight = true;
        // Fetch cards from Scryfall with paging
        const cards = await searchScryfall(query, {
          maxCards: opt.maxCards,
          signal: (opt as any).signal,
          onProgress: (n, total) => {
            opt.onProgress?.(n, total);
            if (n % 60 === 0)
              console.log("[scryfall] fetched", n, total ? `/ ${total}` : "");
          },
        });
        if (!cards.length) return { imported: 0 };
        // Create sprites for results
        const created: CardSprite[] = [];
        let maxId = sprites.length
          ? Math.max(...sprites.map((s) => s.__id))
          : 0;
        const total = cards.length;
        const planned = planImportPositions(total, buildPlacementContext());
        const positions = planned.positions;
        // Fallback: if positions fewer than total, append clamped viewport-origin grid
        const need = total - positions.length;
        if (need > 0) {
          const { cols, w, h } = computeBestGrid(need, buildPlacementContext());
          const invScale = 1 / world.scale.x;
          let sx = snap(-world.position.x * invScale + 40);
          let sy = snap(-world.position.y * invScale + 40);
          const b2 = getCanvasBounds();
          sx = Math.min(Math.max(b2.x, sx), b2.x + b2.w - w);
          sy = Math.min(Math.max(b2.y, sy), b2.y + b2.h - h);
          for (let i = 0; i < need; i++) {
            const c = i % cols;
            const r = Math.floor(i / cols);
            positions.push({ x: sx + c * SPACING_X, y: sy + r * SPACING_Y });
          }
        }
        // Bulk create
        const bulkItems = positions.map(
          ({ x, y }: { x: number; y: number }, i: number) => {
            let id: number;
            try {
              id = InstancesRepo.create(1, x, y);
            } catch {
              id = ++maxId;
            }
            return { id, x, y, z: zCounter++, card: cards[i] };
          },
        );
        const bulkSprites = createSpritesBulk(bulkItems);
        created.push(...bulkSprites);
        // Persist raw imported cards so they rehydrate on reload
        try {
          await addImportedCards(cards);
        } catch {}
        // Persist positions
        try {
          if (!SUPPRESS_SAVES) {
            const data = {
              instances: sprites.map((s) => ({ id: s.__id, x: s.x, y: s.y })),
              byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
            };
            localStorage.setItem(LS_KEY, JSON.stringify(data));
          }
        } catch {}
        // Fit to planned block
        if (created.length) {
          camera.fitBounds(planned.block, {
            w: window.innerWidth,
            h: window.innerHeight,
          });
        }
        return { imported: created.length };
      } catch (e: any) {
        console.warn("[scryfall] search failed", e);
        return { imported: 0, error: e?.message || String(e) };
      } finally {
        const anyWin2 = window as any;
        delete anyWin2.__mtg_scry_inflight;
      }
    },
    clearPersistedData: clearAllData,
  });

  // Import/Export FAB (top-right, beneath Help FAB)
  function ensureImportExportFab() {
    if (document.getElementById("ie-fab")) return;
    // Reuse the help FAB bar if present; otherwise create it
    let bar = document.getElementById("top-fab-bar") as HTMLDivElement | null;
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "top-fab-bar";
      bar.style.cssText =
        "position:fixed;top:16px;right:16px;display:flex;flex-direction:row-reverse;gap:12px;align-items:center;z-index:9999;";
      document.body.appendChild(bar);
    }
    const fab = document.createElement("div");
    fab.id = "ie-fab";
    fab.title = "Import / Export (Ctrl+I)";
    // Rotated previous glyph; wrap in a flex box to ensure perfect centering, and bump size slightly
    fab.innerHTML =
      '<span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;">\
        <span style="display:inline-block;transform:rotate(90deg);transform-origin:50% 50%;font-size:32px;line-height:1;margin-left:3px;">⇄</span>\
      </span>';
    fab.style.cssText =
      "position:relative;width:56px;height:56px;border-radius:50%;background:var(--fab-bg);color:var(--fab-fg);border:1px solid var(--fab-border);display:flex;align-items:center;justify-content:center;font:32px/1 var(--panel-font);text-align:center;cursor:pointer;user-select:none;box-shadow:var(--panel-shadow);";
    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      pinned = !pinned;
      if (pinned) {
        try {
          (importExportUI as any).show();
        } catch {}
      } else {
        scheduleHide();
      }
    });
    // Hover-to-open like help FAB
    let hover = false;
    let pinned = false;
    let hideTimer: any = null;
    let wiredPanel = false;
    function scheduleHide() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!hover && !pinned) {
          try {
            (importExportUI as any).hide();
          } catch {}
        }
      }, 250);
    }
    function wirePanelHover() {
      if (wiredPanel) return;
      const panel = document.getElementById(
        "import-export-panel",
      ) as HTMLDivElement | null;
      if (!panel) return;
      wiredPanel = true;
      panel.addEventListener("mouseenter", () => {
        hover = true;
        try {
          (importExportUI as any).show();
        } catch {}
      });
      panel.addEventListener("mouseleave", () => {
        hover = false;
        scheduleHide();
      });
    }
    fab.addEventListener("mouseenter", () => {
      hover = true;
      // Notify others to close
      try {
        window.dispatchEvent(
          new CustomEvent("mtg:fabs:open", { detail: { id: "import" } }),
        );
      } catch {}
      try {
        (importExportUI as any).show();
      } catch {}
      // Ensure we wire hover handlers to the panel once it's in the DOM
      setTimeout(wirePanelHover, 0);
    });
    fab.addEventListener("mouseleave", () => {
      hover = false;
      scheduleHide();
    });
    // Close when another FAB opens
    window.addEventListener(
      "mtg:fabs:open",
      (ev: any) => {
        if (!ev || ev.detail?.id === "import") return;
        pinned = false;
        hover = false;
        try {
          (importExportUI as any).hide();
        } catch {}
      },
      { capture: true },
    );
    bar.appendChild(fab);
  }
  ensureImportExportFab();

  // Global shortcut: Ctrl/Cmd+I opens Import/Export (ignore when typing in inputs)
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "i" || e.key === "I")) {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        try {
          (importExportUI as any).show();
        } catch {}
      }
    },
    { capture: true },
  );
  // Search palette setup
  const searchUI = installSearchPalette({
    getSprites: () => sprites,
    createGroupForSprites: (ids: number[], name: string) => {
      let id = groups.size ? Math.max(...groups.keys()) + 1 : 1;
      try {
        id = (GroupsRepo as any).create
          ? (GroupsRepo as any).create(name, null, 0, 0, 300, 300)
          : id;
      } catch {}
      const gv = createGroupVisual(id, 0, 0, 300, 300);
      gv.name = name;
      groups.set(id, gv);
      world.addChild(gv.gfx);
      attachResizeHandle(gv);
      attachGroupInteractions(gv);
      const touchedOld = new Set<number>();
      ids.forEach((cid) => {
        const s = sprites.find((sp) => sp.__id === cid);
        if (!s) return;
        if (s.__groupId && s.__groupId !== gv.id) {
          const old = groups.get(s.__groupId);
          if (old) {
            removeCardFromGroup(old, s.__id);
            touchedOld.add(old.id);
          }
        }
        addCardToGroupOrdered(gv, cid, gv.order.length);
        (s as any).__groupId = gv.id;
      });
      try {
        InstancesRepo.updateMany(
          ids.map((cid) => ({ id: cid, group_id: gv.id })),
        );
      } catch {}
      // Auto-pack to minimize height (balanced grid close to square)
      autoPackGroup(gv, sprites, (s) =>
        spatial.update({
          id: s.__id,
          minX: s.x,
          minY: s.y,
          maxX: s.x + 100,
          maxY: s.y + 140,
        }),
      );
      // Update any old groups that lost members
      touchedOld.forEach((gid) => {
        const og = groups.get(gid);
        if (!og) return;
        ensureGroupEncapsulates(og, sprites);
        updateGroupMetrics(og, sprites);
        drawGroup(og, SelectionStore.state.groupIds.has(og.id));
      });
      updateGroupMetrics(gv, sprites);
      drawGroup(gv, false);
      // Non-overlapping placement using the shared helper; anchor near selection centroid
      placeGroupSmart(gv, { anchor: "centroid" });
      scheduleGroupSave();
      // Fit new group into view
      const b = { x: gv.gfx.x, y: gv.gfx.y, w: gv.w, h: gv.h };
      camera.fitBounds(b, { w: window.innerWidth, h: window.innerHeight });
      try {
        persistGroupTransform(gv.id, {
          x: gv.gfx.x,
          y: gv.gfx.y,
          w: gv.w,
          h: gv.h,
        });
      } catch {}
    },
    focusSprite: (id: number) => {
      const s = sprites.find((sp) => sp.__id === id);
      if (!s) return;
      // Center camera on sprite without changing zoom drastically.
      const target = { x: s.x, y: s.y, w: 100, h: 140 };
      camera.fitBounds(target, { w: window.innerWidth, h: window.innerHeight });
    },
  });

  // --- Utility: create a new group from a list of card names ---
  function createGroupWithCardIds(
    ids: number[],
    name: string,
    options?: { silent?: boolean },
  ) {
    if (!ids.length) return;
    let id = groups.size ? Math.max(...groups.keys()) + 1 : 1;
    try {
      id = (GroupsRepo as any).create
        ? (GroupsRepo as any).create(name, null, 0, 0, 300, 300)
        : id;
    } catch {}
    const gv = createGroupVisual(id, 0, 0, 300, 300);
    gv.name = name;
    groups.set(id, gv);
    world.addChild(gv.gfx);
    attachResizeHandle(gv);
    attachGroupInteractions(gv);
    const touchedOld = new Set<number>();
    ids.forEach((cid) => {
      const s = sprites.find((sp) => sp.__id === cid);
      if (!s) return;
      if (s.__groupId && s.__groupId !== gv.id) {
        const old = groups.get(s.__groupId);
        if (old) {
          removeCardFromGroup(old, s.__id);
          touchedOld.add(old.id);
        }
      }
      addCardToGroupOrdered(gv, cid, gv.order.length);
      (s as any).__groupId = gv.id;
    });
    try {
      InstancesRepo.updateMany(
        ids.map((cid) => ({ id: cid, group_id: gv.id })),
      );
    } catch {}
    // Smart non-overlapping placement near current view
    placeGroupSmart(gv, { anchor: "centroid" });
    // Now size and layout the group at its final position
    autoPackGroup(gv, sprites, (s) =>
      spatial.update({
        id: s.__id,
        minX: s.x,
        minY: s.y,
        maxX: s.x + CARD_W_GLOBAL,
        maxY: s.y + CARD_H_GLOBAL,
      }),
    );
    touchedOld.forEach((gid) => {
      const og = groups.get(gid);
      if (!og) return;
      ensureGroupEncapsulates(og, sprites);
      updateGroupMetrics(og, sprites);
      drawGroup(og, SelectionStore.state.groupIds.has(og.id));
    });
    updateGroupMetrics(gv, sprites);
    drawGroup(gv, false);
    // Save and optionally fit
    scheduleGroupSave();
    if (!options?.silent) {
      const b = { x: gv.gfx.x, y: gv.gfx.y, w: gv.w, h: gv.h };
      camera.fitBounds(b, { w: window.innerWidth, h: window.innerHeight });
    }
    try {
      persistGroupTransform(gv.id, {
        x: gv.gfx.x,
        y: gv.gfx.y,
        w: gv.w,
        h: gv.h,
      });
    } catch {}
  }

  // Camera animation update loop (no animations scheduled yet; placeholder for future animateTo usage)
  let last = performance.now();
  // Basic culling (placeholder): hide sprites far outside viewport (>2x viewport bounds)
  function runCulling() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 200; // allow some slack
    const invScale = 1 / world.scale.x;
    const left = -world.position.x * invScale - margin;
    const top = -world.position.y * invScale - margin;
    const right = left + vw * invScale + margin * 2;
    const bottom = top + vh * invScale + margin * 2;
    const now = performance.now();
    for (const s of sprites) {
      const vis =
        s.x + CARD_W_GLOBAL >= left &&
        s.x <= right &&
        s.y + CARD_H_GLOBAL >= top &&
        s.y <= bottom;
      if (vis !== s.visible) {
        s.renderable = vis;
        s.visible = vis; // toggle both for safety
        const anyS: any = s as any;
        if (!vis) anyS.__hiddenAt = now;
        else if (anyS.__hiddenAt) anyS.__hiddenAt = undefined;
      }
    }
  }

  // Lazy image loader: load some visible card images each frame
  let imgCursor = 0;
  let LOAD_PER_FRAME = 70; // adaptive prefetch budget
  function loadVisibleImages() {
    const len = sprites.length;
    if (!len) return;
    let loaded = 0;
    let attempts = 0;
    // Adapt based on decode queue size
    const q = getDecodeQueueSize();
    if (q > 400) LOAD_PER_FRAME = 20;
    else if (q > 200) LOAD_PER_FRAME = 40;
    else if (q < 50) LOAD_PER_FRAME = 90;
    else LOAD_PER_FRAME = 70;
    const scale = world.scale.x;
    // Compute an expanded culling rect to prefetch just-outside cards
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const inv = 1 / scale;
    const pad = 300; // prefetch margin
    const left = -world.position.x * inv - pad;
    const top = -world.position.y * inv - pad;
    const right = left + vw * inv + pad * 2;
    const bottom = top + vh * inv + pad * 2;
    while (loaded < LOAD_PER_FRAME && attempts < len) {
      imgCursor = (imgCursor + 1) % len;
      attempts++;
      const s = sprites[imgCursor];
      if (!s.__card) continue;
      // Prefetch if in expanded bounds
      const inPrefetch =
        s.x + CARD_W_GLOBAL >= left &&
        s.x <= right &&
        s.y + CARD_H_GLOBAL >= top &&
        s.y <= bottom;
      if (!inPrefetch) continue;
      if (!s.__imgLoaded) {
        if ((s as any).__groupOverlayActive) continue; // don't kick base loads for hidden-by-overlay items at macro zoom
        ensureCardImage(s);
        loaded++;
      } else {
        if (!(s as any).__groupOverlayActive)
          updateCardTextureForScale(s, scale);
      }
    }
  }

  app.ticker.add(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    camera.update(dt);
    runCulling();
    loadVisibleImages();
    upgradeVisibleHiRes();
    // Build a per-frame id->sprite map to avoid repeated array scans in hot paths
    const idToSprite: Map<number, CardSprite> = new Map();
    for (const s of sprites) idToSprite.set(s.__id, s);
    // Build a hidden reference used by groupNode to speed lookups
    (window as any).__mtgIdToSprite = idToSprite;
    // Enforce GPU budget by demoting offscreen sprites when over the cap
    try {
      enforceGpuBudgetForSprites(sprites);
    } catch {}
    groups.forEach((gv) => {
      updateGroupTextQuality(gv, world.scale.x);
      updateGroupZoomPresentation(gv, world.scale.x, sprites);
    });
    updatePerf();
  });
  // Periodically ensure any new sprites have context listeners
  setInterval(() => {
    try {
      ensureCardContextListeners();
    } catch {}
  }, 2000);
  window.addEventListener("beforeunload", () => {
    try {
      if (!SUPPRESS_SAVES) persistLocalPositions();
    } catch {}
    try {
      // flush any pending group save immediately
      const anyWin: any = window;
      if (anyWin.lsGroupsTimer) {
        clearTimeout(anyWin.lsGroupsTimer);
      }
      // direct call ensures groups saved even if debounce pending (unless suppressed)
      if (!SUPPRESS_SAVES)
        (function () {
          try {
            const data = {
              groups: [...groups.values()].map((gv) => ({
                id: gv.id,
                x: gv.gfx.x,
                y: gv.gfx.y,
                w: gv.w,
                h: gv.h,
                z: gv.gfx.zIndex || 0,
                name: gv.name,
                collapsed: gv.collapsed,
                // color and faceted layout retired; theme-driven only
                membersById: gv.order.slice(),
                membersByIndex: gv.order
                  .map((cid) => sprites.findIndex((s) => s.__id === cid))
                  .filter((i) => i >= 0),
              })),
            };
            localStorage.setItem(LS_GROUPS_KEY, JSON.stringify(data));
          } catch {}
        })();
    } catch {}
  });

  // Global Help hotkey removed; keep Ctrl+I import/export intact elsewhere.
})();
