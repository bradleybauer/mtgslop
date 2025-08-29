// Lightweight Scryfall search client with paging and progress reporting.
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
  concurrency?: number; // parallel page fetches; preserves order in output
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
    concurrency = 3,
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
  let firstUrl = makeUrl();
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

  const workerCount = Math.max(1, Math.min(concurrency | 0, 8));
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.allSettled(workers);

  // Final flush in case anything remains
  flush();
  return out;
}

async function safeText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}
