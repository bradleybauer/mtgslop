import * as PIXI from "pixi.js";
import { SelectionStore } from "../state/selectionStore";
import { getCachedImage } from "../services/imageCache";
import { textureSettings as settings } from "../config/rendering";

// --- Fast in-memory texture cache & loaders ---
interface TexCacheEntry {
  tex: PIXI.Texture;
  level: number;
  refs: number;
  bytes: number;
  lastUsed: number;
  url: string;
}
const textureCache = new Map<string, TexCacheEntry>(); // url -> texture entry
let totalTextureBytes = 0;
const inflightTex = new Map<string, Promise<PIXI.Texture>>();
// Coalesced budget enforcement (avoid repeated sorts per frame)
let __budgetScheduled = false;
function scheduleEnforceTextureBudget() {
  if (__budgetScheduled) return;
  __budgetScheduled = true;
  requestAnimationFrame(() => {
    __budgetScheduled = false;
    enforceTextureBudget();
  });
}

// Central decode queue to throttle createImageBitmap to avoid main thread jank during large zoom transitions.
// We allow a small number of parallel decodes; others queue FIFO.
let activeDecodes = 0;
const DECODE_QUEUE_MAX = 2000; // hard cap to prevent runaway memory during massive bursts
type DecodeTask = {
  blob: Blob;
  url: string;
  resolve: (t: PIXI.Texture) => void;
  reject: (e: any) => void;
  priority?: number;
  enqAt: number;
};
const decodeQueue: DecodeTask[] = [];
// Small helper to get current limit (adaptive or UI-defined)
function currentDecodeLimit() {
  return settings.decodeParallelLimit;
}

function scheduleDecode(
  blob: Blob,
  url: string,
  priority = 0,
): Promise<PIXI.Texture> {
  return new Promise((resolve, reject) => {
    decodeQueue.push({
      blob,
      url,
      resolve,
      reject,
      priority,
      enqAt: performance.now(),
    });
    // If queue too large, drop a lowest-priority task (largest priority number)
    if (decodeQueue.length > DECODE_QUEUE_MAX) {
      let dropIdx = -1;
      let worst = -Infinity;
      for (let i = 0; i < decodeQueue.length; i++) {
        const p = decodeQueue[i].priority ?? 0;
        // prefer dropping low-priority (higher numeric value); never drop top-priority negatives if avoidable
        if (p > worst) {
          worst = p;
          dropIdx = i;
        }
      }
      if (dropIdx >= 0) {
        const dropped = decodeQueue.splice(dropIdx, 1)[0];
        try {
          dropped.reject(new Error("decode queue overflow"));
        } catch {}
      }
    }
    pumpDecodeQueue();
  });
}
async function runDecodeTask(task: DecodeTask) {
  activeDecodes++;
  try {
    const canBitmap = typeof (window as any).createImageBitmap === "function";
    let source: any;
    if (canBitmap) {
      source = await (window as any).createImageBitmap(task.blob);
    } else {
      // Fallback image element decode
      source = await new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error("img error"));
        img.src = URL.createObjectURL(task.blob);
      });
    }
    const tex = PIXI.Texture.from(source as any);
    const bt: any = tex.baseTexture as any;
    if (bt?.style) {
      bt.style.mipmap = "on";
      bt.style.scaleMode = "linear";
      bt.style.anisotropicLevel = 8;
    }
    task.resolve(tex);
  } catch (e) {
    task.reject(e);
  } finally {
    activeDecodes--;
    pumpDecodeQueue();
  }
}
function pumpDecodeQueue() {
  if (!decodeQueue.length) return;
  // Pick highest priority first (lower number = higher priority)
  decodeQueue.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  while (activeDecodes < currentDecodeLimit() && decodeQueue.length) {
    const task = decodeQueue.shift()!;
    runDecodeTask(task);
  }
}

export function getDecodeQueueSize() {
  return decodeQueue.length + activeDecodes;
}

export function getDecodeQueueStats() {
  const now = performance.now();
  const qLen = decodeQueue.length;
  let oldestWait = 0;
  let totalWait = 0;
  for (let i = 0; i < qLen; i++) {
    const w = now - (decodeQueue[i].enqAt || now);
    if (w > oldestWait) oldestWait = w;
    totalWait += w;
  }
  const avgWait = qLen ? totalWait / qLen : 0;
  return {
    active: activeDecodes,
    queued: qLen,
    oldestWaitMs: oldestWait,
    avgWaitMs: avgWait,
  };
}

function shouldThrottle(priority: number) {
  const q = getDecodeQueueSize();
  // When queue is very full, only allow very high-priority work through
  if (q > 600) return priority > -30; // only center/visible/hi-tier proceed
  if (q > 400) return priority > -10;
  return false;
}

function priorityForSprite(s: CardSprite | null, desiredLevel: number): number {
  // Lower numbers == higher priority
  let p = 0;
  if (s && s.visible) p -= 50; // on-screen work first
  if (desiredLevel >= 2) p -= 10; // bias hi-tier slightly
  // Recent hide grace: do not prioritize if just hidden
  const hidAt: number | undefined = (s as any)?.__hiddenAt;
  if (hidAt && performance.now() - hidAt < 800) p += 5;
  return p;
}

export async function loadTextureFromCachedURL(
  url: string,
  priority = 0,
): Promise<PIXI.Texture> {
  if (textureCache.has(url)) return textureCache.get(url)!.tex;
  if (inflightTex.has(url)) return inflightTex.get(url)!;
  const p = (async () => {
    const ci = await getCachedImage(url);
    // Reuse existing blob (preferred) else fall back to fetching objectURL (edge legacy path)
    let blob = ci.blob;
    if (!blob) {
      // Fallback: fetch once (should be memory-local since object URL); avoid double network due to persistence layer guarantee.
      const resp = await fetch(ci.objectURL);
      blob = await resp.blob();
    }
    const tex = await scheduleDecode(blob, url, priority);
    const bytes = estimateTextureBytes(tex);
    textureCache.set(url, {
      tex,
      level: 0,
      refs: 0,
      bytes,
      lastUsed: performance.now(),
      url,
    });
    totalTextureBytes += bytes;
    return tex;
  })();
  inflightTex.set(url, p);
  try {
    return await p;
  } finally {
    inflightTex.delete(url);
  }
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
  __hiResUrl?: string;
  __hiResLoaded?: boolean;
  __hiResLoading?: boolean;
  __hiResAt?: number;
  __qualityLevel?: number;
  __doubleBadge?: PIXI.Container;
  __faceIndex?: number;
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
  inGroup: PIXI.Texture;
  inGroupSelected: PIXI.Texture;
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

function ensureCardTextures(renderer: PIXI.Renderer) {
  if (cachedTextures) return cachedTextures;
  const w = 100,
    h = 140;
  cachedTextures = {
    base: buildTexture(renderer, {
      w,
      h,
      fill: 0xffffff,
      stroke: 0x000000,
      strokeW: 2,
    }),
    selected: buildTexture(renderer, {
      w,
      h,
      fill: 0xffffff,
      stroke: 0x00aaff,
      strokeW: 4,
    }),
    inGroup: buildTexture(renderer, {
      w,
      h,
      fill: 0xf7f7f7,
      stroke: 0x000000,
      strokeW: 2,
    }),
    inGroupSelected: buildTexture(renderer, {
      w,
      h,
      fill: 0xf7f7f7,
      stroke: 0x00aaff,
      strokeW: 4,
    }),
  };
  return cachedTextures;
}

export function createCardSprite(opts: CardVisualOptions) {
  const textures = ensureCardTextures(opts.renderer);
  const sp = new PIXI.Sprite(textures.base) as CardSprite;
  sp.__id = opts.id;
  sp.__baseZ = opts.z;
  sp.__card = opts.card || null;
  sp.x = opts.x;
  sp.y = opts.y;
  sp.zIndex = sp.__baseZ;
  sp.eventMode = "static";
  sp.cursor = "pointer";
  // If card already provided and double sided, initialize face index + badge
  if (sp.__card && isDoubleSided(sp.__card)) {
    sp.__faceIndex = 0;
    ensureDoubleSidedBadge(sp);
  }
  // Use default (linear) scaling for image clarity; we will supply higher-res textures when zoomed.
  return sp;
}

function estimateTextureBytes(tex: PIXI.Texture): number {
  try {
    const bt: any = tex.baseTexture;
    const w = bt?.width || tex.width;
    const h = bt?.height || tex.height;
    if (w && h) return w * h * 4;
  } catch {}
  return 0;
}

function enforceTextureBudget() {
  if (!settings.allowEvict) return; // user opted out of texture eviction
  const budgetBytes = settings.gpuBudgetMB * 1024 * 1024;
  if (!isFinite(budgetBytes) || totalTextureBytes <= budgetBytes) return;
  const candidates: TexCacheEntry[] = [];
  textureCache.forEach((ent) => {
    if (ent.refs === 0) candidates.push(ent);
  });
  if (!candidates.length) return;
  candidates.sort((a, b) => a.lastUsed - b.lastUsed);
  const now = performance.now();
  for (const ent of candidates) {
    if (totalTextureBytes <= budgetBytes) break;
    // Safety: only evict entries that have been idle long enough to avoid races
    if (now - ent.lastUsed < 1200) continue;
    try {
      ent.tex.destroy(true);
    } catch {}
    textureCache.delete(ent.url);
    totalTextureBytes -= ent.bytes;
  }
  try {
    compactHiResQueue();
  } catch {}
}

function markTextureUsed(url: string) {
  const ent = textureCache.get(url);
  if (ent) ent.lastUsed = performance.now();
}

export function registerVisibleSpriteTexture(sprite: CardSprite) {
  const url: any = (sprite as any).__currentTexUrl;
  if (url) markTextureUsed(url);
}
export function enforceTextureBudgetNow() {
  scheduleEnforceTextureBudget();
}

function demoteSpriteTextureToPlaceholder(s: CardSprite) {
  const prevUrl: string | undefined = (s as any).__currentTexUrl;
  if (prevUrl) {
    const pe = textureCache.get(prevUrl);
    if (pe) {
      pe.refs = Math.max(
        0,
        pe.refs - 1,
      ); /* defer actual destroy to global budget pass to avoid mid-frame races */
    }
    (s as any).__currentTexUrl = undefined;
  }
  s.__imgLoaded = false;
  s.__imgLoading = false;
  s.__qualityLevel = 0;
  s.__hiResLoaded = false;
  s.__hiResUrl = undefined;
  s.__hiResAt = undefined;
  // Switch to placeholder visuals based on selection/grouping
  try {
    updateCardSpriteAppearance(s, SelectionStore.state.cardIds.has(s.__id));
  } catch {}
  // Keep tracking clean
  try {
    compactHiResQueue();
  } catch {}
}

// Public: reduce GPU usage by demoting offscreen sprites until under budget.
export function enforceGpuBudgetForSprites(sprites: CardSprite[]) {
  const budgetBytes = settings.gpuBudgetMB * 1024 * 1024;
  if (!isFinite(budgetBytes) || totalTextureBytes <= budgetBytes) return;
  // Build candidate list: offscreen sprites holding a texture, prefer highest quality and least-recently-used textures
  const now = performance.now();
  const candidates = sprites.filter((s) => {
    if (s.visible) return false;
    if (!(s as any).__currentTexUrl) return false;
    // Do not demote sprites hidden by group overlay; those flips are intentional and short-lived.
    if ((s as any).__groupOverlayActive) return false;
    // Grace period: if just hidden (e.g., due to scroll/zoom), give ~800ms before demotion to avoid churn.
    const hidAt: number | undefined = (s as any).__hiddenAt;
    if (hidAt && now - hidAt < 800) return false;
    return true;
  });
  // Sort by quality desc, then by texture lastUsed ascending (older first)
  candidates.sort((a, b) => {
    const qa = a.__qualityLevel ?? 0;
    const qb = b.__qualityLevel ?? 0;
    if (qa !== qb) return qb - qa;
    const ua =
      textureCache.get((a as any).__currentTexUrl || "")?.lastUsed ?? 0;
    const ub =
      textureCache.get((b as any).__currentTexUrl || "")?.lastUsed ?? 0;
    return ua - ub;
  });
  // Important: demoting doesn't immediately lower totalTextureBytes (we release refs first,
  // destruction happens in enforceTextureBudget). Track an estimated freed byte count so we stop early.
  let freedEstimate = 0;
  for (const s of candidates) {
    if (totalTextureBytes - freedEstimate <= budgetBytes) break;
    const url: any = (s as any).__currentTexUrl;
    const ent = url ? textureCache.get(url) : undefined;
    if (ent) freedEstimate += ent.bytes;
    demoteSpriteTextureToPlaceholder(s);
  }
  // Final sweep of unreferenced textures (LRU) if still over
  scheduleEnforceTextureBudget();
}

export function ensureCardImage(sprite: CardSprite) {
  if (sprite.__imgLoaded || sprite.__imgLoading) return;
  const card = sprite.__card;
  if (!card) return;
  const myGen = (sprite as any).__loadGen ?? 0;
  const faceIdx = sprite.__faceIndex || 0;
  const face = (card.card_faces && card.card_faces[faceIdx]) || null;
  const url =
    face?.image_uris?.small ||
    card.image_uris?.small ||
    face?.image_uris?.normal ||
    card.image_uris?.normal;
  if (!url) return;
  sprite.__imgUrl = url;
  sprite.__imgLoading = true;
  const prio = priorityForSprite(sprite, 0);
  if (shouldThrottle(prio)) {
    sprite.__imgLoading = false;
    return;
  }
  loadTextureFromCachedURL(url, prio)
    .then((tex) => {
      if (!tex) {
        sprite.__imgLoading = false;
        return;
      }
      // Stale load guard (face flipped or generation advanced)
      if (((sprite as any).__loadGen ?? 0) !== myGen) {
        sprite.__imgLoading = false;
        return;
      }
      // Retain reference for base small texture
      try {
        const ent = textureCache.get(url);
        if (ent) {
          ent.refs++;
          ent.lastUsed = performance.now();
        }
        (sprite as any).__currentTexUrl = url;
      } catch {}
      sprite.texture = tex;
      sprite.width = 100;
      sprite.height = 140;
      sprite.__imgLoaded = true;
      sprite.__imgLoading = false;
      if (sprite.__qualityLevel === undefined) sprite.__qualityLevel = 0;
      if (SelectionStore.state.cardIds.has(sprite.__id))
        updateCardSpriteAppearance(sprite, true);
      if (isDoubleSided(card)) ensureDoubleSidedBadge(sprite);
      // Enforce GPU texture budget after loading a new base texture
      scheduleEnforceTextureBudget();
    })
    .catch(() => {
      sprite.__imgLoading = false;
    });
}

// ---- High Resolution Upgrade Logic ----
// Relaxed hi-res cache: allow more upgraded textures to stay resident before eviction.
// (Adjustable if memory pressure observed; tuned upward per user request.)
// Hi-res retention limit now reads from centralized settings dynamically
const hiResQueue: CardSprite[] = []; // oldest at index 0

function evictHiResIfNeeded() {
  const limit = settings.hiResLimit;
  if (!isFinite(limit)) return; // unlimited; rely on GPU budget eviction only
  while (hiResQueue.length > limit) {
    const victim = hiResQueue.shift();
    if (victim && victim.__hiResLoaded) {
      // Downgrade: keep small texture? We don't re-store it; assume still cached.
      victim.__hiResLoaded = false;
      victim.__hiResUrl = undefined;
      victim.__hiResAt = undefined;
      // No explicit destroy of texture to allow cache reuse; could add manual destroy here if memory pressure observed.
    }
  }
}
// Periodically compact the hi-res queue to drop stale entries
function compactHiResQueue() {
  if (!hiResQueue.length) return;
  let write = 0;
  const now = performance.now();
  let recentMs = 5 * 60 * 1000;
  try {
    const v = Number(localStorage.getItem("hiResRecentMs") || "");
    if (Number.isFinite(v) && v >= 0) recentMs = v;
  } catch {}
  for (let i = 0; i < hiResQueue.length; i++) {
    const s = hiResQueue[i];
    if (!s || (s as any)._destroyed) continue;
    const stillHi =
      !!s.__hiResLoaded &&
      !!s.__hiResUrl &&
      (s as any).__currentTexUrl === s.__hiResUrl;
    const recent = !!s.__hiResAt && now - (s.__hiResAt || 0) < recentMs;
    if (stillHi && recent) {
      if (write !== i) hiResQueue[write] = s;
      write++;
    }
  }
  if (write < hiResQueue.length) hiResQueue.length = write;
}

export function getHiResQueueDiagnostics() {
  const now = performance.now();
  let loaded = 0,
    loading = 0,
    stale = 0,
    visible = 0;
  let oldest = 0,
    newest = 0;
  const sample: any[] = [];
  for (let i = 0; i < hiResQueue.length; i++) {
    const s = hiResQueue[i];
    if (!s) continue;
    const curUrl: any = (s as any).__currentTexUrl;
    const isLoaded =
      !!s.__hiResLoaded && !!s.__hiResUrl && curUrl === s.__hiResUrl;
    const isLoading = !!s.__hiResLoading;
    const age = s.__hiResAt ? now - (s.__hiResAt || 0) : Number.NaN;
    if (oldest === 0 || (age > oldest && isFinite(age))) oldest = age;
    if (age > 0 && (newest === 0 || age < newest)) newest = age;
    if (isLoaded) loaded++;
    else if (isLoading) loading++;
    else stale++;
    if (s.visible) visible++;
    if (sample.length < 10) {
      sample.push({
        id: s.__id,
        q: s.__qualityLevel,
        vis: s.visible,
        ageMs: Math.round(age || 0),
        inflightLevel: (s as any).__inflightLevel || 0,
        pendingLevel: (s as any).__pendingLevel || 0,
        url: ("" + (s.__hiResUrl || "")).slice(-48),
        cur: ("" + (curUrl || "")).slice(-48),
      });
    }
  }
  return {
    length: hiResQueue.length,
    loaded,
    loading,
    stale,
    visible,
    oldestMs: oldest,
    newestMs: newest,
    sample,
  };
}

export function forceCompactHiResQueue() {
  compactHiResQueue();
}

// Multi-tier quality loader: 0=small,1=normal/large,2=png (highest)
export function updateCardTextureForScale(sprite: CardSprite, scale: number) {
  if ((sprite as any).__groupOverlayActive) return;
  if (!sprite.__card) return;
  const myGen = (sprite as any).__loadGen ?? 0;
  // Estimate on-screen pixel height
  const deviceRatio = globalThis.devicePixelRatio || 1;
  const pxHeight = 140 * scale * deviceRatio;
  let desired = 0;
  // Lower thresholds so we promote quality sooner (helps moderate zoom levels remain crisp)
  if (pxHeight > 140)
    desired = 2; // promote to png at lower on-screen size
  else if (pxHeight > 90) desired = 1; // switch to normal sooner
  // Avoid downgrade churn
  if (settings.disablePngTier && desired === 2) desired = 1; // cap at normal when PNG disabled
  // If already at or above desired, no action
  if (sprite.__qualityLevel !== undefined && desired <= sprite.__qualityLevel)
    return;
  // Track pending desired level to allow escalation even while a lower-tier is inflight
  const pending = (sprite as any).__pendingLevel ?? 0;
  if (desired > pending) (sprite as any).__pendingLevel = desired;
  const inflightLevel: number = (sprite as any).__inflightLevel ?? 0;
  if (inflightLevel && inflightLevel >= desired) return; // a higher or equal tier is already on the way
  // If already decoding lower tier and higher tier requested, we allow parallel because decode queue throttles globally.
  const card = sprite.__card;
  const faceIdx = sprite.__faceIndex || 0;
  const face = (card.card_faces && card.card_faces[faceIdx]) || null;
  let url: string | undefined;
  if (desired === 2) {
    url =
      face?.image_uris?.png ||
      card.image_uris?.png ||
      face?.image_uris?.large ||
      card.image_uris?.large;
  } else if (desired === 1) {
    url =
      face?.image_uris?.normal ||
      card.image_uris?.normal ||
      face?.image_uris?.large ||
      card.image_uris?.large;
  }
  if (!url) return;
  // If already at this URL skip
  if (
    sprite.texture?.baseTexture?.resource?.url === url ||
    sprite.__hiResUrl === url
  ) {
    sprite.__qualityLevel = desired;
    return;
  }
  const prevUrl: string | undefined = (sprite as any).__currentTexUrl;
  // mark inflight for this desired tier
  (sprite as any).__inflightLevel = desired;
  sprite.__hiResLoading = true;
  sprite.__hiResUrl = url;
  const prio = priorityForSprite(sprite, desired);
  if (shouldThrottle(prio)) {
    sprite.__hiResLoading = false;
    (sprite as any).__inflightLevel = 0;
    return;
  }
  loadTextureFromCachedURL(url, prio)
    .then((tex) => {
      // Clear inflight flag for this level
      if (((sprite as any).__inflightLevel ?? 0) === desired)
        (sprite as any).__inflightLevel = 0;
      sprite.__hiResLoading = false;
      if (!tex) return;
      if (((sprite as any).__loadGen ?? 0) !== myGen) return;
      try {
        const ent = textureCache.get(url);
        if (ent) {
          ent.refs++;
          ent.level = desired;
          ent.lastUsed = performance.now();
        }
        (sprite as any).__currentTexUrl = url;
        if (prevUrl && prevUrl !== url) {
          const pe = textureCache.get(prevUrl);
          if (pe) {
            pe.refs = Math.max(0, pe.refs - 1);
            if (pe.refs === 0 && pe.level < desired) {
              try {
                pe.tex.destroy(true);
                totalTextureBytes -= pe.bytes;
              } catch {}
              textureCache.delete(prevUrl);
            }
          }
        }
      } catch {}
      sprite.texture = tex;
      sprite.width = 100;
      sprite.height = 140;
      sprite.__qualityLevel = desired;
      if (desired >= 1) {
        sprite.__hiResLoaded = true;
        sprite.__hiResAt = performance.now();
        hiResQueue.push(sprite);
        evictHiResIfNeeded();
      }
      if (SelectionStore.state.cardIds.has(sprite.__id))
        updateCardSpriteAppearance(sprite, true);
      if (sprite.__card && isDoubleSided(sprite.__card))
  ensureDoubleSidedBadge(sprite);
      else if (sprite.__doubleBadge) {
        sprite.__doubleBadge.destroy();
        sprite.__doubleBadge = undefined;
      }
      // If a higher pending level exists, immediately try to promote again
      const pend: number = (sprite as any).__pendingLevel ?? 0;
      if (pend > (sprite.__qualityLevel ?? 0)) {
        // reuse same scale argument
        updateCardTextureForScale(sprite, scale);
      }
    })
    .catch(() => {
      if (((sprite as any).__inflightLevel ?? 0) === desired)
        (sprite as any).__inflightLevel = 0;
      sprite.__hiResLoading = false;
    });
  scheduleEnforceTextureBudget();
}

// Patch sprite destroy to release texture refs when removed.
export function attachDestroyRelease(sprite: CardSprite) {
  const anySprite: any = sprite as any;
  if (anySprite.__destroyPatched) return;
  anySprite.__destroyPatched = true;
  const orig = sprite.destroy.bind(sprite);
  sprite.destroy = function (...args: any[]) {
    const url: any = (sprite as any).__currentTexUrl;
    if (url) {
      const ent = textureCache.get(url);
      if (ent) {
        ent.refs = Math.max(0, ent.refs - 1);
        if (ent.refs === 0) {
          // opportunistic eviction if over budget
          scheduleEnforceTextureBudget();
        }
      }
    }
    orig(...args);
  } as any;
}

// Helper: derive image URL for a given quality tier (0 small,1 normal,2 png)
export function getCardImageUrlForLevel(
  card: any,
  level: number,
): string | undefined {
  if (level === 2)
    return (
      card.image_uris?.png ||
      card.card_faces?.[0]?.image_uris?.png ||
      card.image_uris?.large ||
      card.card_faces?.[0]?.image_uris?.large
    );
  if (level === 1)
    return (
      card.image_uris?.normal ||
      card.card_faces?.[0]?.image_uris?.normal ||
      card.image_uris?.large ||
      card.card_faces?.[0]?.image_uris?.large
    );
  return (
    card.image_uris?.small ||
    card.card_faces?.[0]?.image_uris?.small ||
    card.image_uris?.normal ||
    card.card_faces?.[0]?.image_uris?.normal
  );
}

// Preload a specific quality level regardless of current zoom thresholds; optionally apply resulting texture.
export function preloadCardQuality(
  sprite: CardSprite,
  level: number,
  apply: boolean = true,
): Promise<void> {
  if (!sprite.__card) return Promise.resolve();
  const url = getCardImageUrlForLevel(sprite.__card, level);
  if (!url) return Promise.resolve();
  return loadTextureFromCachedURL(url)
    .then((tex) => {
      if (apply) {
        sprite.texture = tex;
        sprite.width = 100;
        sprite.height = 140;
        sprite.__imgLoaded = true; // ensure marked loaded for metrics / logic
        sprite.__qualityLevel = level;
        if (level >= 1) {
          sprite.__hiResLoaded = true;
          sprite.__hiResAt = performance.now();
        }
      }
    })
    .catch(() => {});
}

// --- Monitoring helpers ---
export function getHiResQueueLength() {
  return hiResQueue.length;
}
export function getInflightTextureCount() {
  return inflightTex.size;
}

export function updateCardSpriteAppearance(s: CardSprite, selected: boolean) {
  if (!cachedTextures) return; // should exist after first card
  if (s.__imgLoaded) {
    // Simpler selection styling to avoid nested Graphics on Sprites in Pixi v8: tint when selected
    (s as any).tint = selected ? 0xbfeeff : 0xffffff;
    // Hide legacy outline if present
    if (s.__outline) {
      try {
        s.__outline.visible = false;
      } catch {}
    }
    return;
  }
  const inGroup = !!s.__groupId;
  s.texture = inGroup
    ? selected
      ? cachedTextures.inGroupSelected
      : cachedTextures.inGroup
    : selected
      ? cachedTextures.selected
      : cachedTextures.base;
}

// --- Double-sided (Reversible) Badge ---
// Only treat true double-faced transform style cards as reversible for UI badge.
// Exclude adventure, split, aftermath, flip etc. which have multiple faces in data but not a reversible back face.
const TRUE_DFC_LAYOUTS = new Set([
  "transform",
  "modal_dfc",
  "double_faced_token",
  "battle",
  "meld",
]);
function isDoubleSided(card: any): boolean {
  if (!card) return false;
  const layout = (card.layout || "").toLowerCase();
  if (TRUE_DFC_LAYOUTS.has(layout)) return true;
  // Fallback: exactly two fully imaged faces, and not in excluded layouts
  if (
    Array.isArray(card.card_faces) &&
    card.card_faces.length === 2 &&
    card.card_faces.every((f: any) => f.image_uris)
  ) {
    if (/^(adventure|split|aftermath|flip|prototype)$/.test(layout))
      return false;
    return true;
  }
  return false;
}

function ensureDoubleSidedBadge(sprite: CardSprite) {
  if (!isDoubleSided(sprite.__card)) {
    if (sprite.__doubleBadge) {
      sprite.__doubleBadge.destroy();
      sprite.__doubleBadge = undefined;
    }
    return;
  }
  const displayW = 100;
  // Quarter the previous linear size: radius 18 -> ~4.5 (round to 5)
  const targetRadius = 5;
  const margin = 4;
  const verticalOffset = 12; // push badge lower from top edge
  if (!sprite.__doubleBadge) {
    const wrap = new PIXI.Container();
    const g = new PIXI.Graphics();
    g.circle(0, 0, targetRadius)
      .fill({ color: 0x0a1a22, alpha: 0.9 })
      .stroke({ color: 0x48cfff, width: 2 });
    // Smaller arrows scaled to new radius
    g.moveTo(-2, -1)
      .lineTo(0, -5)
      .lineTo(2, -1)
      .stroke({ color: 0x8ae9ff, width: 2 });
    g.moveTo(2, 1)
      .lineTo(0, 5)
      .lineTo(-2, 1)
      .stroke({ color: 0x8ae9ff, width: 2 });
    wrap.addChild(g);
    wrap.eventMode = "static";
    wrap.cursor = "pointer";
    wrap.alpha = 0.4;
    wrap.on("pointerdown", (e: any) => {
      e.stopPropagation();
      flipCardFace(sprite);
    });
    wrap.on("mouseenter", () => {
      wrap.alpha = 0.9;
    });
    wrap.on("mouseleave", () => {
      wrap.alpha = 0.4;
    });
    sprite.__doubleBadge = wrap;
    sprite.addChild(wrap);
  }
  const badge = sprite.__doubleBadge!;
  // Neutralize parent scaling so badge appears fixed relative to card's 100x140 logical size.
  const sx = sprite.scale.x || 1;
  const sy = sprite.scale.y || 1;
  badge.scale.set(1 / sx, 1 / sy);
  // Desired displayed position (top-right)
  const desiredX = displayW - (targetRadius + margin);
  const desiredY = targetRadius + margin + verticalOffset;
  badge.x = desiredX / sx;
  badge.y = desiredY / sy;
  badge.zIndex = 1000000;
  if (sprite.__outline) sprite.__outline.zIndex = 999999;
  (sprite as any).sortableChildren = true;
}

// Maintain roughly screen-constant badge size: call every frame with world scale
// (Badge now scales with card; no inverse scaling function needed.)

function flipCardFace(sprite: CardSprite) {
  const card = sprite.__card;
  if (!card || !isDoubleSided(card)) return;
  const faces = card.card_faces;
  if (!Array.isArray(faces) || faces.length < 2) return;
  sprite.__faceIndex = sprite.__faceIndex ? 0 : 1;
  // Bump generation to invalidate any in-flight loads for the previous face
  (sprite as any).__loadGen = ((sprite as any).__loadGen ?? 0) + 1;
  // Reset state so fresh load occurs (ephemeral; no persistence)
  sprite.__hiResLoaded = false;
  sprite.__hiResUrl = undefined;
  sprite.__hiResLoading = false;
  sprite.__qualityLevel = 0;
  sprite.__imgLoaded = false;
  sprite.__imgUrl = undefined;
  // Try to apply a cached higher-quality texture immediately for the new face based on current scale
  try {
    const scale = (sprite.parent as any)?.scale?.x || 1;
    const faceIdx = sprite.__faceIndex || 0;
    const face = (card.card_faces && card.card_faces[faceIdx]) || null;
    const dpr = globalThis.devicePixelRatio || 1;
    const pxHeight = 140 * scale * dpr;
    let desired = 0;
    if (pxHeight > 140) desired = 2;
    else if (pxHeight > 90) desired = 1;
    if (settings.disablePngTier && desired === 2) desired = 1;
    const url =
      desired === 2
        ? face?.image_uris?.png ||
          card.image_uris?.png ||
          face?.image_uris?.large ||
          card.image_uris?.large
        : desired === 1
          ? face?.image_uris?.normal ||
            card.image_uris?.normal ||
            face?.image_uris?.large ||
            card.image_uris?.large
          : face?.image_uris?.small ||
            card.image_uris?.small ||
            face?.image_uris?.normal ||
            card.image_uris?.normal;
    if (url && textureCache.has(url)) {
      const ent = textureCache.get(url)!;
      ent.refs++;
      ent.lastUsed = performance.now();
      ent.level = Math.max(ent.level, desired);
      const prevUrl: any = (sprite as any).__currentTexUrl;
      if (prevUrl && prevUrl !== url) {
        const pe = textureCache.get(prevUrl);
        if (pe) pe.refs = Math.max(0, pe.refs - 1);
      }
      (sprite as any).__currentTexUrl = url;
      sprite.texture = ent.tex;
      sprite.width = 100;
      sprite.height = 140;
      sprite.__imgLoaded = true;
      sprite.__qualityLevel = desired;
      if (desired >= 1) {
        sprite.__hiResLoaded = true;
        sprite.__hiResAt = performance.now();
      }
    } else {
      // Load small immediately, then promote without waiting an extra frame
      ensureCardImage(sprite);
      updateCardTextureForScale(sprite, scale);
    }
  } catch {
    ensureCardImage(sprite);
    requestAnimationFrame(() => {
      try {
        const scale = (sprite.parent as any)?.scale?.x || 1;
        updateCardTextureForScale(sprite, scale);
      } catch {}
    });
  }
  ensureDoubleSidedBadge(sprite); // reposition after flip
}

export function attachCardInteractions(
  s: CardSprite,
  getAll: () => CardSprite[],
  world: PIXI.Container,
  stage: PIXI.Container,
  onCommit?: (moved: CardSprite[]) => void,
  isPanning?: () => boolean,
  startMarquee?: (global: PIXI.Point, additive: boolean) => void,
) {
  let dragState: null | {
    sprites: CardSprite[];
    offsets: { sprite: CardSprite; dx: number; dy: number }[];
  } = null;
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
    const ids = SelectionStore.getCards();
    const all = getAll();
    const dragSprites = all.filter((c) => ids.includes(c.__id));
    const startLocal = world.toLocal(e.global);
    dragState = {
      sprites: dragSprites,
      offsets: dragSprites.map((cs) => ({
        sprite: cs,
        dx: startLocal.x - cs.x,
        dy: startLocal.y - cs.y,
      })),
    };
    dragSprites.forEach((cs) => (cs.zIndex = 100000 + cs.__baseZ));
  });
  const endDrag = (commit: boolean) => {
    if (!dragState) return;
    dragState.sprites.forEach((cs) => (cs.zIndex = cs.__baseZ));
    if (commit) {
      dragState.sprites.forEach((cs) => {
        cs.x = snap(cs.x);
        cs.y = snap(cs.y);
      });
      onCommit && onCommit(dragState.sprites);
    }
    dragState = null;
  };
  stage.on("pointerup", () => endDrag(true));
  stage.on("pointerupoutside", () => endDrag(true));
  stage.on("pointermove", (e: any) => {
    if (!dragState) return;
    const local = world.toLocal(e.global);
    let moved = false;
    for (const off of dragState.offsets) {
      const nx = local.x - off.dx;
      const ny = local.y - off.dy;
      if (off.sprite.x !== nx || off.sprite.y !== ny) {
        off.sprite.x = nx;
        off.sprite.y = ny;
        moved = true;
      }
    }
    if (moved && onCommit) onCommit(dragState.sprites);
  });
}

const GRID_SIZE = 8; // match global grid (was 20)
function snap(v: number) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}
