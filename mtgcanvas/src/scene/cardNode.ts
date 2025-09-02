import * as PIXI from "pixi.js";
import { SelectionStore } from "../state/selectionStore";
import { getCachedImage } from "../services/imageCache";
import { textureSettings as settings } from "../config/rendering";
import { Colors } from "../ui/theme";
import { KeyedMinHeap } from "./keyedMinHeap";

// --- Fast in-memory texture cache & loaders ---
interface TexCacheEntry {
  tex: PIXI.Texture;
  level: number;
  bytes: number;
  url: string;
}
const textureCache = new Map<string, TexCacheEntry>(); // url -> texture entry
let totalTextureBytes = 0;
const inflightTex = new Map<string, Promise<PIXI.Texture>>();

// Central decode queue (single priority queue). Only tasks popped by the scheduler start work.
let activeDecodes = 0;
// Track desired URL references from sprites so we can cancel stale tasks before decoding
const desiredUrlRefs: Map<string, number> = new Map();
function incDesiredUrl(url: string) {
  desiredUrlRefs.set(url, (desiredUrlRefs.get(url) || 0) + 1);
}
function decDesiredUrl(url: string) {
  const n = (desiredUrlRefs.get(url) || 0) - 1;
  if (n <= 0) desiredUrlRefs.delete(url);
  else desiredUrlRefs.set(url, n);
}
// Priority-queued decode task (by URL); supports in-place priority updates
type TaskState = "queued" | "running";
type PrioTask = {
  url: string;
  priority: number; // lower is sooner
  enqAt: number;
  state: TaskState;
  waiters: { resolve: (t: PIXI.Texture) => void; reject: (e: any) => void }[];
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

function currentDecodeLimit() {
  // Hard cap at 16 per user requirement; also respect configured cap
  return Math.min(settings.decodeParallelLimit, 16);
}

async function runDecodeTask(task: PrioTask) {
  activeDecodes++;
  try {
    // Fetch & decode only when running (strict concurrency)
    const ci = await getCachedImage(task.url);
    let blob = ci.blob as Blob | undefined;
    if (!blob) {
      const resp = await fetch(ci.objectURL);
      blob = await resp.blob();
    }
    const source = await (window as any).createImageBitmap(blob);
    const tex = PIXI.Texture.from(source as any);
    const bt = tex.source;
    if (bt.style) {
      bt.style.scaleMode = "linear";
    }
    // Populate cache and resolve all waiters
    const bytes = estimateTextureBytes(tex);
    textureCache.set(task.url, {
      tex,
      level: 0,
      bytes,
      url: task.url,
    });
    totalTextureBytes += bytes;
    // Wake all waiters
    for (const w of task.waiters) w.resolve(tex);
  } catch (e) {
    for (const w of task.waiters) w.reject(e);
  } finally {
    activeDecodes--;
    inflightTex.delete(task.url);
    tasksByUrl.delete(task.url);
  }
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
    // If no longer desired, cancel
    if (!desiredUrlRefs.has(task.url)) {
      tasksByUrl.delete(task.url);
      for (const w of task.waiters)
        w.reject(new Error("decode canceled: no longer desired"));
      continue;
    }
    task.state = "running";
    const runningPromise = runDecodeTask(task);
    inflightTex.set(
      task.url,
      runningPromise as unknown as Promise<PIXI.Texture>,
    );
    try {
      await runningPromise;
    } catch {
      // swallow; individual waiters already rejected
    }
    // Loop to pick up next task
  }
}

let workersStarted = false;
function ensureDecodeWorkers() {
  if (workersStarted) return;
  workersStarted = true;
  const n = currentDecodeLimit();
  for (let i = 0; i < n; i++) workerLoop();
}

export function getDecodeQueueSize() {
  return decodePQ.size() + activeDecodes;
}

async function loadTextureFromCachedURL(
  url: string,
  priority: number = 50,
): Promise<PIXI.Texture> {
  // Serve from cache immediately
  const cached = textureCache.get(url);
  if (cached && isTextureUsable(cached.tex)) {
    return Promise.resolve(cached.tex);
  }
  const existing = tasksByUrl.get(url);
  if (existing) {
    if (existing.state === "queued") {
      decodePQ.updatePriority(url, priority);
      existing.priority = priority;
    }
    return new Promise<PIXI.Texture>((resolve, reject) => {
      existing.waiters.push({ resolve, reject });
    });
  }
  const task: PrioTask = {
    url,
    priority: Number.isFinite(priority) ? priority : 50,
    enqAt: performance.now(),
    state: "queued",
    waiters: [],
    heapIndex: -1,
  };
  tasksByUrl.set(url, task);
  decodePQ.push(task);
  // Track queue peak size for diagnostics
  const p = new Promise<PIXI.Texture>((resolve, reject) =>
    task.waiters.push({ resolve, reject }),
  );
  ensureDecodeWorkers();
  notifyTaskAvailable();
  return p;

}

// --- Card Sprite Implementation (Sprite + cached textures) ---
export interface CardSprite extends PIXI.Sprite {
  __id: number;
  __baseZ: number;
  __groupId?: number;
  __card?: any;
  __imgUrl?: string;
  __imgLoaded?: boolean;
  __imgLoading?: boolean;
  __outline?: PIXI.Graphics;
  __qualityLevel?: number;
  __doubleBadge?: PIXI.Container;
  __faceIndex?: number;
  // Pending texture upgrade bookkeeping (to avoid per-frame duplicate scheduling)
  __pendingUrl?: string;
  __pendingLevel?: 0 | 1 | 2;
  __pendingPromise?: Promise<PIXI.Texture> | null;
}

export interface CardVisualOptions {
  id: number;
  x: number;
  y: number;
  z: number;
  renderer: PIXI.Renderer;
  card?: any;
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
  // sp.cullable = true;
  // sp.cullArea = new PIXI.Rectangle(0, 0, 100, 140);
  return sp;
}

function estimateTextureBytes(tex: PIXI.Texture): number {
  const bt: any = tex.source;
  const w = bt?.width || tex.width;
  const h = bt?.height || tex.height;
  if (w && h) return w * h * 4;
  return 0;
}

function isTextureUsable(tex: PIXI.Texture | null | undefined): boolean {
  if (!tex) return false;
  const bt: any = (tex as any).source;
  if (!bt) return false;
  if (bt.destroyed === true) return false;
  if (bt.valid === false) return false;
  return true;
}

export function getInflightTextureCount() {
  return inflightTex.size;
}

// Exported: snapshot of texture budget/queue/debug counters for perf reports
export function getTextureBudgetStats() {
  const over = Math.max(
    0,
    totalTextureBytes - settings.gpuBudgetMB * 1024 * 1024,
  );
  return {
    totalTextureMB: totalTextureBytes / 1048576,
    budgetMB: settings.gpuBudgetMB,
    overBudgetMB: over / 1048576,
    cacheEntries: textureCache.size,
    inflight: inflightTex.size,
  };
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
    res = face?.image_uris?.png ||
      card.image_uris?.png ||
      face?.image_uris?.large ||
      card.image_uris?.large;
  }
  if (target === 1 || !res) {
    res = face?.image_uris?.normal ||
      card.image_uris?.normal ||
      face?.image_uris?.large ||
      card.image_uris?.large;
  }
  if (target === 0 || !res)
  {
    res = face?.image_uris?.small ||
      card.image_uris?.small ||
      face?.image_uris?.normal ||
      card.image_uris?.normal;
  }
  return res;
}

function adoptCachedTexture(
  sprite: CardSprite,
  url: string,
  ent: TexCacheEntry,
  level: 0 | 1 | 2,
) {
  (sprite as any).__currentTexUrl = url;
  sprite.texture = ent.tex;
  sprite.width = 100; // TODO USE CARD_W_GLOBAL
  sprite.height = 140; // TODO USE CARD_H_GLOBAL
  sprite.__imgLoaded = true;
  sprite.__imgLoading = false;
  sprite.__qualityLevel = level;
}

function forcePlaceholder(sprite: CardSprite) {
  const prevUrl: string | undefined = (sprite as any).__currentTexUrl;
  if (prevUrl) {
    (sprite as any).__currentTexUrl = undefined;
  }
  sprite.__imgLoaded = false;
  sprite.__imgLoading = false;
  sprite.__qualityLevel = 0;
  updateCardSpriteAppearance(
    sprite,
    SelectionStore.state.cardIds.has(sprite.__id),
  );
}

type ViewRect = { left: number; top: number; right: number; bottom: number };
export function ensureTexture(sprite: CardSprite, view: ViewRect) {
  const x1 = sprite.x,
    y1 = sprite.y,
    x2 = x1 + sprite.width,
    y2 = y1 + sprite.height;
  const inView = !(
    x2 < view.left ||
    x1 > view.right ||
    y2 < view.top ||
    y1 > view.bottom
  );
  // Priority: inView highest (0), else lowest (100)
  const prio = inView ? 0 : 100;
  // Desired tier: if inView, choose by zoom; else 0
  const zoom = (sprite.parent as any)?.scale?.x || 1;
  let desired: 0 | 1 | 2 = 0;
  if (inView) {
    if (zoom > 1.7) desired = 2;
    else if (zoom > 0.8) desired = 1;
    else desired = 0;
  } else {
    desired = 0;
  }
  if (settings.disablePngTier && desired === 2) desired = 1;
  const wantUrl = resolveTierUrl(sprite, desired);
  const curUrl: string | undefined = (sprite as any).__currentTexUrl;
  const curQ = sprite.__qualityLevel ?? -1;
  if (
    wantUrl &&
    curUrl === wantUrl &&
    isTextureUsable(sprite.texture)
  ) {
    if (sprite.__pendingUrl) {
      decDesiredUrl(sprite.__pendingUrl);
      sprite.__pendingUrl = undefined;
      sprite.__pendingLevel = undefined as any;
      sprite.__pendingPromise = null;
    }
    return;
  }
  if (wantUrl) {
    const cached = textureCache.get(wantUrl);
    if (cached) {
      adoptCachedTexture(sprite, wantUrl, cached, desired);
      if (sprite.__pendingUrl) {
        decDesiredUrl(sprite.__pendingUrl);
        sprite.__pendingUrl = undefined;
        sprite.__pendingLevel = undefined as any;
        sprite.__pendingPromise = null;
      }
      return;
    }
    if (
      sprite.__pendingUrl === wantUrl &&
      sprite.__pendingLevel === desired &&
      sprite.__pendingPromise
    ) {
      // Update priority of existing queued task
      const t = tasksByUrl.get(wantUrl);
      if (t && t.state === "queued") {
        decodePQ.updatePriority(wantUrl, prio);
        t.priority = prio;
      }
      return;
    }

    // New schedule
    if (sprite.__pendingUrl && sprite.__pendingUrl !== wantUrl) {
      decDesiredUrl(sprite.__pendingUrl);
    }
    sprite.__pendingUrl = wantUrl;
    sprite.__pendingLevel = desired;
    incDesiredUrl(wantUrl);
    const p = loadTextureFromCachedURL(wantUrl, prio);
    sprite.__pendingPromise = p;
    if (!sprite.__imgLoaded) sprite.__imgLoading = true;
    p.then((tex) => {
      if (sprite.__pendingUrl !== wantUrl || sprite.__pendingLevel !== desired)
        return;
      const ent = textureCache.get(wantUrl);
      if (ent) adoptCachedTexture(sprite, wantUrl, ent, desired);
      else if (isTextureUsable(tex)) {
        (sprite as any).__currentTexUrl = wantUrl;
        sprite.texture = tex;
        sprite.width = 100;
        sprite.height = 140;
        sprite.__imgLoaded = true;
        sprite.__qualityLevel = desired;
      }
      sprite.__pendingPromise = null;
      decDesiredUrl(wantUrl);
      sprite.__pendingUrl = undefined;
      sprite.__pendingLevel = undefined as any;
      sprite.__imgLoading = false;
    }).catch(() => {
      sprite.__pendingPromise = null;
      decDesiredUrl(wantUrl);
      sprite.__imgLoading = false;
    });
    return;
  }
  // No URL; ensure placeholder
  forcePlaceholder(sprite);
  if (sprite.__pendingUrl) {
    decDesiredUrl(sprite.__pendingUrl);
    sprite.__pendingUrl = undefined;
    sprite.__pendingLevel = undefined as any;
    sprite.__pendingPromise = null;
  }
  return;
}

export function updateCardSpriteAppearance(s: CardSprite, selected: boolean) {
  if (!cachedTextures) return; // should exist after first card
  if (s.__imgLoaded) {
    // Simpler selection styling to avoid nested Graphics on Sprites in Pixi v8: tint when selected
    (s as any).tint = selected
      ? Colors.cardSelectedTint()
      : Colors.cardDefaultTint();
    // Hide legacy outline if present
    if (s.__outline) {
      s.__outline.visible = false;
    }
    return;
  }
  // Placeholder: only two states now (base/selected); drop in-group variants
  s.texture = selected ? cachedTextures.selected : cachedTextures.base;
}

export function attachCardInteractions(
  s: CardSprite,
  getAll: () => CardSprite[],
  world: PIXI.Container,
  stage: PIXI.Container,
  onDrop?: (moved: CardSprite[]) => void,
  isPanning?: () => boolean,
  startMarquee?: (global: PIXI.Point, additive: boolean) => void,
  onDragMove?: (moved: CardSprite[]) => void,
) {
  // Small movement threshold before we consider a drag (screen-space, conservative)
  const LEFT_DRAG_THRESHOLD_PX = 4;
  let pendingStartLocal: { x: number; y: number } | null = null;
  let dragState: null | {
    sprites: CardSprite[];
    // Original positions at drag start (for rigid-body delta application)
    starts: { sprite: CardSprite; x0: number; y0: number }[];
    // Local position where drag started (to compute intended delta)
    startLocal: { x: number; y: number };
  } = null;
  function beginDrag(atLocal: { x: number; y: number }) {
    // Compute selected sprites lazily (only when we actually start dragging)
    const ids = SelectionStore.getCards();
    // Prefer O(1) lookup via prebuilt map; fallback to scan if absent
    const idMap: Map<number, CardSprite> | undefined = (window as any)
      .__mtgIdToSprite as Map<number, CardSprite> | undefined;
    const dragSprites: CardSprite[] = [];
    for (const id of ids) {
      const sp = idMap?.get(id);
      if (sp) dragSprites.push(sp);
    }
    if (dragSprites.length !== ids.length) {
      // Fallback for any missing
      const all = getAll();
      const missing = new Set(ids.filter((id) => !idMap?.has(id)));
      if (missing.size) {
        for (const s of all) if (missing.has(s.__id)) dragSprites.push(s);
      }
    }
    // Raise above current content using global max z; avoid full normalization on drag start
    const w: any = window as any;
    const getMax: any = w.__mtgMaxContentZ;
    let base = (typeof getMax === "function" ? Number(getMax()) : 0) + 1;
    // Stable ordering: keep relative baseZ
    const ordered = dragSprites
      .slice()
      .sort((a, b) => ((a as any).__baseZ || 0) - ((b as any).__baseZ || 0));
    for (const cs of ordered) {
      cs.zIndex = base;
      (cs as any).__baseZ = base;
      base += 1;
    }
    dragState = {
      sprites: dragSprites,
      starts: dragSprites.map((cs) => ({ sprite: cs, x0: cs.x, y0: cs.y })),
      startLocal: { x: atLocal.x, y: atLocal.y },
    };
    // Visual elevation applied above; nothing else to do
  }
  s.on("pointerdown", (e: any) => {
    if (e.button !== 0) return; // only left button selects / drags
    if (isPanning && isPanning()) return; // ignore clicks while panning with space
    // Suppress direct card drag if its group overlay label is active (zoomed out macro view).
    if ((s as any).__groupOverlayActive) return;
    // If Shift held, allow marquee instead of starting a card drag (when user intends multi-select)
    if (e.shiftKey && startMarquee) {
      startMarquee(new PIXI.Point(e.global.x, e.global.y), true);
      return; // don't initiate drag
    }
    if (!e.shiftKey && !SelectionStore.state.cardIds.has(s.__id))
      SelectionStore.selectOnlyCard(s.__id);
    else if (e.shiftKey) SelectionStore.toggleCard(s.__id);
    // Record local start; we’ll start drag only after a tiny movement threshold
    const startLocal = world.toLocal(e.global);
    pendingStartLocal = { x: startLocal.x, y: startLocal.y };
  });
  const endDrag = (commit: boolean) => {
    if (!dragState) return;
    // Persist bring-to-front ordering: stack above all existing non-dragging cards
    try {
      const all = getAll ? getAll() : [];
      const draggingIds = new Set(dragState.sprites.map((s) => s.__id));
      let maxZ = 0;
      for (const c of all) {
        if (draggingIds.has(c.__id)) continue;
        const z = c.zIndex || 0;
        if (z > maxZ) maxZ = z;
      }
      // Stable assignment order: promote in ascending previous baseZ to preserve relative stacking
      const sorted = dragState.sprites.slice().sort((a, b) => {
        const az = (a as any).__baseZ || 0;
        const bz = (b as any).__baseZ || 0;
        return az - bz;
      });
      for (const cs of sorted) {
        maxZ += 1;
        cs.zIndex = maxZ;
        (cs as any).__baseZ = maxZ;
      }
    } catch {
      // Fallback: restore baseZ if computation fails
      dragState.sprites.forEach((cs) => (cs.zIndex = cs.__baseZ));
    }
    if (commit) {
      // Persist new z-order to repository and local storage
      // InstancesRepo is imported in main; to avoid circular deps, update LS directly here
      // The authoritative repo update will happen via main's periodic saves as well.
      const w: any = window as any;
      const sprites: any[] = (w.__mtgGetSprites && w.__mtgGetSprites()) || [];
      const data = {
        instances: sprites.map((s: any) => ({
          id: s.__id,
          x: s.x,
          y: s.y,
          z: s.zIndex || s.__baseZ || 0,
          group_id: s.__groupId ?? null,
          scryfall_id: s.__scryfallId || (s.__card?.id ?? null),
        })),
        byIndex: sprites.map((s: any) => ({ x: s.x, y: s.y })),
      };
      localStorage.setItem("mtgcanvas_positions_v1", JSON.stringify(data));
      const ha: any = (stage as any).hitArea as any;
      const hasBounds = ha && typeof ha.x === "number";
      const minX = hasBounds ? ha.x : -Infinity;
      const minY = hasBounds ? ha.y : -Infinity;
      const maxX = hasBounds ? ha.x + ha.width - 100 : Infinity;
      const maxY = hasBounds ? ha.y + ha.height - 140 : Infinity;
      dragState.sprites.forEach((cs) => {
        let nx = snap(cs.x);
        let ny = snap(cs.y);
        if (hasBounds) {
          if (nx < minX) nx = minX;
          if (ny < minY) ny = minY;
          if (nx > maxX) nx = maxX;
          if (ny > maxY) ny = maxY;
        }
        cs.x = nx;
        cs.y = ny;
      });
      onDrop && onDrop(dragState.sprites);
    }
    dragState = null;
  };
  stage.on("pointerup", () => {
    pendingStartLocal = null;
    endDrag(true);
  });
  stage.on("pointerupoutside", () => {
    pendingStartLocal = null;
    endDrag(true);
  });
  stage.on("pointermove", (e: any) => {
    // If we have a pending click and no drag yet, check if movement exceeds threshold to begin drag
    if (!dragState && pendingStartLocal) {
      const localNow = world.toLocal(e.global);
      // Convert world-space delta to screen-space approx using stage scale
      const sc = (world as any)?.scale?.x || 1;
      const dx = (localNow.x - pendingStartLocal.x) * sc;
      const dy = (localNow.y - pendingStartLocal.y) * sc;
      if (Math.hypot(dx, dy) >= LEFT_DRAG_THRESHOLD_PX) {
        beginDrag(localNow);
        // fall-through to apply first move below in same tick
      } else {
        return;
      }
    }
    if (!dragState) return;
    const local = world.toLocal(e.global);
    let moved = false;
    const ha: any = (stage as any).hitArea as any;
    const hasBounds = ha && typeof ha.x === "number";
    const minX = hasBounds ? ha.x : -Infinity;
    const minY = hasBounds ? ha.y : -Infinity;
    const maxX = hasBounds ? ha.x + ha.width - 100 : Infinity;
    const maxY = hasBounds ? ha.y + ha.height - 140 : Infinity;

    // Intended deltas from drag start
    let dX = local.x - dragState.startLocal.x;
    let dY = local.y - dragState.startLocal.y;

    if (hasBounds) {
      // Compute shared delta limits so that all sprites remain in-bounds
      let lowDX = -Infinity;
      let highDX = Infinity;
      let lowDY = -Infinity;
      let highDY = Infinity;
      for (const st of dragState.starts) {
        // For X: minX <= x0 + dX <= maxX
        lowDX = Math.max(lowDX, minX - st.x0);
        highDX = Math.min(highDX, maxX - st.x0);
        // For Y: minY <= y0 + dY <= maxY
        lowDY = Math.max(lowDY, minY - st.y0);
        highDY = Math.min(highDY, maxY - st.y0);
      }
      // Clamp intended delta to allowable range
      if (dX < lowDX) dX = lowDX;
      if (dX > highDX) dX = highDX;
      if (dY < lowDY) dY = lowDY;
      if (dY > highDY) dY = highDY;
    }

    for (const st of dragState.starts) {
      const nx = st.x0 + dX;
      const ny = st.y0 + dY;
      if (st.sprite.x !== nx || st.sprite.y !== ny) {
        st.sprite.x = nx;
        st.sprite.y = ny;
        moved = true;
      }
    }
    if (moved && onDragMove) onDragMove(dragState.sprites);
  });
}

const GRID_SIZE = 8; // match global grid (was 20)
function snap(v: number) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}
