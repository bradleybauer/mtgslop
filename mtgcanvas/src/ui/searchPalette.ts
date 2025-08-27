// Lightweight search palette: Ctrl+F opens, Enter creates group with matches.
// Searches across in-memory loaded card sprites (name + oracle_text) with OR semantics between tokens.
// Future: upgrade to SQLite FTS when persistence/importer active.

import type { CardSprite } from '../scene/cardNode';
import { HEADER_HEIGHT } from '../scene/groupNode';
import { parseScryfallQuery } from '../search/scryfallQuery';

export interface SearchPaletteOptions {
  getSprites: () => CardSprite[];
  createGroupForSprites: (spriteIds: number[], name: string) => void;
  focusSprite: (id: number) => void; // centers / fits viewport around a sprite
}

interface LastQueryResult { query: string; total: number; limited: number; }

export function installSearchPalette(opts: SearchPaletteOptions) {
  const { getSprites, createGroupForSprites, focusSprite } = opts;
  let palette: HTMLDivElement | null = null;
  let inputEl: HTMLInputElement | null = null;
  let infoEl: HTMLDivElement | null = null;
  let filtersEl: HTMLDivElement | null = null;
  let last: LastQueryResult | null = null;
  let currentMatches: number[] = [];
  let cursor = 0; // index into currentMatches
  let navEl: HTMLDivElement | null = null; let counterEl: HTMLSpanElement | null = null; let prevBtn: HTMLButtonElement | null = null; let nextBtn: HTMLButtonElement | null = null; let groupBtn: HTMLButtonElement | null = null;
  type FilterMode = 'all' | 'ungrouped' | 'grouped';
  let filterMode: FilterMode = 'all';

  function ensure() {
    if (palette) return palette;
    const wrap = document.createElement('div');
    palette = wrap;
    wrap.id = 'search-palette';
  // Widened palette to better fit enlarged font sizes (was min 320 / max 400)
  wrap.style.cssText = 'position:fixed;top:14%;left:50%;transform:translateX(-50%);background:#0f181d;border:1px solid #27414f;border-radius:14px;padding:18px 22px;z-index:10050;display:flex;flex-direction:column;gap:14px;min-width:440px;max-width:760px;width:clamp(440px,56vw,760px);box-shadow:0 10px 48px -12px #000c;font:14px "Inter",system-ui,sans-serif;color:#cfe3ec;';
  wrap.innerHTML = '<div style="font-size:26px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;opacity:.85;">Search Cards</div>';
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.placeholder = 'Type keywords (space = OR). Press Enter to group results.';
  inputEl.style.cssText = 'background:#182830;border:1px solid #325261;border-radius:6px;padding:14px 16px;color:#e8f7ff;font:28px "Inter",system-ui;width:100%;max-width:100%;box-sizing:border-box;outline:none;';
    wrap.appendChild(inputEl);
    // Filter pills
  filtersEl = document.createElement('div');
    filtersEl.style.cssText='display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;';
    function makePill(label:string, mode:FilterMode){
      const b = document.createElement('button');
      b.type='button';
      b.textContent=label;
  b.style.cssText='background:#1d2c34;border:1px solid #2f4955;color:#c6dde6;padding:8px 14px;font:24px "Inter",system-ui;border-radius:20px;cursor:pointer;min-width:0;';
      const update=()=>{ b.style.opacity = filterMode===mode? '1':'0.55'; b.style.outline = filterMode===mode? '1px solid #4d90a8':'none'; };
      b.onclick=()=> { filterMode = mode; updateAllPills(); runSearch(false); };
      (b as any).__update = update;
      return b;
    }
    const pillAll = makePill('All','all');
    const pillUng = makePill('Ungrouped','ungrouped');
    const pillGrp = makePill('Grouped','grouped');
    function updateAllPills(){ [pillAll,pillUng,pillGrp].forEach(p=> (p as any).__update()); }
    updateAllPills();
    filtersEl.append(pillAll,pillUng,pillGrp);
    wrap.appendChild(filtersEl);
    infoEl = document.createElement('div');
  infoEl.style.cssText = 'font-size:24px;min-height:32px;opacity:0.8;white-space:pre-line;';
    wrap.appendChild(infoEl);
    // Navigation bar (Prev / counter / Next / Group All)
    navEl = document.createElement('div');
  navEl.style.cssText='display:flex;align-items:center;gap:18px;font-size:26px;';
  prevBtn = document.createElement('button'); prevBtn.type='button'; prevBtn.textContent='◀'; prevBtn.title='Previous (Alt+Left)'; prevBtn.style.cssText='background:#1d2c34;border:1px solid #2f4955;color:#c6dde6;padding:10px 18px;font:26px "Inter";border-radius:10px;cursor:pointer;';
  nextBtn = document.createElement('button'); nextBtn.type='button'; nextBtn.textContent='▶'; nextBtn.title='Next (Alt+Right)'; nextBtn.style.cssText='background:#1d2c34;border:1px solid #2f4955;color:#c6dde6;padding:10px 18px;font:26px "Inter";border-radius:10px;cursor:pointer;';
    counterEl = document.createElement('span'); counterEl.textContent='0 / 0'; counterEl.style.opacity='0.75';
  groupBtn = document.createElement('button'); groupBtn.type='button'; groupBtn.textContent='Group All'; groupBtn.title='Create group from all matches (Enter)'; groupBtn.style.cssText='margin-left:auto;background:#254052;border:1px solid #356276;color:#d2f2ff;padding:10px 20px;font:24px "Inter";border-radius:10px;cursor:pointer;';
    function updateNavState(){
      const total = currentMatches.length; const show = total>0; if (navEl) navEl.style.display = show? 'flex':'none';
      if (counterEl) counterEl.textContent = total? `${cursor+1} / ${total}${last && last.limited===800?'*':''}` : '0 / 0';
      if (prevBtn) prevBtn.disabled = cursor<=0; if (nextBtn) nextBtn.disabled = cursor>=total-1;
    }
    function centerOnCursor(){ const id = currentMatches[cursor]; if (id!=null) focusSprite(id); }
    prevBtn.onclick=()=> { if (cursor>0){ cursor--; updateNavState(); centerOnCursor(); } };
    nextBtn.onclick=()=> { if (cursor<currentMatches.length-1){ cursor++; updateNavState(); centerOnCursor(); } };
    groupBtn.onclick=()=> { if (currentMatches.length){ const q = inputEl?.value.trim() || ''; const name = `Search: ${q} (${currentMatches.length})`; createGroupForSprites(currentMatches.slice(), name); hide(); } };
    navEl.append(prevBtn, counterEl, nextBtn, groupBtn);
    wrap.appendChild(navEl);
    const hint = document.createElement('div');
  hint.style.cssText = 'font-size:22px;opacity:.55;';
  hint.innerHTML = 'Scryfall-like syntax: name:, o:, t:, layout:, cmc>=3, c>=uw, -t:creature, foo OR bar.\nQuotes for phrases ("draw a card"). * wildcard inside words. Color identity: c=uw, c>=uw, c<=w, -c:w.\nLegacy: +token for MUST, a|b inline OR. Filters: All/Ungrouped/Grouped (Alt+A/U/G).';
    wrap.appendChild(hint);
    document.body.appendChild(wrap);
    // Global escape handler so palette closes even if focus moved to buttons
    const escListener = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && palette && palette.style.display !== 'none') {
        ev.stopPropagation();
        hide();
      }
    };
    // Attach once
    window.addEventListener('keydown', escListener, { capture: true });

    inputEl.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { hide(); }
      if (ev.key === 'Enter') {
        runSearch(true);
      }
      if (ev.altKey) {
        if (ev.key==='ArrowLeft') { if (cursor>0){ cursor--; updateNavState(); centerOnCursor(); ev.preventDefault(); } }
        if (ev.key==='ArrowRight') { if (cursor<currentMatches.length-1){ cursor++; updateNavState(); centerOnCursor(); ev.preventDefault(); } }
      }
      if (ev.altKey) {
        if (ev.key==='u' || ev.key==='U') { filterMode='ungrouped'; updateAllPills(); runSearch(false); ev.preventDefault(); }
        if (ev.key==='g' || ev.key==='G') { filterMode='grouped'; updateAllPills(); runSearch(false); ev.preventDefault(); }
        if (ev.key==='a' || ev.key==='A') { filterMode='all'; updateAllPills(); runSearch(false); ev.preventDefault(); }
      }
    });
    inputEl.addEventListener('input', () => runSearch(false));
    return wrap;
  }

  // Tokenizer with quoting & nuanced + handling.
  // Rules:
  //  - Quoted segments ("...") become single tokens; supports escaped \".
  //  - Leading + makes a MUST token only if the next character is a letter (A-Z) or a quote.
  //    So "+infect" => MUST("infect"), but "+1/+1" stays a normal token " +1/+1" literal unless quoted (user wants phrase including symbols).
  //  - +"phrase here" makes a MUST phrase.
  //  - Inside tokens a|b splits into OR alts in match phase (existing logic already handles token containing '|').
  function tokenize(q: string) {
    const src = q.trim();
    if (!src) return { any: [], must: [] };
    const any: string[] = []; const must: string[] = [];
    const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|\S+/g; // quoted block or bare token
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let token = m[0];
      let isMust = false;
      if (token.startsWith('+') && token.length > 1 && /[A-Za-z"]/.test(token[1])) {
        isMust = true;
        token = token.slice(1); // strip leading +
      }
      // Remove surrounding quotes if present
      if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
        token = token.slice(1, -1).replace(/\\"/g, '"');
      }
      token = token.toLowerCase();
      if (!token) continue;
      (isMust ? must : any).push(token);
    }
    return { any, must };
  }

  function match(card: any, tk: { any: string[]; must: string[] }) {
    const hay = ((card.name || '') + '\n' + (card.oracle_text || '')).toLowerCase();
    // MUST tokens: all must appear
    for (const m of tk.must) if (!hay.includes(m)) return false;
    if (!tk.any.length) return true; // only + tokens
    // ANY tokens: OR semantics; also allow explicit a|b syntax inside token
    for (const a of tk.any) {
      if (a.includes('|')) {
        const alts = a.split('|');
        if (alts.some(alt => alt && hay.includes(alt))) return true;
      } else if (hay.includes(a)) return true;
    }
    return false;
  }

  function runSearch(commit: boolean) {
    if (!inputEl || !infoEl) return;
    const q = inputEl.value.trim();
    if (!q) {
      // Clear prior state so reopening palette starts fresh (no stale nav / matches)
      infoEl.textContent = '';
      last = null;
      currentMatches = [];
      cursor = 0;
      if (counterEl) counterEl.textContent = '0 / 0';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (navEl) navEl.style.display = 'none';
      if (commit) hide();
      return;
    }
  // Try advanced Scryfall-like parse first
  const adv = parseScryfallQuery(q);
  const tk = adv ? null : tokenize(q);
    const sprites = getSprites();
    // const MAX = 800; // safety cap
  const matched: number[] = [];
    for (const s of sprites) {
      const c = (s as any).__card; if (!c) continue;
      if (filterMode==='ungrouped' && (s as any).__groupId) continue;
      if (filterMode==='grouped' && !(s as any).__groupId) continue;
      let ok=false;
      if (adv) ok = adv(c);
      else if (tk) ok = match(c, tk);
      if (ok) matched.push(s.__id);
    }
  currentMatches = matched;
  cursor = 0;
    last = { query: q, total: matched.length, limited: matched.length };
    infoEl.textContent = `Matches: ${matched.length}  |  Filter: ${filterMode}`;
  if (navEl) { (navEl as any).style ||= {}; }
  // Update nav and center on first match when not committing (preview mode)
  if (!commit && matched.length) { focusSprite(matched[0]); }
  if (navEl && (navEl as any).firstChild) { /* noop placeholder */ }
  // Refresh nav controls
  if (typeof window !== 'undefined') { const evt = (window as any).requestAnimationFrame ? (window as any).requestAnimationFrame : (fn:Function)=> setTimeout(fn,0); evt(()=> { const total = currentMatches.length; if (counterEl) counterEl.textContent = total? `${cursor+1} / ${total}`:'0 / 0'; if (prevBtn) prevBtn.disabled = cursor<=0; if (nextBtn) nextBtn.disabled = cursor>=total-1; if (navEl) navEl.style.display = total? 'flex':'none'; }); }
    if (typeof window !== 'undefined') { const evt = (window as any).requestAnimationFrame ? (window as any).requestAnimationFrame : (fn:Function)=> setTimeout(fn,0); evt(()=> { const total = currentMatches.length; if (counterEl) counterEl.textContent = total? `${cursor+1} / ${total}`:'0 / 0'; if (prevBtn) prevBtn.disabled = cursor<=0; if (nextBtn) nextBtn.disabled = cursor>=total-1; if (navEl) navEl.style.display = total? 'flex':'none'; }); }
    if (commit) {
      if (!matched.length) { infoEl.textContent = 'No matches.'; return; }
      const name = `Search: ${q} (${matched.length})`;
      createGroupForSprites(matched, name);
      hide();
    }
  }

  function show(initial = '') {
    ensure();
    if (palette) palette.style.display = 'flex';
    if (inputEl) {
      inputEl.value = initial;
      // Reset state preemptively (runSearch will also clear if empty)
      currentMatches = [];
      cursor = 0;
      if (counterEl) counterEl.textContent = '0 / 0';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (navEl) navEl.style.display = 'none';
      inputEl.focus();
      inputEl.select();
      runSearch(false);
    }
  }
  function hide() { if (palette) palette.style.display = 'none'; }

  // Public API (if needed later)
  return { show, hide };
}
