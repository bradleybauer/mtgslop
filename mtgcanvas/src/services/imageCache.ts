// Persistent image cache using IndexedDB to avoid re-fetching Scryfall images across sessions.
// Updated design ("unlimited" mode):
//  - Object store 'imgs' keyed by canonical URL, value: { url, blob, ctype, size, time }
//  - No eviction: we retain everything the browser quota allows (browser may still evict under pressure)
//  - Aggressive de-duplication of in-flight network requests & reuse of object URLs
//  - Extra debugging / sanity instrumentation to trace cache behavior and network usage
//  - Goal: MINIMIZE NETWORK USAGE while keeping code path simple & fast

const DB_NAME = "mtgImageCache";
const DB_VERSION = 1;
const STORE = "imgs";
// Budget concept retained only for reporting; set to Infinity (or an extremely large number) to disable eviction logic.
// You can still override with localStorage.setItem('imgCacheBudgetMB', '<number>') if you want a soft limit report.
const BUDGET_MB_RAW = localStorage.getItem("imgCacheBudgetMB");
const BUDGET_MB =
  BUDGET_MB_RAW === null ? Number.POSITIVE_INFINITY : Number(BUDGET_MB_RAW);
const BYTE_BUDGET = !isFinite(BUDGET_MB)
  ? Number.POSITIVE_INFINITY
  : BUDGET_MB * 1024 * 1024;
export async function getCacheUsage(): Promise<{
  count: number;
  bytes: number;
  budget: number;
  over: boolean;
}> {
  try {
    const db = await openDB();
    let bytes = 0;
    let count = 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) {
          resolve();
          return;
        }
        const v: any = c.value;
        bytes += v.size || 0;
        count++;
        c.continue();
      };
      cursor.onerror = () => reject(cursor.error!);
    });
    return {
      count,
      bytes,
      budget: BYTE_BUDGET,
      over: isFinite(BYTE_BUDGET) ? bytes > BYTE_BUDGET : false,
    };
  } catch {
    return { count: 0, bytes: 0, budget: BYTE_BUDGET, over: false };
  }
}

interface CacheEntryMeta {
  url: string;
  blob: Blob;
  ctype: string;
  size: number;
  time: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not supported"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "url" });
        os.createIndex("time", "time");
      }
    };
    req.onerror = () => reject(req.error!);
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

export async function getEntry(url: string): Promise<CacheEntryMeta | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const r = store.get(url);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error!);
    });
  } catch {
    return null;
  }
}

async function putEntry(meta: CacheEntryMeta) {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(meta);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error!);
    });
  } catch {}
}

// Eviction disabled: keep function placeholders for compatibility.
async function computeTotalAndMaybeEvict(_log = false) {
  /* no-op in unlimited mode */
}
export async function enforceCacheBudget() {
  /* no-op */
}

// Canonicalization: preserve the full URL including query string.
// Important: Scryfall encodes front/back face and size via query params for non-PNG URLs.
// Stripping the query conflates distinct images (e.g., face=front vs face=back) and breaks DFC loading.
function canonicalize(url: string) {
  try {
    return url;
  } catch {
    return url;
  }
}

// In-memory de-duplication maps
const inFlight = new Map<string, Promise<CachedImage>>(); // url -> CachedImage
const objectUrlCache = new Map<string, string>(); // url -> objectURL for session
// Parallel blob cache (canonical url -> Blob) so decode path can avoid re-fetching object URL.
// Only populated for IDB + network paths (legacy session hits may start empty until first materialization).
const blobCache = new Map<string, Blob>();

// Metrics & debug instrumentation
let sessionHits = 0; // objectUrlCache hit
let idbHits = 0; // IndexedDB hit
let netFetches = 0; // successful network fetch count
let netBytes = 0; // sum of blob sizes from network
let lastNetMs = 0; // last network fetch duration (ms)
let canonicalHits = 0; // hits via canonical key
let debugLogged = 0; // network debug logs emitted (initial sample)
let netErrors = 0; // failed network attempts
let resourceErrors = 0; // ERR_INSUFFICIENT_RESOURCES occurrences
let duplicateCanonicals = 0; // times original+canonical differed and both requested
let unexpectedSmallBlob = 0; // blobs < 1KB flagged (maybe error image?)

let debugEnabled = localStorage.getItem("imgCacheDebug") === "1";
function dbg(...args: any[]) {
  if (debugEnabled) console.log("[imageCache]", ...args);
}
export function enableImageCacheDebug(on: boolean) {
  debugEnabled = on;
  localStorage.setItem("imgCacheDebug", on ? "1" : "0");
}

// Concurrency limiter for network fetches (avoid browser resource exhaustion)
const MAX_FETCH_CONCURRENCY = Number(
  localStorage.getItem("imgFetchConcurrency") || "32",
);
let activeFetches = 0;
const waitQueue: (() => void)[] = [];
function acquireFetchSlot(): Promise<void> {
  if (activeFetches < MAX_FETCH_CONCURRENCY) {
    activeFetches++;
    return Promise.resolve();
  }
  return new Promise((res) =>
    waitQueue.push(() => {
      activeFetches++;
      res();
    }),
  );
}
function releaseFetchSlot() {
  activeFetches--;
  if (activeFetches < 0) activeFetches = 0;
  const next = waitQueue.shift();
  if (next) next();
}

export function getImageCacheStats() {
  const avg = netFetches ? netBytes / netFetches : 0;
  return {
    sessionHits,
    idbHits,
    netFetches,
    netBytes,
    avgFetchKB: avg / 1024,
    lastNetMs,
    canonicalHits,
    netErrors,
    resourceErrors,
    activeFetches,
    queuedFetches: waitQueue.length,
    duplicateCanonicals,
    unexpectedSmallBlob,
  };
}

export function printImageCacheReport() {
  getCacheUsage().then((u) => {
    const s = getImageCacheStats();
    console.log("[imageCache report]", {
      count: u.count,
      storedMB: (u.bytes / 1048576).toFixed(2),
      budgetMB: isFinite(u.budget) ? (u.budget / 1048576).toFixed(1) : "∞",
      over: u.over,
      sessionHits: s.sessionHits,
      idbHits: s.idbHits,
      netFetches: s.netFetches,
      netMB: (s.netBytes / 1048576).toFixed(2),
      avgFetchKB: s.avgFetchKB.toFixed(1),
      canonHits: s.canonicalHits,
      dupCanon: s.duplicateCanonicals,
      smallBlobs: s.unexpectedSmallBlob,
      netErrors: s.netErrors,
      resourceErrors: s.resourceErrors,
    });
  });
}

export async function hasCachedURL(url: string): Promise<boolean> {
  if (objectUrlCache.has(url)) return true;
  const e = (await getEntry(url)) || (await getEntry(canonicalize(url)));
  return !!e;
}

interface CachedImage {
  objectURL: string;
  blob?: Blob;
  canonical: string;
  source: "session" | "idb" | "network";
  size?: number;
}

async function fetchAndCache(url: string): Promise<CachedImage> {
  const canonical = canonicalize(url);
  // Session hits (prefer canonical)
  const hit = objectUrlCache.get(canonical) || objectUrlCache.get(url);
  if (hit) {
    sessionHits++;
    if (hit === objectUrlCache.get(canonical) && canonical !== url) {
      canonicalHits++;
      duplicateCanonicals++;
    }
    dbg(
      "session hit",
      canonical !== url ? { canonical, original: url } : canonical,
    );
    return {
      objectURL: hit,
      blob: blobCache.get(canonical),
      canonical,
      source: "session",
      size: blobCache.get(canonical)?.size,
    };
  }
  // IndexedDB
  const cached = await getEntry(canonical);
  if (cached) {
    const objUrl = URL.createObjectURL(cached.blob);
    objectUrlCache.set(canonical, objUrl);
    objectUrlCache.set(url, objUrl);
    blobCache.set(canonical, cached.blob);
    // No touch needed (we ignore time for eviction-less mode)
    idbHits++;
    if (canonical !== url) canonicalHits++;
    if (cached.size < 1024) {
      unexpectedSmallBlob++;
      dbg("idb small blob?", canonical, cached.size);
    }
    dbg("idb hit", canonical, (cached.size / 1024).toFixed(1) + "KB");
    return {
      objectURL: objUrl,
      blob: cached.blob,
      canonical,
      source: "idb",
      size: cached.size,
    };
  }
  // Network
  const start = performance.now();
  await acquireFetchSlot();
  try {
    const resp = await fetch(url, { mode: "cors", cache: "default" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const blob = await resp.blob();
    const meta: CacheEntryMeta = {
      url: canonical,
      blob,
      ctype: resp.headers.get("content-type") || "",
      size: blob.size,
      time: Date.now(),
    };
    putEntry(meta);
    const objUrl = URL.createObjectURL(blob);
    objectUrlCache.set(canonical, objUrl);
    objectUrlCache.set(url, objUrl);
    blobCache.set(canonical, blob);
    netFetches++;
    netBytes += blob.size;
    lastNetMs = performance.now() - start;
    if (blob.size < 1024) {
      unexpectedSmallBlob++;
      dbg("NET very small blob", canonical, blob.size);
    }
    if (debugEnabled)
      dbg(
        "NET",
        canonical,
        (blob.size / 1024).toFixed(1) + "KB",
        "t=" + lastNetMs.toFixed(1) + "ms",
      );
    else if (debugLogged < 10) {
      console.log(
        "[imageCache] NET",
        canonical,
        "->",
        (blob.size / 1024).toFixed(1) + "KB",
        "t=" + lastNetMs.toFixed(1) + "ms",
      );
      debugLogged++;
    }
    return {
      objectURL: objUrl,
      blob,
      canonical,
      source: "network",
      size: blob.size,
    };
  } catch (e: any) {
    netErrors++;
    if (e && ("" + e).includes("ERR_INSUFFICIENT_RESOURCES")) resourceErrors++;
    throw e;
  } finally {
    releaseFetchSlot();
  }
}

export async function getCachedImage(url: string): Promise<CachedImage> {
  if (inFlight.has(url)) return inFlight.get(url)!;
  const p = fetchAndCache(url).finally(() => {
    inFlight.delete(url);
  });
  inFlight.set(url, p);
  return p;
}

// Backward compatible (string-only) API retained
export async function getCachedObjectURL(url: string): Promise<string> {
  return (await getCachedImage(url)).objectURL;
}

// Utility to clear cache (not wired to UI yet)
export async function clearImageCache() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
  } catch {}
  objectUrlCache.forEach((u) => URL.revokeObjectURL(u));
  objectUrlCache.clear();
}
