// Lightweight Scryfall search client with paging and progress reporting.
// Usage: searchScryfall('o:infect t:creature cmc<=3', { maxCards: 120, unique: 'cards' })

export interface ScryfallCard {
  id?: string;
  name?: string;
  object?: string;
  image_uris?: Record<string, string>;
  card_faces?: Array<{ image_uris?: Record<string, string>; name?: string; oracle_text?: string; type_line?: string }>;
  [k: string]: any;
}

export interface SearchOptions {
  maxCards?: number; // optional cap to stop paging early; default is unlimited
  unique?: 'cards' | 'art' | 'prints';
  includeExtras?: boolean;
  includeMultilingual?: boolean;
  order?: string; // e.g. 'released'
  dir?: 'asc' | 'desc';
  onProgress?: (fetched: number, total?: number) => void;
  signal?: AbortSignal;
}

interface ScryfallList {
  object: 'list';
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
  opts: SearchOptions = {}
): Promise<ScryfallCard[]> {
  const {
  maxCards = Number.POSITIVE_INFINITY,
    unique = 'cards',
    includeExtras = false,
    includeMultilingual = false,
    order = 'released',
    dir = 'desc',
    onProgress,
    signal,
  } = opts;

  const out: ScryfallCard[] = [];
  let total: number | undefined;

  function makeUrl(pageUrl?: string) {
    if (pageUrl) return pageUrl; // server-provided next_page url
    const base = new URL('https://api.scryfall.com/cards/search');
    base.searchParams.set('q', query);
    base.searchParams.set('unique', unique);
    base.searchParams.set('include_extras', includeExtras ? 'true' : 'false');
    base.searchParams.set('include_multilingual', includeMultilingual ? 'true' : 'false');
    if (order) base.searchParams.set('order', order);
    if (dir) base.searchParams.set('dir', dir);
    return base.toString();
  }

  let nextUrl: string | undefined = makeUrl();
  // A tiny delay between pages to be polite
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  while (nextUrl) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await fetch(nextUrl, { signal, cache: 'no-store' });
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Scryfall error ${res.status}: ${text || res.statusText}`);
    }
  const json = (await res.json()) as ScryfallList | any;
    if (!json || json.object !== 'list' || !Array.isArray(json.data)) {
      throw new Error('Unexpected Scryfall response');
    }
  if (typeof json.total_cards === 'number') total = json.total_cards;
    for (const card of json.data) {
      out.push(card);
      if (onProgress) onProgress(out.length, total);
      if (out.length >= maxCards) return out;
    }
    if (json.has_more && json.next_page) nextUrl = json.next_page;
    else break;
    // brief backoff before next page
    await delay(120);
  }
  return out;
}

async function safeText(res: Response): Promise<string | null> {
  try { return await res.text(); } catch { return null; }
}
