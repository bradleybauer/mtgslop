import * as PIXI from "pixi.js";
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
  layoutFaceted,
  type FacetKind,
} from "./scene/groupNode";
import { SpatialIndex } from "./scene/SpatialIndex";
import { MarqueeSystem } from "./interaction/marquee";
import { initHelp } from "./ui/helpPanel";
import { installModeToggle } from "./ui/modeToggle";
import { UIState } from "./state/uiState";
import {
  loadAll,
  queuePosition,
  persistGroupTransform,
  persistGroupRename,
} from "./services/persistenceService";
import { InstancesRepo, GroupsRepo } from "./data/repositories";
import { spawnLargeSet, parseUniverseText } from "./services/largeDataset";
// Dataset constants referenced in logs only in dataset service; no usage here
import {
  ensureThemeToggleButton,
  ensureThemeStyles,
  registerThemeListener,
} from "./ui/theme";
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

const app = new PIXI.Application();
// Splash management: keep canvas hidden until persisted layout + groups are restored
const splashEl = document.getElementById("splash");
(async () => {
  await app.init({
    background: "#1e1e1e",
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
  });
  function applyCanvasBg() {
    try {
      const css = getComputedStyle(document.documentElement);
      const bg = css.getPropertyValue("--canvas-bg").trim();
      if (bg) {
        const hex = (PIXI as any).utils?.string2hex
          ? (PIXI as any).utils.string2hex(bg)
          : Number("0x" + bg.replace("#", ""));
        app.renderer.background.color = hex;
      }
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
  app.stage.hitArea = new PIXI.Rectangle(-50000, -50000, 100000, 100000);

  // Top-of-canvas banner: MTG Slop (fixed to screen, above world)
  const bannerLayer = new PIXI.Container();
  bannerLayer.zIndex = 1000000; // above everything
  bannerLayer.eventMode = "none"; // ignore pointer events
  app.stage.addChild(bannerLayer);
  // Ensure stage sorts by zIndex
  (app.stage as any).sortableChildren = true;
  const bannerText = new PIXI.Text("MTG Slop", {
    fill: 0x88d1ff as any,
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: "800" as any,
    fontSize: 64,
    dropShadow: true,
    dropShadowColor: 0x000000 as any,
    dropShadowBlur: 1,
    dropShadowDistance: 2,
    align: "left",
  } as any);
  bannerText.alpha = 0.9;
  bannerLayer.addChild(bannerText);
  function layoutBanner() {
    const padX = 16;
    const padY = 12;
    bannerText.x = padX;
    bannerText.y = padY;
  }
  layoutBanner();
  window.addEventListener("resize", layoutBanner);

  // Camera abstraction
  const camera = new Camera({ world });
  const spatial = new SpatialIndex();

  // Card layer & data (persisted instances)
  const sprites: CardSprite[] = [];
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
      z: inst.z ?? zCounter++,
      renderer: app.renderer,
      card: inst.card,
    });
    if (inst.group_id) (s as any).__groupId = inst.group_id;
    // Flag for context / pan logic
    (s as any).__cardSprite = true;
    world.addChild(s);
    sprites.push(s);
    spatial.insert({
      id: s.__id,
      minX: s.x,
      minY: s.y,
      maxX: s.x + 100,
      maxY: s.y + 140,
    });
    attachCardInteractions(
      s,
      () => sprites,
      world,
      app.stage,
      (moved) =>
        moved.forEach((ms) => {
          spatial.update({
            id: ms.__id,
            minX: ms.x,
            minY: ms.y,
            maxX: ms.x + 100,
            maxY: ms.y + 140,
          });
          assignCardToGroupByPosition(ms);
          queuePosition(ms);
          scheduleLocalSave();
        }),
      () => panning,
      (global, additive) => marquee.start(global, additive),
    );
    // Ensure context menu listener
    try {
      (ensureCardContextListeners as any)();
    } catch {}
    return s;
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
            s.x = p.x;
            s.y = p.y;
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
              s.x = p.x;
              s.y = p.y;
            }
          });
        }
        // Refresh spatial index bounds after applying new positions
        sprites.forEach((s) =>
          spatial.update({
            id: s.__id,
            minX: s.x,
            minY: s.y,
            maxX: s.x + 100,
            maxY: s.y + 140,
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
      { id: number; x: number; y: number; group_id: number | null }[]
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
        let x = entry.x;
        let y = entry.y;
        const gid: number | null = entry.group_id;
        try {
          id = (InstancesRepo as any).createWithId
            ? (InstancesRepo as any).createWithId({
                id,
                card_id: 1,
                x,
                y,
                z: 0,
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
        const sp = createSpriteForInstance({ id, x, y, z: zCounter++, card });
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

  // Disable automatic dataset JSON load: always start without spawning universe
  console.log(
    "[startup] dataset auto-load disabled; starting empty unless DB already has instances",
  );
  if (!loaded.instances.length) {
    // Rehydrate any previously imported cards (from IndexedDB/LS), then apply positions/groups
    await rehydrateImportedCards();
    applyStoredPositionsMemory();
    finishStartup();
  } else {
    loaded.instances.forEach((inst: any) => createSpriteForInstance(inst));
    // Also add imported cards in memory mode even if repo returned instances (browser fallback only)
    await rehydrateImportedCards();
    applyStoredPositionsMemory();
  }

  // Groups container + visuals
  const groups = new Map<number, GroupVisual>();
  function relayoutGroup(gv: GroupVisual) {
    if ((gv as any).layoutMode === "faceted" && (gv as any).facet) {
      layoutFaceted(gv, sprites, (gv as any).facet as FacetKind, (s) =>
        spatial.update({
          id: s.__id,
          minX: s.x,
          minY: s.y,
          maxX: s.x + 100,
          maxY: s.y + 140,
        }),
      );
    } else {
      layoutGroup(gv, sprites, (s) =>
        spatial.update({
          id: s.__id,
          minX: s.x,
          minY: s.y,
          maxX: s.x + 100,
          maxY: s.y + 140,
        }),
      );
    }
    updateGroupMetrics(gv, sprites);
    drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
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
          name: gv.name,
          collapsed: gv.collapsed,
          color: gv.color,
          layoutMode: (gv as any).layoutMode || "grid",
          facet: (gv as any).facet || null,
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
      if (gr.color) gv.color = gr.color;
      if (gr.layoutMode) (gv as any).layoutMode = gr.layoutMode;
      if (gr.facet) (gv as any).facet = gr.facet;
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
      ensureGroupEncapsulates(gv, sprites);
      if ((gv as any).layoutMode === "faceted" && (gv as any).facet) {
        layoutFaceted(gv, sprites, (gv as any).facet as FacetKind, (s) =>
          spatial.update({
            id: s.__id,
            minX: s.x,
            minY: s.y,
            maxX: s.x + 100,
            maxY: s.y + 140,
          }),
        );
      } else {
        updateGroupMetrics(gv, sprites);
        drawGroup(gv, false);
      }
    });
    // Ensure new group creations won't collide with restored ids (memory only)
    try {
      const maxId = Math.max(...[...groups.keys(), 0]);
      (GroupsRepo as any).ensureNextId &&
        (GroupsRepo as any).ensureNextId(maxId + 1);
    } catch {}
    scheduleGroupSave();
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
  } else {
    // If instances were present at load-time, restore groups from local storage immediately.
    if (loaded.instances.length) {
      restoreMemoryGroups();
    }
    // If we started empty but rehydrated cards earlier, restore groups now that groups exist.
    else if (sprites.length) {
      restoreMemoryGroups();
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
  function toggleHelp() {
    help.toggle();
  }

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
    input.style.color = "#fff";
    input.style.background = "#1c2a33";
    input.style.border = "1px solid #3d6175";
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
    // Bottom anchored slim bar replacing side panel
    el.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;height:120px;z-index:10020;display:flex;flex-direction:row;align-items:flex-start;padding:10px 14px;gap:16px;";
    el.className = "ui-panel";
    el.innerHTML =
      '<div style="font-size:22px;font-weight:600;letter-spacing:.55px;text-transform:uppercase;color:var(--panel-accent);">Group</div>';
    el.style.fontSize = "16px";
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
    el.appendChild(nameWrap);
    // Metrics
    const metrics = document.createElement("div");
    metrics.id = "group-info-metrics";
    metrics.style.cssText =
      "display:grid;grid-template-columns:auto 1fr;column-gap:12px;row-gap:4px;font-size:16px;min-width:140px;";
    el.appendChild(metrics);
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
          maxX: s.x + 100,
          maxY: s.y + 140,
        }),
      );
      updateGroupMetrics(gv, sprites);
      drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
      scheduleGroupSave();
      updateGroupInfoPanel();
    });
    const recolorBtn = makeBtn("Recolor", () => {
      const gv = currentPanelGroup();
      if (!gv) return;
      gv.color = (Math.random() * 0xffffff) | 0;
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
    actions.append(autoBtn, recolorBtn, deleteBtn);
    el.appendChild(actions);
    // Color palette strip
    const paletteStrip = document.createElement("div");
    paletteStrip.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
    for (let i = 0; i < 10; i++) {
      const sq = document.createElement("div");
      const col = (i * 0x222222 + 0x334455) & 0xffffff;
      sq.style.cssText =
        "width:18px;height:18px;border-radius:4px;cursor:pointer;border:1px solid var(--panel-border);";
      sq.style.background = "#" + col.toString(16).padStart(6, "0");
      sq.onclick = () => {
        const gv = currentPanelGroup();
        if (!gv) return;
        gv.color = col;
        drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
        scheduleGroupSave();
        updateGroupInfoPanel();
      };
      paletteStrip.appendChild(sq);
    }
    el.appendChild(paletteStrip);
    // Member list removed per requirements
    // Close button (optional)
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "×";
    closeBtn.title = "Clear selection";
    closeBtn.className = "ui-btn";
    closeBtn.style.cssText +=
      "position:absolute;top:6px;right:6px;width:40px;height:40px;font-size:22px;line-height:22px;padding:0;";
    closeBtn.onclick = () => {
      SelectionStore.clear();
      updateGroupInfoPanel();
    };
    el.appendChild(closeBtn);
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

  // ---- Card Info Side Pane ----
  let cardInfoPanel: HTMLDivElement | null = null;
  function ensureCardInfoPanel() {
    if (cardInfoPanel) return cardInfoPanel;
    const el = document.createElement("div");
    cardInfoPanel = el;
    el.id = "card-info-panel";
    el.style.cssText =
      "position:fixed;top:0;right:0;bottom:0;width:420px;max-width:45vw;z-index:10015;display:flex;flex-direction:column;pointer-events:auto;font-size:16px;";
    el.className = "ui-panel";
    el.innerHTML =
      '<div id="cip-header" style="padding:10px 14px 6px;font-size:14px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--panel-accent);display:flex;align-items:center;gap:8px;">Card</div>' +
      '<div id="cip-scroll" style="overflow:auto;padding:0 14px 18px;display:flex;flex-direction:column;gap:14px;">' +
      '<div id="cip-empty" style="opacity:.55;padding:14px 4px;font-size:14px;">No card selected</div>' +
      '<div id="cip-content" style="display:none;flex-direction:column;gap:28px;">' +
      '<div id="cip-name" style="font-size:32px;font-weight:600;line-height:1.2;"></div>' +
      '<div id="cip-meta" style="display:flex;flex-direction:column;gap:8px;font-size:18px;line-height:1.5;opacity:.9;"></div>' +
      '<div id="cip-type" style="font-size:18px;opacity:.8;"></div>' +
      '<div id="cip-oracle" class="ui-input" style="white-space:pre-wrap;font-size:18px;line-height:1.6;padding:16px 18px;min-height:160px;"></div>' +
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
    const panel = ensureCardInfoPanel();
    const empty = panel.querySelector("#cip-empty") as HTMLElement | null;
    const content = panel.querySelector("#cip-content") as HTMLElement | null;
    if (empty) empty.style.display = "none";
    if (content) content.style.display = "flex";
    const nameEl = panel.querySelector("#cip-name") as HTMLElement | null;
    if (nameEl) nameEl.textContent = card.name || "(Unnamed)";
    const typeEl = panel.querySelector("#cip-type") as HTMLElement | null;
    if (typeEl) typeEl.textContent = card.type_line || "";
    const oracleEl = panel.querySelector("#cip-oracle") as HTMLElement | null;
    if (oracleEl)
      oracleEl.innerHTML = renderTextWithManaIcons(card.oracle_text || "");
    const metaEl = panel.querySelector("#cip-meta") as HTMLElement | null;
    if (metaEl) {
      const rows: string[] = [];
      // Cost with real mana icons
      if (card.mana_cost) {
        rows.push(
          `<div><span style="font-weight:600;">Cost:</span> ${renderManaCostHTML(card.mana_cost)}</div>`,
        );
      }
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
      // P/T
      if (card.power !== undefined && card.toughness !== undefined)
        rows.push(
          `<div><span style="font-weight:600;">P/T:</span> ${card.power}/${card.toughness}</div>`,
        );
      // Color identity as icons
      if (Array.isArray(card.color_identity) && card.color_identity.length)
        rows.push(
          `<div><span style="font-weight:600;">CI:</span> ${renderColorIdentityIcons(card.color_identity)}</div>`,
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
        const setImg = `<img src="https://svgs.scryfall.io/sets/${setCode}.svg" alt="${setCode.toUpperCase()}" style="width:22px;height:22px;vertical-align:-5px;margin-right:6px;filter:drop-shadow(0 0 0 rgba(0,0,0,0.15));"/>`;
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
  function renderManaCostHTML(cost: string): string {
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
        `<img class="mana-icon" data-code="${encodeURIComponent(code)}" src="${src}" alt="{${escapeHtml(raw)}}" title="{${escapeHtml(raw)}}" style="width:22px;height:22px;vertical-align:-5px;margin:0 2px;" loading="lazy" decoding="async"/>`,
      );
    }
    if (!out.length) return escapeHtml(cost);
    return out.join("");
  }
  // Render any text with embedded mana symbols like "Tap: {T}: Add {G}{G}" into HTML with icons, preserving newlines as <br>.
  function renderTextWithManaIcons(text: string): string {
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
        `<img class="mana-icon" data-code="${encodeURIComponent(code)}" src="${src}" alt="{${escapeHtml(raw)}}" title="{${escapeHtml(raw)}}" style="width:22px;height:22px;vertical-align:-5px;margin:0 2px;" loading="lazy" decoding="async"/>`,
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
  function renderColorIdentityIcons(ci: string[]): string {
    const order = ["W", "U", "B", "R", "G"];
    const sorted = ci
      .slice()
      .sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return sorted
      .map((sym) => {
        const raw = sym.toUpperCase();
        const { src, code } = chooseSymbolUrl(raw);
        return `<img class="mana-icon" data-code="${encodeURIComponent(code)}" src="${src}" alt="{${escapeHtml(sym)}}" title="${escapeHtml(sym)}" style="width:22px;height:22px;vertical-align:-5px;margin:0 2px;opacity:.95;" loading="lazy" decoding="async"/>`;
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
      dbg.rect(0, 0, gv.w, edgeWorld).fill({ color: 0x3355ff, alpha: 0.25 });
      // Bottom (blue)
      dbg
        .rect(0, gv.h - edgeWorld, gv.w, edgeWorld)
        .fill({ color: 0x3355ff, alpha: 0.25 });
      // Left (green)
      dbg.rect(0, 0, edgeWorld, gv.h).fill({ color: 0x33cc66, alpha: 0.25 });
      // Right (green)
      dbg
        .rect(gv.w - edgeWorld, 0, edgeWorld, gv.h)
        .fill({ color: 0x33cc66, alpha: 0.25 });
      // Corners (red) overdraw so they stand out
      dbg
        .rect(0, 0, edgeWorld, edgeWorld)
        .fill({ color: 0xff3366, alpha: 0.35 }); // NW
      dbg
        .rect(gv.w - edgeWorld, 0, edgeWorld, edgeWorld)
        .fill({ color: 0xff3366, alpha: 0.35 }); // NE
      dbg
        .rect(0, gv.h - edgeWorld, edgeWorld, edgeWorld)
        .fill({ color: 0xff3366, alpha: 0.35 }); // SW
      dbg
        .rect(gv.w - edgeWorld, gv.h - edgeWorld, edgeWorld, edgeWorld)
        .fill({ color: 0xff3366, alpha: 0.35 }); // SE
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
      // Apply
      gv.w = newW;
      gv.h = newH;
      gv.gfx.x = newX;
      gv.gfx.y = newY;
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
      const local = world.toLocal(e.global);
      drag = true;
      dx = local.x - g.x;
      dy = local.y - g.y;
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
        const local = world.toLocal(e.global);
        drag = true;
        dx = local.x - g.x;
        dy = local.y - g.y;
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
      const local = world.toLocal(e.global);
      drag = true;
      dx = local.x - g.x;
      dy = local.y - g.y;
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
      const nx = local.x - dx;
      const ny = local.y - dy;
      const ddx = nx - g.x;
      const ddy = ny - g.y;
      g.x = nx;
      g.y = ny;
      memberOffsets.forEach((m) => {
        m.sprite.x = g.x + m.ox;
        m.sprite.y = g.y + m.oy;
      });
      // If multiple groups are selected, move them in lockstep
      const selected = new Set(SelectionStore.getGroups());
      selected.delete(gv.id);
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
      // Snap and persist the primary group
      g.x = snap(g.x);
      g.y = snap(g.y);
      memberOffsets.forEach((m) => {
        m.sprite.x = snap(m.sprite.x);
        m.sprite.y = snap(m.sprite.y);
        spatial.update({
          id: m.sprite.__id,
          minX: m.sprite.x,
          minY: m.sprite.y,
          maxX: m.sprite.x + 100,
          maxY: m.sprite.y + 140,
        });
      });
      persistGroupTransform(gv.id, { x: g.x, y: g.y, w: gv.w, h: gv.h });

      // Snap and persist any other selected groups moved in lockstep
      const selected = new Set(SelectionStore.getGroups());
      selected.delete(gv.id);
      if (selected.size) {
        selected.forEach((id) => {
          const og = groups.get(id);
          if (!og) return;
          og.gfx.x = snap(og.gfx.x);
          og.gfx.y = snap(og.gfx.y);
          [...og.items].forEach((cid) => {
            const s = sprites.find((sp) => sp.__id === cid);
            if (s) {
              s.x = snap(s.x);
              s.y = snap(s.y);
              spatial.update({
                id: s.__id,
                minX: s.x,
                minY: s.y,
                maxX: s.x + 100,
                maxY: s.y + 140,
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
  const PALETTE = [
    0x2d3e53, 0x444444, 0x554433, 0x224433, 0x333355, 0x553355, 0x335555,
    0x4a284a, 0x3c4a28, 0x284a4a,
  ];
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
    // Layout submenu
    const layoutHeader = document.createElement("div");
    layoutHeader.textContent = "Layout";
    layoutHeader.style.cssText =
      "padding:6px 6px 2px;opacity:.7;font-weight:600;";
    el.appendChild(layoutHeader);
    function setFacet(kind: FacetKind | null) {
      if (kind) {
        (gv as any).layoutMode = "faceted";
        (gv as any).facet = kind;
      } else {
        (gv as any).layoutMode = "grid";
        (gv as any).facet = undefined;
      }
      relayoutGroup(gv);
      scheduleGroupSave();
    }
    addItem("Grid (default)", () => setFacet(null));
    const gridBy = document.createElement("div");
    gridBy.style.cssText =
      "display:flex;gap:6px;padding:2px 6px 6px;flex-wrap:wrap;";
    function facetBtn(label: string, kind: FacetKind) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = "ui-btn";
      b.style.fontSize = "13px";
      b.style.padding = "4px 8px";
      b.onclick = () => {
        setFacet(kind);
        hideGroupMenu();
      };
      return b;
    }
    gridBy.appendChild(facetBtn("Grid by: Color", "color"));
    gridBy.appendChild(facetBtn("Type", "type"));
    gridBy.appendChild(facetBtn("Set", "set"));
    gridBy.appendChild(facetBtn("Mana Value", "mv"));
    el.appendChild(gridBy);
    addItem("Rename", () => startGroupRename(gv));
    addItem("Recolor", () => {
      gv.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
      scheduleGroupSave();
    });
    addItem("Delete", () => {
      deleteGroupById(gv.id);
      SelectionStore.clear();
      scheduleGroupSave();
    });
    const sw = document.createElement("div");
    sw.style.cssText =
      "display:flex;gap:4px;padding:4px 6px 2px;flex-wrap:wrap;";
    PALETTE.forEach((c) => {
      const sq = document.createElement("div");
      sq.style.cssText = `width:16px;height:16px;border-radius:4px;background:#${c.toString(16).padStart(6, "0")};cursor:pointer;border:1px solid #182830;`;
      sq.onclick = () => {
        gv.color = c;
        drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
        scheduleGroupSave();
        hideGroupMenu();
      };
      sw.appendChild(sq);
    });
    el.appendChild(sw);
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
              "margin-left:auto;color:#5fcba4;font-size:24px;";
            it.appendChild(badge);
          }
        });
    }
    if (card.__groupId) {
      const divider = document.createElement("div");
      divider.style.cssText = "height:1px;background:#1e323d;margin:6px 4px;";
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
    const maxX = Math.max(...selectedSprites.map((s) => s.x + 100));
    const maxY = Math.max(...selectedSprites.map((s) => s.y + 140));
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
            maxX: s.x + 100,
            maxY: s.y + 140,
          }),
        );
        updateGroupMetrics(gv, sprites);
        drawGroup(gv, true);
        scheduleGroupSave();
        SelectionStore.clear();
        SelectionStore.toggleGroup(id);
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
            maxX: s.x + 100,
            maxY: s.y + 140,
          }),
        );
        updateGroupMetrics(gv, sprites);
        drawGroup(gv, true);
        scheduleGroupSave();
        SelectionStore.clear();
        SelectionStore.toggleGroup(id);
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
    // Help overlay toggle (H or ?)
    if (e.key === "h" || e.key === "H") {
      if (e.repeat) return; // ignore auto-repeat
      (e as any).__helpHandled = true;
      toggleHelp();
    }
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
        // Persist updated positions to reflect removals
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

  function assignCardToGroupByPosition(s: CardSprite) {
    const cx = s.x + 50;
    const cy = s.y + 70; // card center
    let target: GroupVisual | null = null;
    for (const gv of groups.values()) {
      if (
        cx >= gv.gfx.x &&
        cx <= gv.gfx.x + gv.w &&
        cy >= gv.gfx.y &&
        cy <= gv.gfx.y + gv.h
      ) {
        target = gv;
        break;
      }
    }
    if (target) {
      // If moving between groups remove from old
      let layoutOld: GroupVisual | undefined;
      if (s.__groupId && s.__groupId !== target.id) {
        const old = groups.get(s.__groupId);
        if (old) {
          removeCardFromGroup(old, s.__id);
          layoutOld = old;
        }
      }
      if (!s.__groupId || s.__groupId !== target.id) {
        // Keep simple order: append at end; place near current drag position
        addCardToGroupOrdered(target, s.__id, target.order.length);
        s.__groupId = target.id;
        // Persist membership change
        try {
          InstancesRepo.updateMany([{ id: s.__id, group_id: target.id }]);
        } catch {}
        scheduleGroupSave();
        // Place at first available spot inside group (no forced resize; logic will respect global toggle)
        placeCardInGroup(
          target,
          s,
          sprites,
          (sc) =>
            spatial.update({
              id: sc.__id,
              minX: sc.x,
              minY: sc.y,
              maxX: sc.x + 100,
              maxY: sc.y + 140,
            }),
          s.x,
          s.y,
        );
      } else {
        // Already a member: keep freeform position
      }
      updateGroupMetrics(target, sprites);
      if (layoutOld) {
        updateGroupMetrics(layoutOld, sprites);
        drawGroup(layoutOld, SelectionStore.state.groupIds.has(layoutOld.id));
      }
      drawGroup(target, SelectionStore.state.groupIds.has(target.id));
    } else if (s.__groupId) {
      const old = groups.get(s.__groupId);
      if (old) {
        removeCardFromGroup(old, s.__id);
      }
      // Clear membership
      s.__groupId = undefined as any;
      // Ensure the sprite is visible and interactive again in case the group zoom overlay had hidden it
      (s as any).__groupOverlayActive = false;
      (s as any).eventMode = "static";
      s.cursor = "pointer";
      s.alpha = 1;
      s.visible = true;
      s.renderable = true;
      updateCardSpriteAppearance(s, SelectionStore.state.cardIds.has(s.__id));
      if (old) {
        updateGroupMetrics(old, sprites);
        drawGroup(old, SelectionStore.state.groupIds.has(old.id));
        scheduleGroupSave();
      }
      // Persist removal
      try {
        InstancesRepo.updateMany([{ id: s.__id, group_id: null }]);
      } catch {}
    }
  }

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
          group_id: (s as any).__groupId ?? null,
          scryfall_id:
            (s as any).__scryfallId || ((s as any).__card?.id ?? null),
        })),
        byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
      };
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
    perfEl.textContent =
      `Status / Performance\n` +
      ` FPS: ${fps}\n` +
      ` Zoom: ${world.scale.x.toFixed(2)}x\n` +
      ` JS Heap: ${jsHeapLine.replace("JS ", "")}\n` +
      `\nCards\n` +
      ` Total Cards: ${sprites.length}\n` +
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
    el.innerHTML =
      '<div style="font-weight:600;font-size:20px;margin-bottom:6px;color:var(--panel-accent);">Debug</div>';
    function addBtn(label: string, handler: () => void) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = "ui-btn";
      b.style.fontSize = "16px";
      b.style.padding = "10px 14px";
      b.onclick = handler;
      el!.appendChild(b);
    }
    addBtn("Grid Ungrouped Cards", () => {
      gridUngroupedCards();
    });
    addBtn("Grid Grouped Cards", () => {
      gridGroupedCards();
    });
    addBtn("Full Reset (Clear + Grid All)", () => {
      const ok = window.confirm(
        "Full Reset will clear all groups and re-grid every card. This cannot be undone. Proceed?",
      );
      if (!ok) return;
      clearGroupsOnly();
      resetLayout(true);
    });
    addBtn("Load Cards from JSON…", () => {
      loadFromJsonFile();
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
    // Auto-pack each group into a tight grid based on current members and persist transforms
    groups.forEach((gv) => {
      autoPackGroup(gv, sprites, (s) =>
        spatial.update({
          id: s.__id,
          minX: s.x,
          minY: s.y,
          maxX: s.x + 100,
          maxY: s.y + 140,
        }),
      );
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
  // Load cards from a JSON file (debug)
  function loadFromJsonFile() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      try {
        const txt = await file.text();
        // Try simple groups export format first
        const parsedGroups = (function parseGroupsText(text: string) {
          const lines = text.split(/\r?\n/);
          let hasHeading = false;
          const groups: { name: string; cards: string[] }[] = [];
          const ungrouped: string[] = [];
          let current: { name: string; cards: string[] } | null = null;
          let inUngrouped = false;
          for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (line.startsWith("#")) {
              hasHeading = true;
              // New sentinel: exactly "#ungrouped" (case-insensitive, no space)
              if (/^#ungrouped$/i.test(line)) {
                current = null;
                inUngrouped = true;
                continue;
              }
              const name = line.replace(/^#+\s*/, "").trim();
              if (!name) {
                current = null;
                inUngrouped = false;
                continue;
              }
              inUngrouped = false;
              current = { name, cards: [] };
              groups.push(current);
              continue;
            }
            if (/^\((empty|none)\)$/i.test(line)) continue;
            let name = line;
            const m = line.match(/^[-*]\s*(.+)$/);
            if (m) name = m[1].trim();
            if (!name) continue;
            if (inUngrouped) ungrouped.push(name);
            else if (current) current.cards.push(name);
            else ungrouped.push(name);
          }
          if (!hasHeading && !(ungrouped.length && groups.length === 0))
            return null;
          return { groups, ungrouped };
        })(txt);
        if (parsedGroups) {
          // Use existing importGroups path via import/export API
          const data = parsedGroups;
          // Resolve names to currently available sprites or fetch universe
          const byName = new Map<string, any>();
          for (const s of sprites) {
            const c = (s as any).__card;
            if (!c) continue;
            const nm = (c.name || "").toLowerCase();
            if (nm && !byName.has(nm)) byName.set(nm, c);
          }
          const resolve = (names: string[]) =>
            names
              .map((n) => byName.get((n || "").toLowerCase()))
              .filter(Boolean);
          // If missing, try to parse file as Scryfall list and spawn raw
          let imported = 0;
          for (const g of data.groups) {
            const cards = resolve(g.cards);
            if (!cards.length) continue;
            const ids: number[] = [];
            let maxId = sprites.length
              ? Math.max(...sprites.map((s) => s.__id))
              : 0;
            for (const card of cards) {
              let id: number;
              const x = 0,
                y = 0;
              try {
                id = InstancesRepo.create(1, x, y);
              } catch {
                id = ++maxId;
              }
              const sp = createSpriteForInstance({
                id,
                x,
                y,
                z: zCounter++,
                card,
              });
              ensureCardImage(sp);
              ids.push(sp.__id);
              imported++;
            }
            if (ids.length)
              (createGroupWithCardIds as any)(ids, g.name || "Group");
          }
          const ungrouped = resolve(data.ungrouped);
          if (ungrouped.length) {
            let placed = 0;
            // Choose columns to keep the block close to square (respecting card aspect ratio)
            const ratio = SPACING_Y / SPACING_X;
            const idealCols = Math.max(
              1,
              Math.round(Math.sqrt(ungrouped.length * ratio)),
            );
            const cols = Math.max(4, idealCols);
            // Compute block size, then find a free spot for the whole block
            const rows = Math.ceil(ungrouped.length / cols);
            const blockW = cols * SPACING_X - GAP_X_GLOBAL;
            const blockH = rows * SPACING_Y - GAP_Y_GLOBAL;
            const anchor = findFreeSpotForBlock(blockW, blockH, { pad: 16 });
            let maxId = sprites.length
              ? Math.max(...sprites.map((s) => s.__id))
              : 0;
            for (const card of ungrouped) {
              const idx = placed++;
              const col = idx % cols;
              const row = Math.floor(idx / cols);
              const x = anchor.x + col * SPACING_X;
              const y = anchor.y + row * SPACING_Y;
              let id: number;
              try {
                id = InstancesRepo.create(1, x, y);
              } catch {
                id = ++maxId;
              }
              const sp = createSpriteForInstance({
                id,
                x,
                y,
                z: zCounter++,
                card,
              });
              ensureCardImage(sp);
              imported++;
            }
            // Fit view to the new block for quick access
            camera.fitBounds(
              { x: anchor.x, y: anchor.y, w: blockW, h: blockH },
              { w: window.innerWidth, h: window.innerHeight },
            );
          }
          if (imported) {
            try {
              if (!SUPPRESS_SAVES) {
                const data = {
                  instances: sprites.map((s) => ({
                    id: s.__id,
                    x: s.x,
                    y: s.y,
                    group_id: (s as any).__groupId ?? null,
                    scryfall_id:
                      (s as any).__scryfallId ||
                      ((s as any).__card?.id ?? null),
                  })),
                  byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
                };
                localStorage.setItem(LS_KEY, JSON.stringify(data));
              }
            } catch {}
          }
          return;
        }
        // Otherwise, try Scryfall universe JSON (array/list/NDJSON)
        const arr = parseUniverseText(txt);
        if (Array.isArray(arr) && arr.length) {
          const TARGET = arr.length;
          await spawnLargeSet(
            arr,
            (inst) => {
              createSpriteForInstance(inst);
            },
            { count: TARGET, batchSize: 800 },
          );
          sprites.forEach((s) => ensureCardImage(s));
        } else {
          alert(
            "Unrecognized JSON format. Expected groups export or Scryfall card array/NDJSON.",
          );
        }
      } catch (e: any) {
        alert("Failed to load JSON: " + (e?.message || String(e)));
      }
    };
    inp.click();
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
    const cols = Math.ceil(Math.sqrt(sprites.length || 1));
    const batch: { id: number; x: number; y: number }[] = [];
    sprites.forEach((s, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = col * (CARD_W_GLOBAL + GAP_X_GLOBAL);
      const y = row * (CARD_H_GLOBAL + GAP_Y_GLOBAL);
      s.x = x;
      s.y = y;
      spatial.update({
        id: s.__id,
        minX: x,
        minY: y,
        maxX: x + 100,
        maxY: y + 140,
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
  }
  function gridUngroupedCards() {
    const ungrouped = sprites.filter((s) => !(s as any).__groupId);
    if (!ungrouped.length) return;
    // Compute vertical placement just below all existing groups
    let maxBottom = 0;
    let hasGroup = false;
    groups.forEach((gv) => {
      hasGroup = true;
      const b = gv.gfx.y + gv.h;
      if (b > maxBottom) maxBottom = b;
    });
    const startY = hasGroup ? snap(maxBottom + 80) : 0;
    // Simple grid width heuristic
    const cols = Math.ceil(Math.sqrt(ungrouped.length));
    const batch: { id: number; x: number; y: number }[] = [];
    ungrouped.forEach((s, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = col * (CARD_W_GLOBAL + GAP_X_GLOBAL);
      const y = startY + row * (CARD_H_GLOBAL + GAP_Y_GLOBAL);
      s.x = x;
      s.y = y;
      spatial.update({
        id: s.__id,
        minX: x,
        minY: y,
        maxX: x + 100,
        maxY: y + 140,
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
          x2 = s.x + 100 + 4,
          y2 = s.y + 140 + 4;
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
          maxX = s.x + 100;
          minY = s.y;
          initialized = true;
        } else {
          if (s.x + 100 > maxX) maxX = s.x + 100;
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
    const dx = bestX - gv.gfx.x;
    const dy = bestY - gv.gfx.y;
    if (dx || dy) {
      gv.gfx.x = bestX;
      gv.gfx.y = bestY;
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
            maxX: s.x + 100,
            maxY: s.y + 140,
          });
        }
      }
    }
  }

  // Find a free top-left position for a rectangular block (w x h) near viewport.
  // Scans in shelf order (left-to-right, then next row) to avoid overlap with groups and free cards.
  function findFreeSpotForBlock(
    w: number,
    h: number,
    opts?: { pad?: number },
  ): { x: number; y: number } {
    const pad = opts?.pad ?? 12;
    const invScale = 1 / world.scale.x;
    const startX = snap(-world.position.x * invScale + 40);
    const startY = snap(-world.position.y * invScale + 40);
    function collides(x: number, y: number): boolean {
      const gx1 = x - pad,
        gy1 = y - pad,
        gx2 = x + w + pad,
        gy2 = y + h + pad;
      for (const eg of groups.values()) {
        const x1 = eg.gfx.x - pad,
          y1 = eg.gfx.y - pad,
          x2 = eg.gfx.x + eg.w + pad,
          y2 = eg.gfx.y + eg.h + pad;
        if (gx1 < x2 && gx2 > x1 && gy1 < y2 && gy2 > y1) return true;
      }
      for (const s of sprites) {
        const x1 = s.x - 4,
          y1 = s.y - 4,
          x2 = s.x + 100 + 4,
          y2 = s.y + 140 + 4;
        if (gx1 < x2 && gx2 > x1 && gy1 < y2 && gy2 > y1) return true;
      }
      return false;
    }
    const stepX = snap(Math.max(w + 40, 200));
    const stepY = snap(Math.max(h + 40, 180));
    for (let row = 0; row < 60; row++) {
      for (let col = 0; col < 60; col++) {
        const x = snap(startX + col * stepX);
        const y = snap(startY + row * stepY);
        if (!collides(x, y)) return { x, y };
      }
    }
    return { x: startX, y: startY };
  }

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
  // Import/Export decklists (basic)
  const importExportUI = installImportExport({
    getAllNames: () => sprites.map((s) => (s as any).__card?.name || ""),
    getSelectedNames: () =>
      SelectionStore.getCards()
        .map((id) => sprites.find((s) => s.__id === id))
        .filter(Boolean)
        .map((s) => (s as any).__card?.name || ""),
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
        if (!names.length) lines.push("(empty)");
        else names.forEach((n) => lines.push(`- ${n}`));
        lines.push("");
      });
      // Ungrouped
      const ungrouped = sprites.filter((s) => !(s as any).__groupId);
      lines.push("#ungrouped");
      if (!ungrouped.length) lines.push("(none)");
      else
        ungrouped.forEach((s) => {
          const raw = ((s as any).__card?.name || "").trim();
          const i = raw.indexOf("//");
          const n = i >= 0 ? raw.slice(0, i).trim() : raw;
          if (n) lines.push(`- ${n}`);
        });
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
      // Place ungrouped cards in a grid near current view
      if (ungroupedCards.length) {
        const ratio = SPACING_Y / SPACING_X;
        const cols = Math.max(
          4,
          Math.round(Math.sqrt(ungroupedCards.length * ratio)),
        );
        const rows = Math.ceil(ungroupedCards.length / cols);
        const blockW = cols * SPACING_X - GAP_X_GLOBAL;
        const blockH = rows * SPACING_Y - GAP_Y_GLOBAL;
        const anchor = findFreeSpotForBlock(blockW, blockH, { pad: 16 });
        let placed = 0;
        let maxId = sprites.length
          ? Math.max(...sprites.map((s) => s.__id))
          : 0;
        for (const card of ungroupedCards) {
          const idx = placed++;
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const x = anchor.x + col * SPACING_X;
          const y = anchor.y + row * SPACING_Y;
          let id: number;
          try {
            id = InstancesRepo.create(1, x, y);
          } catch {
            id = ++maxId;
          }
          const sp = createSpriteForInstance({ id, x, y, z: zCounter++, card });
          ensureCardImage(sp);
          imported++;
        }
        // Fit to the block of cards just placed
        camera.fitBounds(
          { x: anchor.x, y: anchor.y, w: blockW, h: blockH },
          { w: window.innerWidth, h: window.innerHeight },
        );
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
      const inv = 1 / world.scale.x;
      // Choose near-square grid for the deck block; adjust after we know total count
      let cols = 8; // temporary, recomputed below
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
      // Decide final block anchor now that we know how many to place
      const totalToPlace = toPlace.reduce((sum, p) => sum + p.count, 0);
      const ratio2 = SPACING_Y / SPACING_X;
      cols = Math.max(4, Math.round(Math.sqrt(totalToPlace * ratio2)));
      const rows2 = Math.max(1, Math.ceil(totalToPlace / cols));
      const blockW2 = cols * SPACING_X - GAP_X_GLOBAL;
      const blockH2 = rows2 * SPACING_Y - GAP_Y_GLOBAL;
      const anchor2 = findFreeSpotForBlock(blockW2, blockH2, { pad: 16 });
      // Place all resolved cards
      const persistedCards: any[] = [];
      for (const pl of toPlace) {
        for (let i = 0; i < pl.count; i++) {
          const idx = placed++;
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const x = anchor2.x + col * SPACING_X;
          const y = anchor2.y + row * SPACING_Y;
          let id: number;
          try {
            id = InstancesRepo.create(1, x, y);
          } catch {
            id = ++maxId;
          }
          const sp = createSpriteForInstance({
            id,
            x,
            y,
            z: zCounter++,
            card: pl.card,
          });
          created.push(sp);
          persistedCards.push(pl.card);
        }
      }
      // Ensure images kick off and persist local positions
      created.forEach((s) => ensureCardImage(s));
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
      // Fit to newly added block if any
      if (created.length) {
        const minX = Math.min(...created.map((s) => s.x));
        const minY = Math.min(...created.map((s) => s.y));
        const maxX = Math.max(...created.map((s) => s.x + 100));
        const maxY = Math.max(...created.map((s) => s.y + 140));
        camera.fitBounds(
          { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
          { w: window.innerWidth, h: window.innerHeight },
        );
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
        // Compute a grid near current view for placement
        const total = cards.length;
        const ratio = SPACING_Y / SPACING_X;
        const cols = Math.max(4, Math.round(Math.sqrt(total * ratio)));
        const rows = Math.max(1, Math.ceil(total / cols));
        const blockW = cols * SPACING_X - GAP_X_GLOBAL;
        const blockH = rows * SPACING_Y - GAP_Y_GLOBAL;
        const anchor = findFreeSpotForBlock(blockW, blockH, { pad: 16 });
        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = anchor.x + col * SPACING_X;
          const y = anchor.y + row * SPACING_Y;
          let id: number;
          try {
            id = InstancesRepo.create(1, x, y);
          } catch {
            id = ++maxId;
          }
          const sp = createSpriteForInstance({ id, x, y, z: zCounter++, card });
          created.push(sp);
        }
        // Kick off images
        created.forEach((s) => ensureCardImage(s));
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
        // Fit to new items
        if (created.length) {
          const minX = Math.min(...created.map((s) => s.x));
          const minY = Math.min(...created.map((s) => s.y));
          const maxX = Math.max(...created.map((s) => s.x + 100));
          const maxY = Math.max(...created.map((s) => s.y + 140));
          camera.fitBounds(
            { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
            { w: window.innerWidth, h: window.innerHeight },
          );
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
    clearPersistedData: async () => {
      // Clear persisted artifacts
      SUPPRESS_SAVES = true;
      // Cancel any scheduled local save timers to avoid races
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
      // Best-effort: drop the imported_cards and image cache databases themselves
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
      // Ensure the next load starts empty (skip universe restore once)
      try {
        sessionStorage.setItem("mtgcanvas_start_empty_once", "1");
      } catch {}
    },
  });
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
  function normalizeName(s: string) {
    return (s || "").trim().toLowerCase();
  }
  function createGroupWithCardIds(ids: number[], name: string) {
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
        maxX: s.x + 100,
        maxY: s.y + 140,
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
    // Save and fit
    scheduleGroupSave();
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
        s.x + 100 >= left && s.x <= right && s.y + 140 >= top && s.y <= bottom;
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
        s.x + 100 >= left && s.x <= right && s.y + 140 >= top && s.y <= bottom;
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
                name: gv.name,
                collapsed: gv.collapsed,
                color: gv.color,
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

  // Global hotkey listener (capture) to ensure Help toggles even if earlier handler failed.
  window.addEventListener(
    "keydown",
    (e) => {
      // Ctrl+I to open Import/Export
      if ((e.ctrlKey || e.metaKey) && (e.key === "i" || e.key === "I")) {
        e.preventDefault();
        (importExportUI as any).show();
        return;
      }
      if (e.key === "h" || e.key === "H" || e.key === "?") {
        if ((e as any).__helpHandled) return; // primary handler already ran
        if (e.repeat) return;
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        )
          return;
        if ((window as any).__helpAPI) {
          console.log("[help] listener toggle");
          (window as any).__helpAPI.toggle();
        }
      }
    },
    { capture: true },
  );
})();
