// Lightweight Scryfall search client with paging and progress reporting.
// Global concurrency for Scryfall requests (search + collection + named fallback)
export const SCRYFALL_CONCURRENCY = 6;
// Usage: searchScryfall('o:infect t:creature cmc<=3', { maxCards: 120, unique: 'cards' })

export interface ScryfallCard {
  id?: string;
  name?: string;
  object?: string;
  image_uris?: Record<string, string>;
  card_faces?: Array<{
    image_uris?: Record<string, string>;
    name?: string;
    oracle_text?: string;
    type_line?: string;
  }>;
  [k: string]: any;
}

export interface SearchOptions {
  maxCards?: number; // optional cap to stop paging early; default is unlimited
  unique?: "cards" | "art" | "prints";
  includeExtras?: boolean;
  includeMultilingual?: boolean;
  order?: string; // e.g. 'released'
  dir?: "asc" | "desc";
  onProgress?: (fetched: number, total?: number) => void;
  signal?: AbortSignal;
  // Performance controls
  throttleMs?: number; // optional tiny delay between page fetches
  cache?: RequestCache; // fetch cache mode; default browser behavior
  maxRetries?: number; // retries for 429/5xx
  backoffBaseMs?: number; // base backoff
}

interface ScryfallList {
  object: "list";
  total_cards?: number;
  has_more?: boolean;
  next_page?: string;
  data: ScryfallCard[];
}

/**
 * Perform a paged Scryfall search. Respects maxCards and reports progress.
 * Returns a list of card objects (as-is from Scryfall).
 */
export async function searchScryfall(
  query: string,
  opts: SearchOptions = {},
): Promise<ScryfallCard[]> {
  const {
    maxCards = Number.POSITIVE_INFINITY,
    unique = "cards",
    includeExtras = false,
    includeMultilingual = false,
    order = "released",
    dir = "desc",
    onProgress,
    signal,
    throttleMs = 0,
    cache = "default",
    maxRetries = 4,
    backoffBaseMs = 250,
  } = opts;

  const out: ScryfallCard[] = [];
  let total: number | undefined;

  function makeUrl(pageUrl?: string) {
    if (pageUrl) return pageUrl; // server-provided next_page url
    const base = new URL("https://api.scryfall.com/cards/search");
    base.searchParams.set("q", query);
    base.searchParams.set("unique", unique);
    base.searchParams.set("include_extras", includeExtras ? "true" : "false");
    base.searchParams.set(
      "include_multilingual",
      includeMultilingual ? "true" : "false",
    );
    if (order) base.searchParams.set("order", order);
    if (dir) base.searchParams.set("dir", dir);
    return base.toString();
  }

  // Support cooperative cancellation
  const ctrl = new AbortController();
  const abort = (reason?: any) => {
    try {
      ctrl.abort(reason);
    } catch {
      /* no-op */
    }
  };
  if (signal) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    signal.addEventListener("abort", () => abort(signal.reason), {
      once: true,
    });
  }

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function pageFromUrl(url: string | undefined): number {
    if (!url) return NaN;
    try {
      const u = new URL(url);
      const p = u.searchParams.get("page");
      return p ? parseInt(p, 10) : 1;
    } catch {
      return NaN;
    }
  }

  async function fetchWithRetry(
    url: string,
    attempt = 0,
  ): Promise<ScryfallList> {
    // Optional throttle to avoid bursting
    if (throttleMs > 0) await delay(throttleMs);
    const res = await fetch(url, { signal: ctrl.signal, cache });
    if (res.ok) {
      const json = (await res.json()) as ScryfallList | any;
      if (!json || json.object !== "list" || !Array.isArray(json.data))
        throw new Error("Unexpected Scryfall response");
      return json as ScryfallList;
    }
    // Retry on 429/5xx
    if (
      (res.status === 429 || (res.status >= 500 && res.status < 600)) &&
      attempt < maxRetries
    ) {
      const ra = res.headers.get("Retry-After");
      let waitMs = ra
        ? Math.max(0, Math.floor(parseFloat(ra) * 1000))
        : Math.floor(backoffBaseMs * Math.pow(2, attempt));
      // jitter
      waitMs += Math.floor(Math.random() * 100);
      await delay(waitMs);
      return fetchWithRetry(url, attempt + 1);
    }
    const text = await safeText(res);
    throw new Error(`Scryfall error ${res.status}: ${text || res.statusText}`);
  }

  // First page sequentially (establish total + initial results)
  const firstUrl = makeUrl();
  const first = await fetchWithRetry(firstUrl);
  if (typeof first.total_cards === "number") total = first.total_cards;

  // Page buffers keyed by page number to preserve order
  const pages = new Map<number, ScryfallCard[]>();
  const firstPageNum = pageFromUrl(firstUrl) || 1;
  pages.set(firstPageNum, first.data);

  // Emit pages in order as they become available
  let nextEmit = firstPageNum;
  const flush = () => {
    while (pages.has(nextEmit)) {
      const cards = pages.get(nextEmit)!;
      pages.delete(nextEmit);
      for (const card of cards) {
        out.push(card);
        if (onProgress) onProgress(out.length, total);
        if (out.length >= maxCards) {
          abort();
          return;
        }
      }
      nextEmit++;
    }
  };
  flush();
  if (out.length >= maxCards) return out;

  // Work queue of next_page URLs
  type Job = { url: string; page: number };
  const queue: Job[] = [];
  const seen = new Set<string>();
  const pushJob = (url: string | undefined) => {
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    queue.push({ url, page: pageFromUrl(url) || nextEmit + queue.length + 1 });
  };
  pushJob(first.next_page);

  let done = false;
  const workers: Promise<void>[] = [];

  async function worker() {
    while (!done) {
      if (ctrl.signal.aborted) return;
      const job = queue.shift();
      if (!job) break;
      try {
        const json = await fetchWithRetry(job.url);
        pages.set(job.page, json.data);
        // If there's a next page, enqueue it with incremented page number
        if (json.has_more && json.next_page) pushJob(json.next_page);
        flush();
        if (
          (json.has_more === false || !json.next_page) &&
          queue.length === 0
        ) {
          // Last page observed and no more work queued
          done = true;
        }
        if (out.length >= maxCards) {
          done = true;
          abort();
          return;
        }
      } catch (e) {
        // If aborted, just exit; else rethrow
        if ((e as any)?.name === "AbortError") return;
        throw e;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(SCRYFALL_CONCURRENCY | 0, 8));
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.allSettled(workers);

  // Final flush in case anything remains
  flush();
  return out;
}

/**
 * Fetch cards by exact names using Scryfall's /cards/collection endpoint.
 * Names are matched exactly by Scryfall's standard name matching. Requests are
 * batched to 75 identifiers per request (Scryfall limit).
 * Returns a map of lowercase name -> card and the list of unknown names.
 */
export async function fetchScryfallByNames(
  names: string[],
  opts: { signal?: AbortSignal; onProgress?: (done: number, total?: number) => void } = {},
): Promise<{ byName: Map<string, ScryfallCard>; unknown: string[] }> {
  // Normalize and de-duplicate names while preserving a map to original casings
  const norm = (s: string) => (s || "").trim();
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const v = norm(n);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(v);
  }
  const byName = new Map<string, ScryfallCard>();
  const notFound = new Set<string>();
  const total = unique.length;
  let done = 0;
  const report = () => opts.onProgress?.(done, total);
  // Chunk into batches of 75
  const CHUNK = 75;
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) {
    batches.push(unique.slice(i, i + CHUNK));
  }
  const queue = batches.slice();
  const workers: Promise<void>[] = [];
  const cc = Math.max(1, Math.min(SCRYFALL_CONCURRENCY, 8));
  const controller = new AbortController();
  const signal = opts.signal;
  if (signal) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  function indexCardNames(c: ScryfallCard) {
    if (!c || !c.name) return;
    const main = c.name.toLowerCase();
    if (!byName.has(main)) byName.set(main, c);
    const faces = Array.isArray(c.card_faces) ? c.card_faces : [];
    for (const f of faces) {
      const fn = (f?.name || "").toLowerCase();
      if (fn && !byName.has(fn)) byName.set(fn, c);
    }
  }
  async function runOne(batch: string[]) {
    const body = { identifiers: batch.map((name) => ({ name })) } as any;
    const res = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(
        `Scryfall collection error ${res.status}: ${text || res.statusText}`,
      );
    }
    const json = (await res.json()) as any;
  const data = Array.isArray(json?.data) ? (json.data as ScryfallCard[]) : [];
  for (const c of data) indexCardNames(c);
    if (Array.isArray(json?.not_found)) {
      for (const nf of json.not_found) {
        const nm = (nf?.name || "").toString().toLowerCase();
        if (nm) notFound.add(nm);
      }
    }
    done += batch.length;
    report();
  }
  async function worker() {
    while (queue.length) {
      const b = queue.shift();
      if (!b) break;
      await runOne(b);
    }
  }
  for (let i = 0; i < cc; i++) workers.push(worker());
  report();
  await Promise.all(workers);
  // Fallback: try fuzzy Named API for unresolved names (common for DFC face names)
  if (notFound.size) {
    const unresolved = [...notFound];
    notFound.clear();
    async function worker2() {
      while (unresolved.length) {
        const nm = unresolved.shift();
        if (!nm) break;
        try {
          const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(nm)}`;
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) {
            if (res.status === 404) {
              notFound.add(nm);
              continue;
            }
            const text = await safeText(res);
            throw new Error(`Scryfall named error ${res.status}: ${text || res.statusText}`);
          }
          const card = (await res.json()) as ScryfallCard;
          indexCardNames(card);
          done += 1;
          report();
        } catch (e: any) {
          if (e?.name === "AbortError") return;
          notFound.add(nm);
        }
      }
    }
  const workers2: Promise<void>[] = [];
  for (let i = 0; i < cc; i++) workers2.push(worker2());
    await Promise.all(workers2);
  }
  // Derive unknowns by comparing the unique set to resolved keys, union not_found
  for (const n of unique) {
    const key = n.toLowerCase();
    if (!byName.has(key)) notFound.add(key);
  }
  return { byName, unknown: [...notFound] };
}

async function safeText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}
