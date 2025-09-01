import * as PIXI from "pixi.js";
import { SelectionStore } from "../state/selectionStore";
import { getCachedImage } from "../services/imageCache";
import { textureSettings as settings } from "../config/rendering";
import { Colors } from "../ui/theme";

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
// Global-ish lightweight diagnostics; attached via window for easy access
const __dbg: any = (() => {
  try {
    const w: any = window as any;
    if (!w.__texDbg)
      w.__texDbg = {
        decode: { count: 0, totalMs: 0, maxMs: 0 },
        qPeak: 0,
        evict: { count: 0, bytes: 0, lastMs: 0 },
        budgetMB: (settings && settings.gpuBudgetMB) || 0,
        totalBytes: 0,
      };
    return w.__texDbg;
  } catch {
    return {
      decode: { count: 0, totalMs: 0, maxMs: 0 },
      qPeak: 0,
      evict: { count: 0, bytes: 0, lastMs: 0 },
      budgetMB: (settings && settings.gpuBudgetMB) || 0,
      totalBytes: 0,
    };
  }
})();
// Coalesced budget enforcement (avoid repeated sorts per frame)
let __budgetScheduled = false;
function scheduleEnforceTextureBudget() {
  if (__budgetScheduled) return;
  __budgetScheduled = true;
  requestAnimationFrame(() => {
    enforceTextureBudget();
    __budgetScheduled = false;
  });
}

// Central decode queue to throttle createImageBitmap to avoid main thread jank during large zoom transitions.
// We allow a small number of parallel decodes; others queue FIFO.
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
type DecodeTask = {
  blob: Blob;
  url: string;
  resolve: (t: PIXI.Texture) => void;
  reject: (e: any) => void;
  enqAt: number;
};

// Non-dropping decode queue with O(1) dequeue; we'll prune stale tasks on pump
const decodeQueue: DecodeTask[] = [];
let dqHead = 0;
function currentDecodeLimit() {
  return settings.decodeParallelLimit;
}

function scheduleDecode(blob: Blob, url: string): Promise<PIXI.Texture> {
  return new Promise((resolve, reject) => {
    const task: DecodeTask = {
      blob,
      url,
      resolve,
      reject,
      enqAt: performance.now(),
    };
  // Enqueue at the end (FIFO). Do not drop; we'll cancel stale tasks when pumping.
  decodeQueue.push(task);
  const qSize = decodeQueue.length - dqHead + activeDecodes;
  if (qSize > __dbg.qPeak) __dbg.qPeak = qSize;
    pumpDecodeQueue();
  });
}
async function runDecodeTask(task: DecodeTask) {
  activeDecodes++;
  try {
    const t0 = performance.now();
    const source = await (window as any).createImageBitmap(task.blob);
    const tex = PIXI.Texture.from(source as any);
    const bt = tex.source;
    if (bt.style) {
      bt.style.scaleMode = "linear";
    }
    task.resolve(tex);
    const dt = performance.now() - t0;
    __dbg.decode.count += 1;
    __dbg.decode.totalMs += dt;
    if (dt > __dbg.decode.maxMs) __dbg.decode.maxMs = dt;
  } catch (e) {
    task.reject(e);
  } finally {
    activeDecodes--;
    pumpDecodeQueue();
  }
}
function pumpDecodeQueue() {
  const limit = currentDecodeLimit();
  while (activeDecodes < limit && dqHead < decodeQueue.length) {
    // Dequeue from the front (oldest task first)
    const task = decodeQueue[dqHead++];
    if (!task) continue;
    // Compact the queue array periodically to avoid unbounded growth in memory
    if (dqHead > 1024 && dqHead > (decodeQueue.length >> 1)) {
      decodeQueue.splice(0, dqHead);
      dqHead = 0;
    }
    // If texture already cached, resolve immediately and skip decode
    const cached = textureCache.get(task.url);
    if (cached && isTextureUsable(cached.tex)) {
      cached.lastUsed = performance.now();
      task.resolve(cached.tex);
      continue;
    }
    // If no longer desired by any sprite, cancel without decoding
    if (!desiredUrlRefs.has(task.url)) {
      task.reject(new Error("decode canceled: no longer desired"));
      continue;
    }
    runDecodeTask(task);
  }
}

export function getDecodeQueueSize() {
  return (decodeQueue.length - dqHead) + activeDecodes;
}

export async function loadTextureFromCachedURL(
  url: string,
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
    const tex = await scheduleDecode(blob, url);
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

function ensureCardTextures(renderer: PIXI.Renderer) {
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
  // Enable Pixi's built-in culling for render skipping when outside viewport.
  (sp as any).cullable = true;
  (sp as any).cullArea = new PIXI.Rectangle(0, 0, 100, 140);
  // If card already provided and double sided, initialize face index + badge
  if (sp.__card && isDoubleSided(sp.__card)) {
    sp.__faceIndex = 0;
    ensureDoubleSidedBadge(sp);
  }
  // Use default (linear) scaling for image clarity; we will supply higher-res textures when zoomed.
  return sp;
}

function estimateTextureBytes(tex: PIXI.Texture): number {
  const bt: any = tex.source;
  const w = bt?.width || tex.width;
  const h = bt?.height || tex.height;
  if (w && h) return w * h * 4;
  return 0;
}

function enforceTextureBudget() {
  if (!settings.allowEvict) return; // user opted out of texture eviction
  const budgetBytes = settings.gpuBudgetMB * 1024 * 1024;
  if (!isFinite(budgetBytes)) return;
  // Watermarks: when we exceed highWater, evict until we reach lowWater to create headroom
  const pctLow = 0.85;
  const pctHigh = 0.92;
  const lowWater = Math.floor(budgetBytes * pctLow);
  const highWater = Math.floor(budgetBytes * pctHigh);
  if (totalTextureBytes <= highWater) return;
  const t0 = performance.now();
  let droppedBytes = 0;
  let droppedCount = 0;
  const candidates: TexCacheEntry[] = [];
  textureCache.forEach((ent) => {
    if (ent.refs === 0) candidates.push(ent);
  });
  if (!candidates.length) return;
  candidates.sort((a, b) => a.lastUsed - b.lastUsed);
  const now = performance.now();
  for (const ent of candidates) {
    if (totalTextureBytes <= lowWater) break;
    // Safety: only evict entries that have been idle long enough to avoid races
    if (now - ent.lastUsed < 1200) continue;
    // Queue for safe end-of-frame destruction instead of immediate destroy.
    queueTextureForDestroy(ent);
    droppedBytes += ent.bytes;
    droppedCount++;
  }
  __dbg.evict.count += droppedCount;
  __dbg.evict.bytes += droppedBytes;
  __dbg.evict.lastMs = performance.now() - t0;
  __dbg.totalBytes = totalTextureBytes;
  __dbg.budgetMB = settings.gpuBudgetMB;
}

export function enforceTextureBudgetNow() {
  scheduleEnforceTextureBudget();
}

// --- Safe destruction queue (flushed after render) ---
const __pendingDestroyList: TexCacheEntry[] = [];
const __pendingDestroySet: Set<string> = new Set();
function queueTextureForDestroy(ent: TexCacheEntry) {
  // Only queue unreferenced entries and avoid duplicates
  if (ent.refs > 0) return;
  if (__pendingDestroySet.has(ent.url)) return;
  __pendingDestroySet.add(ent.url);
  __pendingDestroyList.push(ent);
}

export function flushPendingTextureDestroys() {
  if (!__pendingDestroyList.length) return;
  for (let i = 0; i < __pendingDestroyList.length; i++) {
    const ent = __pendingDestroyList[i];
    // If entry was re-adopted, drop it from queue and allow re-queue later
    if (ent.refs > 0) {
      __pendingDestroySet.delete(ent.url);
      continue;
    }
    textureCache.delete(ent.url);
    __pendingDestroySet.delete(ent.url);
    totalTextureBytes -= ent.bytes;
  }
  // Reset queue to survivors (none in current strategy)
  __pendingDestroyList.length = 0;
}

function isTextureUsable(tex: PIXI.Texture | null | undefined): boolean {
  if (!tex) return false;
  const bt: any = (tex as any).source;
  if (!bt) return false;
  if (bt.destroyed === true) return false;
  if (bt.valid === false) return false;
  return true;
}

// Public: reduce GPU usage by demoting offscreen sprites until under budget.
// Backoff state to avoid scanning all sprites every frame when over budget but no demotions are possible
let __lastBudgetCheckAt = 0;
let __lastBudgetHadCandidates = true;
export function enforceGpuBudgetForSprites(sprites: CardSprite[]) {
  const budgetBytes = settings.gpuBudgetMB * 1024 * 1024;
  if (!isFinite(budgetBytes) || totalTextureBytes <= budgetBytes) return;
  const now = performance.now();
  const t0 = now;
  // If we were just over budget and previously found no candidates to demote (e.g., all visible),
  // skip doing another full O(n) scan for a short interval to prevent permanent per-frame cost.
  if (!__lastBudgetHadCandidates && now - __lastBudgetCheckAt < 1000) return;
  // Build candidate list: offscreen sprites holding a texture, prefer highest quality and least-recently-used textures
  const view: any = (window as any).__mtgView;
  const candidates = sprites.filter((s) => {
    if (s.visible) return false;
    if (!(s as any).__currentTexUrl) return false;
    // If hidden by group overlay, allow demotion after a grace period to avoid permanent VRAM pressure at macro zoom.
    if ((s as any).__groupOverlayActive) {
      const hidAt: number | undefined = (s as any).__hiddenAt;
      if (!hidAt) return false;
      // Grace window when overlay first activates; default ~3s, adjustable via localStorage("overlayDemoteMs").
      let overlayMs = 3000;
      const v = Number(localStorage.getItem("overlayDemoteMs") || "");
      if (Number.isFinite(v) && v >= 0) overlayMs = v;
      if (performance.now() - hidAt < overlayMs) return false;
    }
    // Grace period: if just hidden (e.g., due to scroll/zoom), give ~800ms before demotion to avoid churn.
    const hidAt: number | undefined = (s as any).__hiddenAt;
    if (hidAt && now - hidAt < 800) return false;
    // Protect cards near the viewport bounds from demotion so they can enter smoothly
    if (view) {
      const pad = (view.padNear ?? 300) * 1.25; // a bit larger than upgrade near-pad
      const x1 = s.x,
        y1 = s.y,
        x2 = x1 + s.width,
        y2 = y1 + s.height;
      const nearViewport =
        x2 >= view.left - pad &&
        x1 <= view.right + pad &&
        y2 >= view.top - pad &&
        y1 <= view.bottom + pad;
      if (nearViewport) return false;
    }
    return true;
  });
  __lastBudgetHadCandidates = candidates.length > 0;
  __lastBudgetCheckAt = now;
  candidates.sort((a, b) => {
    if (view) {
      const acx = a.x + a.width * 0.5,
        acy = a.y + a.height * 0.5;
      const bcx = b.x + b.width * 0.5,
        bcy = b.y + b.height * 0.5;
      const ad2 =
        (acx - view.cx) * (acx - view.cx) + (acy - view.cy) * (acy - view.cy);
      const bd2 =
        (bcx - view.cx) * (bcx - view.cx) + (bcy - view.cy) * (bcy - view.cy);
      return bd2 - ad2; // larger distance first
    }
    return 0;
  });
  // Important: demoting doesn't immediately lower totalTextureBytes (we release refs first,
  // destruction happens in enforceTextureBudget). Track an estimated freed byte count so we stop early.
  let freedEstimate = 0;
  let downCount = 0;
  for (const s of candidates) {
    if (totalTextureBytes - freedEstimate <= budgetBytes) break;
    const url: any = (s as any).__currentTexUrl;
    const ent = url ? textureCache.get(url) : undefined;
    if (ent) freedEstimate += ent.bytes;
    // Prefer downgrading to a lower-tier texture over full placeholder eviction
    // const downgraded = demote
    // if (!downgraded)  demote to placeholder
    downCount++;
  }
  // Final sweep of unreferenced textures (LRU) if still over
  scheduleEnforceTextureBudget();
  const diag: any = ((window as any).__frameDiag ||= {});
  diag.down = (diag.down || 0) + downCount;
  const t1 = performance.now();
  diag.budgetMs = (diag.budgetMs || 0) + (t1 - t0);
}

export function ensureCardImage(sprite: CardSprite) {
  // Delegate to tiered loader with coalescing to avoid repeated scheduling
  if (sprite.__imgLoaded) return;
  ensureTextureTier(sprite, 0);
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
  const avgDecode = __dbg.decode.count
    ? __dbg.decode.totalMs / __dbg.decode.count
    : 0;
  return {
    totalTextureMB: totalTextureBytes / 1048576,
    budgetMB: settings.gpuBudgetMB,
    overBudgetMB: over / 1048576,
    cacheEntries: textureCache.size,
    inflight: inflightTex.size,
    decode: {
      count: __dbg.decode.count,
      avgMs: avgDecode,
      maxMs: __dbg.decode.maxMs,
    },
    qPeak: __dbg.qPeak,
    evict: {
      count: __dbg.evict.count,
      bytesMB: __dbg.evict.bytes / 1048576,
      lastMs: __dbg.evict.lastMs,
    },
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
  if (target === 2) {
    return (
      face?.image_uris?.png ||
      card.image_uris?.png ||
      face?.image_uris?.large ||
      card.image_uris?.large
    );
  }
  if (target === 1) {
    return (
      face?.image_uris?.normal ||
      card.image_uris?.normal ||
      face?.image_uris?.large ||
      card.image_uris?.large
    );
  }
  // level 0
  return (
    face?.image_uris?.small ||
    card.image_uris?.small ||
    face?.image_uris?.normal ||
    card.image_uris?.normal
  );
}

function adoptCachedTexture(
  sprite: CardSprite,
  url: string,
  ent: TexCacheEntry,
  level: 0 | 1 | 2,
) {
  ent.refs++;
  ent.lastUsed = performance.now();
  const prevUrl: any = (sprite as any).__currentTexUrl;
  if (prevUrl && prevUrl !== url) {
    const prevEnt = textureCache.get(prevUrl);
    if (prevEnt) prevEnt.refs = Math.max(0, prevEnt.refs - 1);
  }
  (sprite as any).__currentTexUrl = url;
  sprite.texture = ent.tex;
  sprite.width = 100;
  sprite.height = 140;
  sprite.__imgLoaded = true;
  sprite.__imgLoading = false;
  sprite.__qualityLevel = level;
}

function forcePlaceholder(sprite: CardSprite) {
  const prevUrl: string | undefined = (sprite as any).__currentTexUrl;
  if (prevUrl) {
    const pe = textureCache.get(prevUrl);
    if (pe) pe.refs = Math.max(0, pe.refs - 1);
    (sprite as any).__currentTexUrl = undefined;
  }
  sprite.__imgLoaded = false;
  sprite.__imgLoading = false;
  sprite.__qualityLevel = 0;
  updateCardSpriteAppearance(sprite, SelectionStore.state.cardIds.has(sprite.__id));
}

export function ensureTextureTier(
  sprite: CardSprite,
  level: 0 | 1 | 2
): "noop" | "swap" | "scheduled" | "placeholder" {
  const target: 0 | 1 | 2 = (settings.disablePngTier && level === 2 ? 1 : level) as 0 | 1 | 2;
  const wantUrl = resolveTierUrl(sprite, target);
  const curUrl: string | undefined = (sprite as any).__currentTexUrl;
  const curQ = sprite.__qualityLevel ?? -1;
  if (wantUrl && curUrl === wantUrl && curQ >= target && isTextureUsable(sprite.texture)) {
    // Clear any stale pending if we already have what we want
    if (sprite.__pendingUrl) {
      // Cancel any pending desire; we're satisfied
      decDesiredUrl(sprite.__pendingUrl);
      sprite.__pendingUrl = undefined;
      sprite.__pendingLevel = undefined as any;
      sprite.__pendingPromise = null;
    }
    return "noop";
  }
  if (wantUrl) {
    const cached = textureCache.get(wantUrl);
    if (cached) {
      adoptCachedTexture(sprite, wantUrl, cached, target);
      // Ensure eventual cleanup of any newly unreferenced textures
      if (sprite.__pendingUrl) {
        decDesiredUrl(sprite.__pendingUrl);
        sprite.__pendingUrl = undefined;
        sprite.__pendingLevel = undefined as any;
        sprite.__pendingPromise = null;
      }
      scheduleEnforceTextureBudget();
      return "swap";
    }
    // If a pending request for the same desired URL exists, don't reschedule per frame
    if (sprite.__pendingUrl === wantUrl && sprite.__pendingLevel === target && sprite.__pendingPromise) {
      return "scheduled";
    }
    // Record new desired and schedule a one-time load; coalesce via inflightTex in loader
    if (sprite.__pendingUrl && sprite.__pendingUrl !== wantUrl) {
      // Supersede previous desire
      decDesiredUrl(sprite.__pendingUrl);
    }
    sprite.__pendingUrl = wantUrl;
    sprite.__pendingLevel = target;
    const p = loadTextureFromCachedURL(wantUrl);
    sprite.__pendingPromise = p;
    // Mark desire so queue won't cancel this as stale; also mark loading for base-load
    incDesiredUrl(wantUrl);
    if (!sprite.__imgLoaded) sprite.__imgLoading = true;
    p.then((tex) => {
      // If desired changed while loading, skip adoption (newer call will handle)
      if (sprite.__pendingUrl !== wantUrl || sprite.__pendingLevel !== target) return;
      const ent = textureCache.get(wantUrl);
      if (ent) {
        adoptCachedTexture(sprite, wantUrl, ent, target);
      } else if (isTextureUsable(tex)) {
        // Rare fallback: adopt direct
        const prevUrl: any = (sprite as any).__currentTexUrl;
        if (prevUrl) {
          const prevEnt = textureCache.get(prevUrl);
          if (prevEnt) prevEnt.refs = Math.max(0, prevEnt.refs - 1);
        }
        (sprite as any).__currentTexUrl = wantUrl;
        sprite.texture = tex;
        sprite.width = 100;
        sprite.height = 140;
        sprite.__imgLoaded = true;
        sprite.__qualityLevel = target;
      }
      // Clear pending and enforce budget
      sprite.__pendingPromise = null;
      decDesiredUrl(wantUrl);
      sprite.__pendingUrl = undefined;
      sprite.__pendingLevel = undefined as any;
      sprite.__imgLoading = false;
      scheduleEnforceTextureBudget();
    }).catch(() => {
      // Clear pending on failure; allow future attempts
      sprite.__pendingPromise = null;
      decDesiredUrl(wantUrl);
      // Keep __pendingUrl as a marker of desire; next ensure call may supersede or retry with backoff
      sprite.__imgLoading = false;
    });
    return "scheduled";
  }
  // Could not adopt desired URL (no decode allowed or no URL); prefer small cached else placeholder
  const smallUrl = resolveTierUrl(sprite, 0);
  if (smallUrl) {
    const smallEnt = textureCache.get(smallUrl);
    if (smallEnt) {
      adoptCachedTexture(sprite, smallUrl, smallEnt, 0);
      if (sprite.__pendingUrl) {
        decDesiredUrl(sprite.__pendingUrl);
        sprite.__pendingUrl = undefined;
        sprite.__pendingLevel = undefined as any;
        sprite.__pendingPromise = null;
      }
      scheduleEnforceTextureBudget();
      return "swap";
    }
  }
  forcePlaceholder(sprite);
  if (sprite.__pendingUrl) {
    decDesiredUrl(sprite.__pendingUrl);
    sprite.__pendingUrl = undefined;
    sprite.__pendingLevel = undefined as any;
    sprite.__pendingPromise = null;
  }
  return "placeholder";
}

export function ensureLowOrPlaceholder(sprite: CardSprite): "low" | "placeholder" | "noop" {
  const curQ = sprite.__qualityLevel ?? -1;
  const curUrl: string | undefined = (sprite as any).__currentTexUrl;
  if (curQ === 0 && curUrl && isTextureUsable(sprite.texture)) return "noop";
  const url0 = resolveTierUrl(sprite, 0);
  if (url0) {
    const ent = textureCache.get(url0);
    if (ent) {
      adoptCachedTexture(sprite, url0, ent, 0);
      scheduleEnforceTextureBudget();
      return "low";
    }
  }
  forcePlaceholder(sprite);
  return "placeholder";
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

// --- Double-sided (Reversible) Badge ---
// Only treat true double-faced transform style cards as reversible for UI badge.
// Exclude adventure, split, aftermath, flip etc. which have multiple faces in data but not a reversible back face.
const TRUE_DFC_LAYOUTS = new Set([
  "transform",
  "modal_dfc",
  "double_faced_token",
  "battle",
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
    // Exclude non-reversible multi-face layouts (including meld components)
    if (/^(adventure|split|aftermath|flip|prototype|meld)$/.test(layout))
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
      .fill({ color: Colors.badgeBg(), alpha: 0.9 })
      .stroke({ color: Colors.badgeStroke(), width: 2 });
    // Smaller arrows scaled to new radius
    g.moveTo(-2, -1)
      .lineTo(0, -5)
      .lineTo(2, -1)
      .stroke({ color: Colors.badgeArrows(), width: 2 });
    g.moveTo(2, 1)
      .lineTo(0, 5)
      .lineTo(-2, 1)
      .stroke({ color: Colors.badgeArrows(), width: 2 });
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
    } else {
      // Load small immediately, then promote without waiting an extra frame
      ensureCardImage(sprite);
      // updateCardTextureForScale(sprite, scale);
    }
  } catch {
    ensureCardImage(sprite);
    requestAnimationFrame(() => {
      const scale = (sprite.parent as any)?.scale?.x || 1;
      // updateCardTextureForScale(sprite, scale);
    });
  }
  ensureDoubleSidedBadge(sprite); // reposition after flip
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
