import * as PIXI from "pixi.js";
import { getCachedImage } from "../services/imageCache";
import { textureSettings as settings } from "../config/rendering";
import { Colors, registerThemeListener } from "../ui/theme";
import { SelectionStore } from "../state/selectionStore";
import { KeyedMinHeap } from "./keyedMinHeap";
import { CARD_W, CARD_H } from "../config/dimensions";
import type { Card } from "../types/card";

// --- Fast in-memory texture cache & loaders ---
// Track currently alive decoded textures by URL for safe ref-counted destruction
const liveTexturesByUrl = new Map<
  string,
  { tex: PIXI.Texture; refCount: number }
>();

// Central decode queue (single priority queue). Only tasks popped by the scheduler start work.
let activeDecodes = 0;
// Priority-queued decode task (by URL); supports in-place priority updates
type TaskState = "queued" | "running";
type PrioTask = {
  url: string;
  priority: number; // lower is sooner
  enqAt: number;
  state: TaskState;
  // Number of sprites currently desiring this URL (not the number of waiters)
  refCount: number;
  heapIndex?: number;
};

const decodePQ = new KeyedMinHeap<PrioTask>((t) => t.url);
const tasksByUrl = new Map<string, PrioTask>();
// Simple waiter list so workers can sleep when queue is empty
const pqWaiters: Array<() => void> = [];
function notifyTaskAvailable() {
  const w = pqWaiters.shift();
  if (w) w();
}

async function runDecodeTask(task: PrioTask) {
  activeDecodes++;
  // Fetch & decode only when running (strict concurrency)
  const ci = await getCachedImage(task.url);
  const source = await (window as any).createImageBitmap(ci.blob);
  const tex = PIXI.Texture.from(source as any);
  const ts = tex.source;
  if (ts) {
    // Improve minification quality when zoomed out
    ts.autoGenerateMipmaps = true;
    ts.autoGarbageCollect = true;
  }
  // Do not close the ImageBitmap yet; Pixi may upload lazily on first render.
  // Apply this texture to all sprites that are currently waiting for this URL
  try {
    const getSprites = (window as any).__mtgGetSprites as
      | (() => any[])
      | undefined;
    if (typeof getSprites === "function") {
      const arr = getSprites() || [];
      let appliedCount = 0;
      for (const s of arr) {
        const sp = s as CardSprite;
        if (!sp || (sp as any).destroyed) continue;
        if (sp.__scheduledUrl === task.url) {
          const lvl = (sp as any).__scheduledLevel as 0 | 1 | 2 | undefined;
          applyTexture(sp, tex, (lvl ?? 1) as 0 | 1 | 2);
          appliedCount++;
        }
      }
      if (appliedCount === 0) {
        try {
          (tex as any)?.destroy?.(true);
        } catch {}
      }
    }
  } catch {}
  activeDecodes--;
  tasksByUrl.delete(task.url);
}
async function workerLoop() {
  while (true) {
    // throttle by worker count; block when queue empty
    const task: PrioTask | undefined = decodePQ.popMin();
    if (!task) {
      // sleep until a task is enqueued
      await new Promise<void>((res) => pqWaiters.push(res));
      continue;
    }
    // If no longer desired, cancel before starting decode
    if (task.refCount <= 0) {
      tasksByUrl.delete(task.url);
      continue;
    }
    task.state = "running";
    // if (activeDecodes > 8) { // optional
    //   await runDecodeTask(task);
    // }
    // else
    {
      runDecodeTask(task);
    }
  }
}

let workerStarted = false;
function ensureDecodeWorkers() {
  if (workerStarted) return;
  workerStarted = true;
  workerLoop();
}

export function getDecodeQueueSize() {
  return decodePQ.size() + activeDecodes;
}

// Basic world-space viewport rectangle used for culling/prefetch
export type ViewRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

// --- Card Sprite Implementation (Sprite + cached textures) ---
export interface CardSprite extends PIXI.Sprite {
  __id: number;
  __baseZ: number;
  __groupId?: number;
  __scryfallId?: string;
  __tintByMarquee?: boolean;
  __cardSprite?: true;
  __card?: Card | null;
  __imgUrl?: string;
  __imgLoaded?: boolean;
  __imgLoading?: boolean;
  __qualityLevel?: number;
  __doubleBadge?: PIXI.Container;
  __faceIndex?: number;
  // Pending texture upgrade bookkeeping (to avoid per-frame duplicate scheduling)
  __scheduledUrl?: string;
  __currentTexUrl?: string;
  // Flip FAB (for double-faced cards)
  __flipFab?: PIXI.Container & { bg: PIXI.Graphics; icon: PIXI.Graphics };
  // --- Transient drag float/tilt state ---
  __tiltActive?: boolean; // true while in special drag transform mode
  __elev?: number; // 0..1 lift amount (scales sprite slightly)
  __tlx?: number; // intended top-left X during drag (world units)
  __tly?: number; // intended top-left Y during drag (world units)
  __lastExtraScale?: number; // track last applied extra scale to derive base scale
  // Center-anchor state for preserving visual center during float/drag
  __cx?: number; // intended center X while floating
  __cy?: number; // intended center Y while floating
  __useCenterAnchor?: boolean; // when true, transforms preserve center rather than TL
  // 3D tilt state (mesh-based projection)
  __tiltMesh?: PIXI.PerspectiveMesh; // textured quad for 3D projection (perspective-correct)
  __tiltPitch?: number; // current pitch (rad)
  __tiltRoll?: number; // current roll (rad)
  __tiltTargetPitch?: number; // target pitch (rad)
  __tiltTargetRoll?: number; // target roll (rad)
  __tiltTargetAgeMs?: number; // ms since last input update
}

export interface CardVisualOptions {
  id: number;
  x: number;
  y: number;
  z: number;
  renderer: PIXI.Renderer;
  card?: Card | null;
}

interface CardTextures {
  base: PIXI.Texture;
  selected: PIXI.Texture;
}
let cachedTextures: CardTextures | null = null;

function buildTexture(
  renderer: PIXI.Renderer,
  opts: { w: number; h: number; fill: number; stroke: number; strokeW: number },
) {
  const g = new PIXI.Graphics();
  g.rect(0, 0, opts.w, opts.h)
    .fill({ color: opts.fill })
    .stroke({ color: opts.stroke, width: opts.strokeW });
  const tex = renderer.generateTexture(g);
  const ts = tex.source;
  if (ts) {
    ts.autoGenerateMipmaps = true;
    ts.autoGarbageCollect = true;
  }
  g.destroy();
  return tex;
}

function ensureCardBaseTextures(renderer: PIXI.Renderer) {
  if (cachedTextures) return cachedTextures;
  const w = 100,
    h = 140;
  cachedTextures = {
    base: buildTexture(renderer, {
      w,
      h,
      fill: Colors.cardPlaceholderFill(),
      stroke: Colors.cardPlaceholderStroke(),
      strokeW: 2,
    }),
    selected: buildTexture(renderer, {
      w,
      h,
      fill: Colors.cardPlaceholderFill(),
      stroke: Colors.cardSelectedStroke(),
      strokeW: 4,
    }),
  };
  return cachedTextures;
}

function retainTextureForUrl(url: string, tex: PIXI.Texture) {
  if (!url) return;
  const entry = liveTexturesByUrl.get(url);
  if (entry) {
    if (entry.tex !== tex) {
      entry.tex = tex;
    }
    entry.refCount += 1;
  } else {
    liveTexturesByUrl.set(url, { tex, refCount: 1 });
  }
}

function releaseTextureForUrl(url: string) {
  if (!url) return;
  const entry = liveTexturesByUrl.get(url);
  if (!entry) return;
  entry.refCount = Math.max(0, entry.refCount - 1);
  if (entry.refCount === 0) {
    try {
      (entry.tex as any)?.destroy?.(true);
    } catch {}
    liveTexturesByUrl.delete(url);
  }
}

function releaseSpriteTextureByUrl(sprite: CardSprite, url?: string) {
  const prevUrl = url || sprite.__currentTexUrl;
  if (!prevUrl) return;
  releaseTextureForUrl(prevUrl);
  if (!url) sprite.__currentTexUrl = undefined;
}

export function createCardSprite(opts: CardVisualOptions) {
  const textures = ensureCardBaseTextures(opts.renderer);
  const sp = new PIXI.Sprite(textures.base) as CardSprite;
  sp.__id = opts.id;
  sp.__baseZ = opts.z;
  sp.__card = opts.card || null;
  sp.x = opts.x;
  sp.y = opts.y;
  sp.zIndex = sp.__baseZ;
  sp.eventMode = "static";
  sp.cursor = "pointer";
  // Enable Pixi culling to skip rendering when fully offscreen
  sp.cullable = true as any;
  sp.cullArea = new PIXI.Rectangle(0, 0, CARD_W, CARD_H);
  // Ensure FAB is cleaned up when this sprite is removed or destroyed
  sp.on("removed", () => {
    cleanupFlipFab(sp);
    // If a decode for this sprite's scheduled URL exists, decrement desire
    if (sp.__scheduledUrl) {
      const oldTask = tasksByUrl.get(sp.__scheduledUrl);
      if (oldTask) oldTask.refCount = Math.max(0, oldTask.refCount - 1);
      sp.__scheduledUrl = undefined;
    }
  });
  const __origDestroy = sp.destroy.bind(sp);
  sp.destroy = (...args: any[]) => {
    cleanupFlipFab(sp);
    // Cancel any pending decode desire
    if (sp.__scheduledUrl) {
      const oldTask = tasksByUrl.get(sp.__scheduledUrl);
      if (oldTask) oldTask.refCount = Math.max(0, oldTask.refCount - 1);
      sp.__scheduledUrl = undefined;
    }
    // Release any current decoded texture reference
    releaseSpriteTextureByUrl(sp);
    return __origDestroy(...(args as any));
  };
  return sp;
}
// Exported: snapshot of texture budget/queue/debug counters for perf reports
export function getTextureBudgetStats() {
  // Cache removed; report zeros and configured budget
  return {
    totalTextureMB: 0,
    budgetMB: settings.gpuBudgetMB,
    overBudgetMB: 0,
    cacheEntries: 0,
  } as any;
}

// Clear all in-memory texture caches and free GPU resources. Safe to call when no sprites need textures.
export function clearTextureCaches() {
  // Also drop any queued decode tasks (best-effort); workers will skip tasks with refCount<=0
  try {
    tasksByUrl.forEach((t) => (t.refCount = 0));
    // Drain the heap
    while (decodePQ.size() > 0) decodePQ.popMin();
    // Destroy any tracked live textures
    liveTexturesByUrl.forEach((entry, url) => {
      try {
        (entry.tex as any)?.destroy?.(true);
      } catch {}
      liveTexturesByUrl.delete(url);
    });
  } catch {}
}

// Remove cached textures and queued decodes for given urls (all tiers/faces should be passed by caller)
export function purgeTextureUrls(urls: string[]) {
  for (const u of urls) {
    if (!u) continue;
    const t = tasksByUrl.get(u);
    if (t) t.refCount = 0;
    // No direct heap removal API; setting refCount=0 ensures worker skip
  }
}

// --- Tiered texture helpers for simple, robust policy up/downgrading ---
// 0 = small, 1 = normal, 2 = png/large (may be capped to 1 by settings.disablePngTier)
export function resolveTierUrl(
  sprite: CardSprite,
  level: 0 | 1 | 2,
): string | undefined {
  const card = sprite.__card;
  if (!card) return undefined;
  let target = level;
  if (settings.disablePngTier && target === 2) target = 1;
  const faceIdx = sprite.__faceIndex || 0;
  const face = (card.card_faces && card.card_faces[faceIdx]) || null;
  let res = null;
  if (target === 2) {
    res =
      face?.image_uris?.png ||
      card.image_uris?.png ||
      face?.image_uris?.large ||
      card.image_uris?.large;
  }
  if (target === 1 || !res) {
    res =
      face?.image_uris?.normal ||
      card.image_uris?.normal ||
      face?.image_uris?.large ||
      card.image_uris?.large;
  }
  if (target === 0 || !res) {
    res =
      face?.image_uris?.small ||
      card.image_uris?.small ||
      face?.image_uris?.normal ||
      card.image_uris?.normal;
  }
  return res;
}

function applyTexture(sprite: CardSprite, tex: PIXI.Texture, level: 0 | 1 | 2) {
  if ((sprite as any)?.destroyed) return;
  // Release previously held URL-bound texture so GPU memory drops when demoting/replacing
  const prevUrlBeforeSwap = sprite.__currentTexUrl;
  sprite.texture = tex;
  try {
    const ts = sprite.texture?.source;
    if (ts) {
      ts.autoGenerateMipmaps = true;
      ts.autoGarbageCollect = true;
    }
  } catch {}
  sprite.width = CARD_W;
  sprite.height = CARD_H;
  sprite.__imgLoaded = true;
  sprite.__imgLoading = false;
  sprite.__qualityLevel = level;
  // Mark current URL if we have a scheduled one
  if (sprite.__scheduledUrl) {
    sprite.__currentTexUrl = sprite.__scheduledUrl;
    // Retain decoded texture for this URL until it is replaced
    retainTextureForUrl(sprite.__currentTexUrl, tex);
    const oldTask = tasksByUrl.get(sprite.__scheduledUrl);
    if (oldTask) oldTask.refCount = Math.max(0, oldTask.refCount - 1);
    sprite.__scheduledUrl = undefined;
    (sprite as any).__scheduledLevel = undefined;
  }
  // Release previous after swap
  if (prevUrlBeforeSwap && prevUrlBeforeSwap !== sprite.__currentTexUrl) {
    releaseTextureForUrl(prevUrlBeforeSwap);
  }
}

function forcePlaceholder(sprite: CardSprite) {
  // Swap to shared placeholder then release previous texture
  const prevUrl = sprite.__currentTexUrl;
  sprite.__imgLoaded = false;
  sprite.__imgLoading = false;
  sprite.__qualityLevel = 0;
  sprite.__scheduledUrl = undefined;
  if ((sprite as any)?.destroyed) return;
  // Prefer generated base texture; else use a safe 1x1 white and scale.
  if (cachedTextures) {
    sprite.texture = cachedTextures.base;
  } else {
    sprite.texture = PIXI.Texture.WHITE;
    sprite.width = CARD_W;
    sprite.height = CARD_H;
  }
  if (prevUrl) {
    releaseSpriteTextureByUrl(sprite, prevUrl);
  }
  // Apply selection tint directly to avoid texture swaps during selection
  const sel = SelectionStore.state.cards.has(sprite);
  const marqueeSelected = !!(sprite as any).__tintByMarquee;
  sprite.tint =
    sel && marqueeSelected
      ? Colors.cardSelectedTint()
      : Colors.cardDefaultTint();
}

export function ensureTexture(sprite: CardSprite, view: ViewRect) {
  const x1 = sprite.x;
  const y1 = sprite.y;
  const x2 = x1 + sprite.width;
  const y2 = y1 + sprite.height;
  // Expand the view rect by 2x in both width and height around its center for prefetching
  const vLeft = view.left;
  const vTop = view.top;
  const vRight = view.right;
  const vBottom = view.bottom;
  const vCx = (vLeft + vRight) * 0.5;
  const vCy = (vTop + vBottom) * 0.5;
  const halfW = (vRight - vLeft) * 0.5;
  const halfH = (vBottom - vTop) * 0.5;
  const expLeft = vCx - halfW * 1;
  const expRight = vCx + halfW * 1;
  const expTop = vCy - halfH * 1;
  const expBottom = vCy + halfH * 1;
  const inView = !(
    x2 < expLeft ||
    x1 > expRight ||
    y2 < expTop ||
    y1 > expBottom
  );
  // Priority: inView highest (0), else lowest (100)
  const prio = inView ? 0 : 100;
  // Desired tier: if inView, choose by zoom; else 0
  const zoom = (sprite.parent as any)?.scale?.x || 1;
  let desired: 0 | 1 | 2 = 0;
  if (inView) {
    if (zoom > 1.5) desired = 2;
    else if (zoom > 0.8) desired = 1;
    else desired = 0;
  } else {
    desired = 0;
  }
  if (settings.disablePngTier && desired === 2) desired = 1;
  // During aggressive panning, avoid churn; stick to current tier until pan slows
  const panSpeed: number = (window as any).__lastPanSpeed || 0;
  const stickDuringPan = panSpeed > 600; // px/s
  const wantUrl = resolveTierUrl(
    sprite,
    stickDuringPan ? ((sprite.__qualityLevel as any) ?? desired) : desired,
  );
  if (!wantUrl) {
    // if no URL, ensure placeholder
    forcePlaceholder(sprite);
    if (sprite.__scheduledUrl) {
      const oldTask = tasksByUrl.get(sprite.__scheduledUrl);
      if (oldTask) oldTask.refCount = Math.max(0, oldTask.refCount - 1);
      sprite.__scheduledUrl = undefined;
    }
    return;
  }
  const curUrl: string | undefined = sprite.__currentTexUrl;
  if (curUrl === wantUrl) {
    if (sprite.__scheduledUrl) {
      const oldTask = tasksByUrl.get(sprite.__scheduledUrl);
      if (oldTask) oldTask.refCount = Math.max(0, oldTask.refCount - 1);
      sprite.__scheduledUrl = undefined;
    }
    return;
  }
  // No global cache: always rely on decode pipeline; decoded texture will be applied to waiting sprites
  if (sprite.__scheduledUrl && sprite.__scheduledUrl === wantUrl) {
    // Update priority of existing queued task
    const t = tasksByUrl.get(sprite.__scheduledUrl);
    if (t && t.state === "queued") {
      decodePQ.updatePriority(wantUrl, prio); //could probalby avoid work here
      t.priority = prio;
    }
    return;
  }

  // New schedule
  if (sprite.__scheduledUrl && sprite.__scheduledUrl !== wantUrl) {
    const oldTask = tasksByUrl.get(sprite.__scheduledUrl);
    if (oldTask) oldTask.refCount = Math.max(0, oldTask.refCount - 1);
  }
  sprite.__scheduledUrl = wantUrl;
  sprite.__imgLoading = true;
  sprite.__imgLoaded = false;
  (sprite as any).__scheduledLevel = desired;
  const existing = tasksByUrl.get(wantUrl);
  if (existing) {
    // New schedule for an existing task
    existing.refCount += 1;
    if (existing.state === "queued") {
      decodePQ.updatePriority(wantUrl, prio);
      existing.priority = prio;
    }
  } else {
    const task: PrioTask = {
      url: wantUrl,
      priority: Number.isFinite(prio) ? prio : 50,
      enqAt: performance.now(),
      state: "queued",
      refCount: 1,
      heapIndex: -1,
    };
    tasksByUrl.set(wantUrl, task);
    decodePQ.push(task);
    ensureDecodeWorkers();
    notifyTaskAvailable();
  }
}

export function updateCardSpriteAppearance(s: CardSprite, selected: boolean) {
  if (s?.destroyed) return;
  // For loaded images and placeholders alike, only adjust tint. Avoid reassigning textures
  // during selection toggles to prevent Pixi v8 internal width/anchor recalculation crashes.
  const marqueeSelected = !!(s as any).__tintByMarquee;
  s.tint =
    selected && marqueeSelected
      ? Colors.cardSelectedTint()
      : Colors.cardDefaultTint();
}
// --------------------------
// Flip FAB for double-faced cards
// --------------------------

const FLIP_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="white">
  <path d="M884.3,357.6c116.8,117.7,151.7,277-362.2,320V496.4L243.2,763.8L522,1031.3V860.8C828.8,839.4,1244.9,604.5,884.3,357.6z"></path>
  <path d="M557.8,288.2v138.4l230.8-213.4L557.8,0v142.8c-309.2,15.6-792.1,253.6-426.5,503.8C13.6,527.9,30,330.1,557.8,288.2z"></path>
</svg>`;

function applyFlipFabTheme(
  fab: PIXI.Container & { bg: PIXI.Graphics; icon: PIXI.Graphics; r?: number },
) {
  const radius = fab.r ?? 8;
  fab.bg.clear();
  fab.bg
    .circle(0, 0, radius)
    .fill({ color: Colors.panelBg() as any, alpha: 0.92 })
    .stroke({ color: Colors.accent() as any, width: 1 });
  (fab.icon as any).tint = Colors.panelFg();
}

function isDoubleFaced(sprite: CardSprite): boolean {
  const c = sprite.__card as any;
  if (!c) return false;
  const layout = String(c.layout || "").toLowerCase();
  // Only physical front/back cards
  const allowed = layout === "transform" || layout === "modal_dfc";
  if (!allowed) return false;
  if (!Array.isArray(c.card_faces) || c.card_faces.length !== 2) return false;
  return true;
}

function createFlipFab(sprite: CardSprite) {
  if (sprite.__flipFab) return sprite.__flipFab;
  const parent = sprite.parent as PIXI.Container | null;
  if (!parent) return undefined as any;
  const container = new PIXI.Container() as PIXI.Container & {
    bg: PIXI.Graphics;
    icon: PIXI.Graphics;
    r?: number;
  };
  container.eventMode = "static";
  container.cursor = "pointer";
  container.zIndex = 9999;
  // Default to dimmed; brighten on hover
  const DIM_ALPHA = 0.4;
  const HOVER_ALPHA = 1.0;
  container.alpha = DIM_ALPHA;
  // Draw at base size in world units so 1:1 with pixels when world.scale = 1
  const baseRadius = 8; // diameter 32px at zoom 1
  // Background circle
  const bg = new PIXI.Graphics();
  bg.circle(0, 0, baseRadius)
    .fill({ color: Colors.panelBg() as any, alpha: 0.92 })
    .stroke({ color: Colors.accent() as any, width: 1 });
  // Icon from SVG (scaled to fit inside the circle)
  const icon = new PIXI.Graphics().svg(FLIP_SVG);
  const ib = icon.getLocalBounds();
  icon.pivot.set(ib.x + ib.width / 2, ib.y + ib.height / 2);
  const diameter = baseRadius * 2;
  const target = diameter * 0.7; // keep some padding inside the circle
  const maxDim = Math.max(ib.width, ib.height) || 1;
  const s = target / maxDim;
  icon.scale.set(s);
  // Tint the white icon to theme foreground
  (icon as any).tint = Colors.panelFg();
  container.addChild(bg);
  container.addChild(icon);
  // Center-origin for simple placement math
  container.pivot.set(0, 0);
  // Stop interactions from bubbling to the card (prevents drag/select)
  const stop = (e: any) => {
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
  };
  container.on("pointerdown", stop);
  container.on("pointerup", stop);
  container.on("pointerupoutside", stop);
  container.on("pointercancel", stop);
  container.on("pointertap", (e: any) => {
    stop(e);
    flipCard(sprite);
  });
  // Hover feedback: increase opacity while hovered
  container.on("pointerover", () => {
    container.alpha = HOVER_ALPHA;
  });
  container.on("pointerout", () => {
    container.alpha = DIM_ALPHA;
  });
  // Attach
  container.bg = bg;
  container.icon = icon;
  container.r = baseRadius;
  parent.addChild(container);
  sprite.__flipFab = container;
  // Apply current theme (and allow later refreshes)
  applyFlipFabTheme(container);
  return container;
}

function positionFlipFab(sprite: CardSprite) {
  const fab = sprite.__flipFab;
  if (!fab) return;
  const inset = 4; // world units
  const radius = 8;
  // As a sibling, position in the same parent coordinate space as the sprite.
  // Account for FAB's current scale so the visual circle sits inset from the card edges.
  const sx = fab.scale?.x ?? 1;
  const sy = fab.scale?.y ?? 1;
  const dx = inset + radius * sx;
  const dy = inset + radius * sy + 15 * sy;
  // While tilting, the sprite's position may represent a center-based transform.
  // Use the intended top-left anchor during drag if available.
  const baseX = sprite.__tiltActive ? (sprite.__tlx ?? sprite.x) : sprite.x;
  const baseY = sprite.__tiltActive ? (sprite.__tly ?? sprite.y) : sprite.y;
  fab.x = baseX + CARD_W - dx;
  fab.y = baseY + dy;
}

export function updateFlipFab(sprite: CardSprite) {
  // Only show for double-faced cards
  if (!isDoubleFaced(sprite)) {
    if (sprite.__flipFab) {
      // Keep destruction cheap; removing child ensures it hides with the sprite anyway
      sprite.__flipFab.destroy({ children: true });
      sprite.__flipFab = undefined;
    }
    return;
  }
  // Delay creation until sprite is attached to a parent container
  if (!sprite.__flipFab && sprite.parent) {
    createFlipFab(sprite);
  }
  const fab = sprite.__flipFab!;
  if (!fab) return;
  // If parent changed, reattach to current parent (sibling of sprite)
  if (fab.parent !== sprite.parent && sprite.parent) {
    fab.parent?.removeChild(fab);
    (sprite.parent as PIXI.Container).addChild(fab);
  }
  // Keep size proportional to the card's current displayed size in parent units to avoid jumps
  // when the sprite's texture tier swaps (sprite.width/height remain authoritative display size).
  const scaleX = (sprite.width || CARD_W) / CARD_W;
  const scaleY = (sprite.height || CARD_H) / CARD_H;
  fab.scale.set(scaleX || 1, scaleY || 1);
  // Reposition (in case the card moved)
  positionFlipFab(sprite);
  // Ensure FAB renders above the card
  fab.zIndex = (sprite.zIndex || 0) + 1;
  // Mirror card visibility so it hides with overlays/groups
  fab.visible = !!(sprite as any).visible;
}

function cleanupFlipFab(sprite: CardSprite) {
  const fab = sprite.__flipFab;
  if (!fab) return;
  try {
    fab.parent?.removeChild(fab);
  } catch {}
  try {
    fab.destroy({ children: true });
  } catch {}
  sprite.__flipFab = undefined;
}

// Refresh FAB theming when the app theme changes
registerThemeListener(() => {
  try {
    const getSprites = (window as any).__mtgGetSprites;
    if (typeof getSprites === "function") {
      const arr = getSprites();
      if (Array.isArray(arr)) {
        for (const s of arr) {
          const fab = (s as any).__flipFab as
            | (PIXI.Container & {
                bg: PIXI.Graphics;
                icon: PIXI.Graphics;
                r?: number;
              })
            | undefined;
          if (fab) applyFlipFabTheme(fab);
        }
      }
    }
  } catch {
    // ignore (likely early during boot)
  }
});

function flipCard(sprite: CardSprite) {
  if (!isDoubleFaced(sprite)) return;
  const faces = ((sprite.__card as any).card_faces as any[]) || [];
  const count = faces.length;
  const cur = sprite.__faceIndex || 0;
  const next = (cur + 1) % count;
  // Schedule decode for the next face first (without changing the current face)
  const view = (window as any).__mtgView as ViewRect | undefined;
  if (view) {
    // Temporarily request a texture for the target face by computing its desired URL
    const prevFace = sprite.__faceIndex;
    sprite.__faceIndex = next;
    const desiredLevel: 0 | 1 | 2 =
      ((sprite.parent as any)?.scale?.x || 1) > 1.5
        ? settings.disablePngTier
          ? 1
          : 2
        : ((sprite.parent as any)?.scale?.x || 1) > 0.8
          ? 1
          : 0;
    const targetUrl = resolveTierUrl(sprite, desiredLevel);
    // Restore current face before we actually swap visuals
    sprite.__faceIndex = prevFace;
    if (targetUrl) {
      // Enqueue decode for the new face URL with high priority
      const existing = tasksByUrl.get(targetUrl);
      if (existing) {
        existing.refCount += 1;
        if (existing.state === "queued") {
          existing.priority = 0;
          decodePQ.updatePriority(targetUrl, 0);
        }
      } else {
        const task: PrioTask = {
          url: targetUrl,
          priority: 0,
          enqAt: performance.now(),
          state: "queued",
          refCount: 1,
          heapIndex: -1,
        };
        tasksByUrl.set(targetUrl, task);
        decodePQ.push(task);
        ensureDecodeWorkers();
        notifyTaskAvailable();
      }
    }
  }
  // Now switch the face index; applyTexture will release the old texture when new arrives
  sprite.__faceIndex = next;
  // Cancel any scheduled decode of the previous face URL
  if (sprite.__scheduledUrl) {
    const oldTask = tasksByUrl.get(sprite.__scheduledUrl);
    if (oldTask) oldTask.refCount = Math.max(0, oldTask.refCount - 1);
    sprite.__scheduledUrl = undefined;
  }
  // Trigger normal ensureTexture to bind when decode completes
  if (view) ensureTexture(sprite, view);
}

// --------------------------
// Drag Float + Tilt helpers
// --------------------------
const ELEV_SCALE = 0.02; // scale gain at full elevation (subtle lift)
const ELEV_TAU_MS = 80;
// 3D tilt tuning
const MAX_PITCH_RAD = 0.1 * Math.PI;
const MAX_ROLL_RAD = 0.1 * Math.PI;
const INPUT_CLAMP_PX = 40; // screen pixels for full tilt (zoom-invariant)
const TILT_TAU_MS = 80;
const TILT_RETURN_TAU_MS = 140; // decay target back toward 0 when input pauses
const CAMERA_D = 320; // perspective camera distance in world units (smaller = stronger)

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function ensureTiltMesh(sprite: CardSprite): PIXI.PerspectiveMesh | undefined {
  if ((sprite as any)?.destroyed) return undefined;
  if (sprite.__tiltMesh && !(sprite.__tiltMesh as any).destroyed)
    return sprite.__tiltMesh;
  // Build a simple textured quad mesh; vertices are local to mesh.position (we use center-origin)
  const tex = sprite.texture || PIXI.Texture.WHITE;
  // Use a denser grid for smoother perspective (aspect ~ 100x140)
  const vx = 12,
    vy = 18;
  const mesh = new PIXI.PerspectiveMesh({
    texture: tex,
    verticesX: vx,
    verticesY: vy,
  });
  mesh.eventMode = "none"; // don't intercept pointer events
  mesh.zIndex = (sprite.zIndex || 0) + 1;
  mesh.position.set(
    sprite.__cx ?? sprite.x + (sprite.width || CARD_W) / 2,
    sprite.__cy ?? sprite.y + (sprite.height || CARD_H) / 2,
  );
  // Match current selection tint
  (mesh as any).tint = sprite.tint;
  // Attach next to the sprite for correct stacking
  const parent = sprite.parent as PIXI.Container | null;
  if (parent) parent.addChild(mesh);
  sprite.__tiltMesh = mesh;
  return mesh;
}

function updateMeshTextureFromSprite(sprite: CardSprite) {
  const mesh = sprite.__tiltMesh;
  if (!mesh) return;
  if (mesh.texture !== sprite.texture) mesh.texture = sprite.texture;
  (mesh as any).tint = sprite.tint;
  try {
    const ts = mesh.texture?.source;
    if (ts) {
      ts.autoGenerateMipmaps = true;
      ts.autoGarbageCollect = true;
    }
  } catch {}
}

function projectCardQuad(
  w: number,
  h: number,
  pitch: number,
  yaw: number,
  out: Float32Array,
) {
  // Centered quad corners (local, before rotation)
  const hw = w / 2;
  const hh = h / 2;
  const corners: Array<[number, number, number]> = [
    [-hw, -hh, 0], // TL
    [hw, -hh, 0], // TR
    [hw, hh, 0], // BR
    [-hw, hh, 0], // BL
  ];
  const cxp = Math.cos(pitch);
  const sxp = Math.sin(pitch);
  const cyr = Math.cos(yaw);
  const syr = Math.sin(yaw);
  let idx = 0;
  for (let i = 0; i < 4; i++) {
    const x0 = corners[i][0];
    const y0 = corners[i][1];
    const z0 = corners[i][2];
    // Rotate around X (pitch)
    const y1 = y0 * cxp - z0 * sxp;
    const z1 = y0 * sxp + z0 * cxp;
    const x1 = x0;
    // Rotate around Y (yaw)
    const xr = x1 * cyr + z1 * syr;
    const yr = y1;
    const zr = z1 * cyr - x1 * syr;
    // Perspective scale: closer (larger positive zr) => larger scale.
    // Use (D - z) in denominator so positive z increases size.
    const denom = Math.max(1e-3, CAMERA_D - zr);
    const s = CAMERA_D / denom;
    out[idx++] = xr * s; // local x relative to center
    out[idx++] = yr * s; // local y relative to center
  }
}

function applyTransformFromCenter(
  sprite: CardSprite,
  cx: number,
  cy: number,
  angle: number,
  extraScale: number,
) {
  // Use center pivot computed from local size and keep the center stable
  const curScaleX = sprite.scale?.x || 1;
  const curScaleY = sprite.scale?.y || 1;
  const localW = (sprite.width || CARD_W) / curScaleX;
  const localH = (sprite.height || CARD_H) / curScaleY;
  const pivotX = localW / 2;
  const pivotY = localH / 2;
  sprite.pivot.set(pivotX, pivotY);
  const prevExtra = sprite.__lastExtraScale || 1;
  const baseScaleX = curScaleX / prevExtra;
  const baseScaleY = curScaleY / prevExtra;
  const totalScaleX = baseScaleX * extraScale;
  const totalScaleY = baseScaleY * extraScale;
  sprite.scale.set(totalScaleX, totalScaleY);
  sprite.__lastExtraScale = extraScale;
  sprite.rotation = angle;
  // With center pivot, x/y correspond to visual center
  sprite.x = cx;
  sprite.y = cy;
}

export function beginDragFloat(sprite: CardSprite) {
  if ((sprite as any)?.destroyed) return;
  if (sprite.__tiltActive) return;
  sprite.__tiltActive = true;
  // no tilt state
  sprite.__elev = 0;
  sprite.__tlx = sprite.x;
  sprite.__tly = sprite.y;
  sprite.__lastExtraScale = 1;
  // Initialize center so scale originates from the card center without visual jump
  // Use displayed size (accounts for current base scale) to get accurate center
  const dispW = sprite.width || CARD_W;
  const dispH = sprite.height || CARD_H;
  sprite.__cx = sprite.x + dispW / 2;
  sprite.__cy = sprite.y + dispH / 2;
  sprite.__useCenterAnchor = true;
  applyTransformFromCenter(sprite, sprite.__cx, sprite.__cy, 0, 1);
  // Prepare 3D mesh and hide the 2D sprite while dragging
  const mesh = ensureTiltMesh(sprite);
  if (mesh) {
    mesh.visible = true;
    mesh.zIndex = (sprite.zIndex || 0) + 1;
    mesh.position.set(sprite.__cx!, sprite.__cy!);
  }
  sprite.renderable = false;
  sprite.__tiltPitch = 0;
  sprite.__tiltRoll = 0;
  sprite.__tiltTargetPitch = 0;
  sprite.__tiltTargetRoll = 0;
  sprite.__tiltTargetAgeMs = 0;
}

// tilt removed

export function updateDraggedTopLeft(
  sprite: CardSprite,
  tlx: number,
  tly: number,
) {
  if (!sprite.__tiltActive) {
    sprite.x = tlx;
    sprite.y = tly;
    return;
  }
  // Preserve center during drag: convert TL motion to center motion
  const prevTlx = sprite.__tlx ?? tlx;
  const prevTly = sprite.__tly ?? tly;
  const dX = tlx - prevTlx;
  const dY = tly - prevTly;
  sprite.__tlx = tlx;
  sprite.__tly = tly;
  // Update intended center by the same world delta
  if (sprite.__cx == null || sprite.__cy == null) {
    const dispW = sprite.width || CARD_W;
    const dispH = sprite.height || CARD_H;
    sprite.__cx = tlx + dispW / 2;
    sprite.__cy = tly + dispH / 2;
  } else {
    sprite.__cx += dX;
    sprite.__cy += dY;
  }
  sprite.__useCenterAnchor = true;
  const ang = 0;
  const elev = sprite.__elev || 0;
  const extra = 1 + elev * ELEV_SCALE;
  applyTransformFromCenter(sprite, sprite.__cx, sprite.__cy, ang, extra);
  // Update tilt targets from input delta (map direction to pitch/yaw)
  // Convert world delta to screen-space using parent scale for zoom-invariant feel
  const sc = ((sprite.parent as any)?.scale?.x as number) || 1;
  const sdX = dX * sc;
  const sdY = dY * sc;
  const ndx = clamp(sdX, -INPUT_CLAMP_PX, INPUT_CLAMP_PX) / INPUT_CLAMP_PX;
  const ndy = clamp(sdY, -INPUT_CLAMP_PX, INPUT_CLAMP_PX) / INPUT_CLAMP_PX;
  // Coordinate notes: +y is down on screen. To bring bottom edge closer (down drag), use negative pitch.
  // To bring right edge closer (right drag), use positive yaw.
  sprite.__tiltTargetPitch = -ndy * MAX_PITCH_RAD;
  sprite.__tiltTargetRoll = ndx * MAX_ROLL_RAD;
  sprite.__tiltTargetAgeMs = 0;
}

export function endDragFloat(sprite: CardSprite) {
  if (!sprite.__tiltActive) return;
  // Reset visual transform to identity and restore top-left positioning
  const tlx = sprite.__tlx ?? sprite.x;
  const tly = sprite.__tly ?? sprite.y;
  sprite.pivot.set(0, 0);
  // Restore base scale by removing last extra scale
  const prevExtra = sprite.__lastExtraScale || 1;
  const baseScaleX = (sprite.scale?.x || 1) / prevExtra;
  const baseScaleY = (sprite.scale?.y || 1) / prevExtra;
  sprite.scale.set(baseScaleX, baseScaleY);
  sprite.rotation = 0;
  sprite.x = tlx;
  sprite.y = tly;
  sprite.__tiltActive = false;
  // no tilt state
  sprite.__elev = 0;
  sprite.__lastExtraScale = 1;
  sprite.__useCenterAnchor = false;
  sprite.__cx = undefined;
  sprite.__cy = undefined;
  // Remove 3D mesh and re-enable sprite rendering
  if (sprite.__tiltMesh) {
    try {
      sprite.__tiltMesh.parent?.removeChild(sprite.__tiltMesh);
      sprite.__tiltMesh.destroy({ texture: false });
    } catch {}
    sprite.__tiltMesh = undefined;
  }
  sprite.renderable = true;
  sprite.__tiltPitch = 0;
  sprite.__tiltRoll = 0;
  sprite.__tiltTargetPitch = 0;
  sprite.__tiltTargetRoll = 0;
  sprite.__tiltTargetAgeMs = 0;
}

export function updateFloatAndTilt(all: CardSprite[], dtMs: number) {
  // Smoothly approach elevation for active sprites (tilt removed)
  const kElev = 1 - Math.exp(-dtMs / ELEV_TAU_MS);
  for (const s of all) {
    if (!s.__tiltActive) continue;
    // Raise elevation toward 1 during drag
    const e = s.__elev ?? 0;
    s.__elev = e + (1 - e) * kElev;
    // Re-apply transform at updated values (2D sprite kept hidden but scale is tracked)
    const extra = 1 + (s.__elev || 0) * ELEV_SCALE;
    if (s.__useCenterAnchor && s.__cx != null && s.__cy != null) {
      applyTransformFromCenter(s, s.__cx, s.__cy, 0, extra);
    }
    // Update tilt targets decay if input pauses
    s.__tiltTargetAgeMs = (s.__tiltTargetAgeMs ?? 0) + dtMs;
    const kAngle = 1 - Math.exp(-dtMs / TILT_TAU_MS);
    if ((s.__tiltTargetAgeMs ?? 0) > 48) {
      const kRet = Math.exp(-dtMs / TILT_RETURN_TAU_MS);
      s.__tiltTargetPitch = (s.__tiltTargetPitch || 0) * kRet;
      s.__tiltTargetRoll = (s.__tiltTargetRoll || 0) * kRet;
    }
    // Ease angles toward targets
    s.__tiltPitch =
      (s.__tiltPitch ?? 0) +
      ((s.__tiltTargetPitch || 0) - (s.__tiltPitch ?? 0)) * kAngle;
    s.__tiltRoll =
      (s.__tiltRoll ?? 0) +
      ((s.__tiltTargetRoll || 0) - (s.__tiltRoll ?? 0)) * kAngle;
    // Build/update mesh geometry
    const mesh = ensureTiltMesh(s);
    if (!mesh) continue;
    updateMeshTextureFromSprite(s);
    mesh.visible = true;
    mesh.zIndex = (s.zIndex || 0) + 1;
    // Keep mesh centered at the intended center
    if (s.__cx != null && s.__cy != null) mesh.position.set(s.__cx, s.__cy);
    // Use displayed size (already includes elevation extra via sprite scale tracking)
    const w = s.width || CARD_W;
    const h = s.height || CARD_H;
    const verts = new Float32Array(8);
    projectCardQuad(w, h, s.__tiltPitch || 0, s.__tiltRoll || 0, verts);
    // Apply corners in clockwise order from top-left
    mesh.setCorners(
      verts[0],
      verts[1], // TL
      verts[2],
      verts[3], // TR
      verts[4],
      verts[5], // BR
      verts[6],
      verts[7], // BL
    );
  }
}
