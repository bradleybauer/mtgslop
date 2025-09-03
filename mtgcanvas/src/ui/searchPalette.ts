// Lightweight search palette: Ctrl+F opens, Enter creates group with matches.
// Searches across in-memory loaded card sprites (name + oracle_text) with OR semantics between tokens.

import type { CardSprite } from "../scene/cardNode";
import type { Card } from "../types/card";
import { parseScryfallQuery } from "../search/scryfallQuery";

export interface SearchPaletteOptions {
  getSprites: () => CardSprite[];
  createGroupForSprites: (cards: CardSprite[], name: string) => void;
  focusSprite: (s: CardSprite) => void; // centers / fits viewport around a sprite
}

interface LastQueryResult {
  query: string;
  total: number;
  limited: number;
}

export function installSearchPalette(opts: SearchPaletteOptions) {
  const { getSprites, createGroupForSprites, focusSprite } = opts;
  let palette: HTMLDivElement | null = null;
  let inputEl: HTMLInputElement | null = null;
  let infoEl: HTMLDivElement | null = null;
  let filtersEl: HTMLDivElement | null = null;
  let last: LastQueryResult | null = null;
  let currentMatches: CardSprite[] = [];
  let cursor = 0; // index into currentMatches
  let navEl: HTMLDivElement | null = null;
  let counterEl: HTMLSpanElement | null = null;
  let prevBtn: HTMLButtonElement | null = null;
  let nextBtn: HTMLButtonElement | null = null;
  let groupBtn: HTMLButtonElement | null = null;
  type FilterMode = "all" | "ungrouped" | "grouped";
  let filterMode: FilterMode = "ungrouped";

  function ensure() {
    if (palette) return palette;
    const wrap = document.createElement("div");
    palette = wrap;
    wrap.id = "search-palette";
    // Widened palette to better fit enlarged font sizes (was min 320 / max 400)
    wrap.style.cssText =
      "position:fixed;top:14%;left:50%;transform:translateX(-50%);z-index:10050;display:flex;flex-direction:column;gap:calc(14px * var(--ui-scale));min-width:calc(440px * var(--ui-scale));max-width:calc(760px * var(--ui-scale));width:clamp(calc(440px * var(--ui-scale)),56vw,calc(760px * var(--ui-scale)));";
    wrap.className = "ui-panel";
    wrap.innerHTML =
      '<div style="font-size:calc(22px * var(--ui-scale));font-weight:600;letter-spacing:.6px;text-transform:uppercase;opacity:.85;">Search Cards</div>';
    inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.placeholder =
      'Search cards (Scryfall syntax). Examples: t:creature o:"draw a card" c>=ug. Enter=Group, Esc=Close';
    inputEl.className = "ui-input ui-input-lg";
    inputEl.style.width = "100%";
    // opt-out spell/grammar/autocap
    inputEl.spellcheck = false;
    inputEl.setAttribute("autocapitalize", "off");
    inputEl.setAttribute("autocorrect", "off");
    inputEl.setAttribute("data-gramm", "false");
    inputEl.setAttribute("data-gramm_editor", "false");
    wrap.appendChild(inputEl);
    // Filter pills
    filtersEl = document.createElement("div");
    filtersEl.style.cssText =
      "display:flex;gap:calc(6px * var(--ui-scale));flex-wrap:wrap;margin-top:calc(2px * var(--ui-scale));";
    function makePill(label: string, mode: FilterMode) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = "ui-pill";
      b.style.fontSize = "calc(14px * var(--ui-scale))";
      b.style.padding =
        "calc(8px * var(--ui-scale)) calc(14px * var(--ui-scale))";
      const update = () => {
        b.style.opacity = filterMode === mode ? "1" : "0.55";
        b.style.outline =
          filterMode === mode ? "1px solid var(--pill-active-outline)" : "none";
      };
      b.onclick = () => {
        filterMode = mode;
        updateAllPills();
        runSearch(false);
      };
      (b as any).__update = update;
      return b;
    }
    const pillAll = makePill("All", "all");
    const pillUng = makePill("Ungrouped", "ungrouped");
    const pillGrp = makePill("Grouped", "grouped");
    function updateAllPills() {
      [pillAll, pillUng, pillGrp].forEach((p) => (p as any).__update());
    }
    updateAllPills();
    filtersEl.append(pillAll, pillUng, pillGrp);
    wrap.appendChild(filtersEl);
    infoEl = document.createElement("div");
    infoEl.style.cssText =
      "font-size:calc(16px * var(--ui-scale));min-height:calc(24px * var(--ui-scale));opacity:0.85;white-space:pre-line;";
    wrap.appendChild(infoEl);
    // Navigation bar (Prev / counter / Next / Group All)
    navEl = document.createElement("div");
    navEl.style.cssText =
      "display:flex;align-items:center;gap:calc(12px * var(--ui-scale));font-size:calc(16px * var(--ui-scale));";
    prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.textContent = "◀";
    prevBtn.title = "Previous (Alt+Left)";
    prevBtn.className = "ui-btn";
    prevBtn.style.fontSize = "calc(16px * var(--ui-scale))";
    prevBtn.style.padding =
      "calc(6px * var(--ui-scale)) calc(12px * var(--ui-scale))";
    nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.textContent = "▶";
    nextBtn.title = "Next (Alt+Right)";
    nextBtn.className = "ui-btn";
    nextBtn.style.fontSize = "calc(16px * var(--ui-scale))";
    nextBtn.style.padding =
      "calc(6px * var(--ui-scale)) calc(12px * var(--ui-scale))";
    counterEl = document.createElement("span");
    counterEl.textContent = "0 / 0";
    counterEl.style.opacity = "0.75";
    groupBtn = document.createElement("button");
    groupBtn.type = "button";
    groupBtn.textContent = "Group All";
    groupBtn.title = "Create group from all matches (Enter)";
    groupBtn.className = "ui-btn";
    groupBtn.style.marginLeft = "auto";
    groupBtn.style.fontSize = "calc(14px * var(--ui-scale))";
    groupBtn.style.padding =
      "calc(6px * var(--ui-scale)) calc(14px * var(--ui-scale))";
    function updateNavState() {
      const total = currentMatches.length;
      const show = total > 0;
      if (navEl) navEl.style.display = show ? "flex" : "none";
      if (counterEl)
        counterEl.textContent = total
          ? `${cursor + 1} / ${total}${last && last.limited === 800 ? "*" : ""}`
          : "0 / 0";
      if (prevBtn) prevBtn.disabled = cursor <= 0;
      if (nextBtn) nextBtn.disabled = cursor >= total - 1;
    }
    function centerOnCursor() {
      const sprite = currentMatches[cursor];
      if (sprite) focusSprite(sprite);
    }
    prevBtn.onclick = () => {
      if (cursor > 0) {
        cursor--;
        updateNavState();
        centerOnCursor();
      }
    };
    nextBtn.onclick = () => {
      if (cursor < currentMatches.length - 1) {
        cursor++;
        updateNavState();
        centerOnCursor();
      }
    };
    groupBtn.onclick = () => {
      if (currentMatches.length) {
        const q = inputEl?.value.trim() || "";
        const name = q;
        createGroupForSprites(currentMatches.slice(), name);
        hide();
      }
    };
    navEl.append(prevBtn, counterEl, nextBtn, groupBtn);
    wrap.appendChild(navEl);
    const hint = document.createElement("div");
    hint.style.cssText =
      "font-size:calc(16px * var(--ui-scale));opacity:.75;white-space:normal;line-height:1.4;";
    hint.innerHTML = `
<details>
  <summary style="cursor:pointer;font-size:calc(16px * var(--ui-scale))">Search syntax cheatsheet</summary>
  <div style="margin-top:6px"></div>
  <div><b>Basics</b></div>
  <ul style="margin:6px 0 8px 18px;">
  <li>Free text matches name + type + oracle (Scryfall-like). Use quotes for phrases: <code>"draw a card"</code></li>
    <li>Negate with <code>-</code>: <code>-o:land</code>. OR with the word <code>OR</code>. Parentheses supported.</li>
    <li>Exact name: prefix token with <code>!</code> e.g. <code>!"Lightning Bolt"</code></li>
    <li>Regex: wrap in slashes (case‑insensitive): <code>o:/^\\{T\\}:/</code>. Wildcard <code>*</code> works in text fields.</li>
  </ul>
  <div><b>Fields</b></div>
  <div style="margin:6px 0 8px 0;">
    <code>name</code>, <code>o</code> (oracle), <code>t</code> (type), <code>a</code> (artist), <code>ft</code> (flavor), <code>wm</code> (watermark),
    <code>r</code> (rarity), <code>e</code>/<code>set</code>, <code>lang</code>, <code>game</code>, <code>frame</code>, <code>border</code>, <code>stamp</code>
  </div>
  <div><b>Colors</b></div>
  <ul style="margin:6px 0 8px 18px;">
    <li><code>c</code> / <code>ci</code> = color identity (Scryfall): <code>c=uw</code> (exact UW), <code>c>=ug</code> (includes U and G), <code>c<=wub</code> (subset of W/U/B), <code>c!=g</code></li>
    <li><code>color</code> = printed colors (use when you need printed, not identity): <code>color=rg</code></li>
  </ul>
  <div><b>Mana / Symbols</b></div>
  <ul style="margin:6px 0 8px 18px;">
    <li>Cost: <code>m:2WW</code>, <code>mana:{R/P}</code> (supports <code>=, !=, &gt;, &gt;=, &lt;, &lt;=</code> against symbol multisets)</li>
    <li>Devotion: <code>devotion:{G}{G}{G}</code>. Produced mana: <code>produces:ru</code></li>
    <li>Search symbols in text or cost: <code>o:{R}</code>, <code>m:{R}</code></li>
    <li>Mana value: <code>mv&gt;=3</code>, <code>manavalue:even</code></li>
  </ul>
  <div><b>Stats</b></div>
  <ul style="margin:6px 0 8px 18px;">
    <li><code>pow</code>/<code>tou</code>/<code>loy</code>: <code>pow&gt;=3</code>, <code>tou&lt;5</code></li>
    <li>Cross‑field: <code>pow&gt;tou</code>. Sum: <code>pt&gt;=10</code></li>
  </ul>
  <div><b>Sets / Rarity / Numbers</b></div>
  <ul style="margin:6px 0 8px 18px;">
    <li><code>e:khm</code>, <code>r:rare</code> (supports comparisons by rarity order), <code>cn&gt;=123</code></li>
    <li>Date/year: <code>date&gt;=2014-07-18</code>, <code>year:2015</code></li>
  </ul>
  <div><b>Formats / Prices</b></div>
  <ul style="margin:6px 0 8px 18px;">
    <li><code>f:modern</code>, <code>banned:legacy</code>, <code>restricted:vintage</code></li>
    <li><code>usd&gt;1</code>, <code>eur&lt;5</code>, <code>tix=0</code></li>
  </ul>
  <div><b>Flags</b></div>
  <ul style="margin:6px 0 8px 18px;">
    <li><code>is:</code> <em>spell</em>, <em>permanent</em>, <em>dfc</em>, <em>modal</em>, <em>vanilla</em>, <em>frenchvanilla</em>, <em>bear</em>, <em>hybrid</em>, <em>phyrexian</em>, <em>foil</em>, <em>etched</em>, <em>hires</em>, <em>promo</em>, <em>spotlight</em>, <em>digital</em>, <em>reserved</em>, <em>commander</em>…</li>
    <li><code>has:</code> <em>indicator</em>, <em>watermark</em>, <em>flavor</em>, <em>security_stamp</em></li>
  </ul>
  <div style="opacity:.8">Tip: plain text without fields matches names and oracle. Use <code>n:</code> to target name only, or <code>o:</code> for oracle‑only text.</div>
</details>`;
    wrap.appendChild(hint);
    document.body.appendChild(wrap);
    // Global escape handler so palette closes even if focus moved to buttons
    const escListener = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && palette && palette.style.display !== "none") {
        ev.stopPropagation();
        hide();
      }
    };
    // Attach once
    window.addEventListener("keydown", escListener, { capture: true });

    inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        hide();
      }
      if (ev.key === "Enter") {
        runSearch(true);
      }
      if (ev.altKey) {
        if (ev.key === "ArrowLeft") {
          if (cursor > 0) {
            cursor--;
            updateNavState();
            centerOnCursor();
            ev.preventDefault();
          }
        }
        if (ev.key === "ArrowRight") {
          if (cursor < currentMatches.length - 1) {
            cursor++;
            updateNavState();
            centerOnCursor();
            ev.preventDefault();
          }
        }
      }
      if (ev.altKey) {
        if (ev.key === "u" || ev.key === "U") {
          filterMode = "ungrouped";
          updateAllPills();
          runSearch(false);
          ev.preventDefault();
        }
        if (ev.key === "g" || ev.key === "G") {
          filterMode = "grouped";
          updateAllPills();
          runSearch(false);
          ev.preventDefault();
        }
        if (ev.key === "a" || ev.key === "A") {
          filterMode = "all";
          updateAllPills();
          runSearch(false);
          ev.preventDefault();
        }
      }
    });
    inputEl.addEventListener("input", () => runSearch(false));
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
    const any: string[] = [];
    const must: string[] = [];
    const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|\S+/g; // quoted block or bare token
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let token = m[0];
      let isMust = false;
      if (
        token.startsWith("+") &&
        token.length > 1 &&
        /[A-Za-z"]/.test(token[1])
      ) {
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

  function match(card: Card, tk: { any: string[]; must: string[] }) {
    const hay = (
      (card.name || "") +
      "\n" +
      (card.oracle_text || "")
    ).toLowerCase();
    // MUST tokens: all must appear
    for (const m of tk.must) if (!hay.includes(m)) return false;
    if (!tk.any.length) return true; // only + tokens
    // ANY tokens: OR semantics; also allow explicit a|b syntax inside token
    for (const a of tk.any) {
      if (a.includes("|")) {
        const alts = a.split("|");
        if (alts.some((alt) => alt && hay.includes(alt))) return true;
      } else if (hay.includes(a)) return true;
    }
    return false;
  }

  function runSearch(commit: boolean) {
    if (!inputEl || !infoEl) return;
    const q = inputEl.value.trim();
    if (!q) {
      // Clear prior state so reopening palette starts fresh (no stale nav / matches)
      infoEl.textContent = "";
      last = null;
      currentMatches = [];
      cursor = 0;
      if (counterEl) counterEl.textContent = "0 / 0";
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (navEl) navEl.style.display = "none";
      if (commit) hide();
      return;
    }
    // Try advanced Scryfall-like parse first
    const adv = parseScryfallQuery(q);
    const tk = adv ? null : tokenize(q);
    const sprites = getSprites();
    // const MAX = 800; // safety cap
    const matched: CardSprite[] = [];
    for (const s of sprites) {
      const c = s.__card;
      if (!c) continue;
      if (filterMode === "ungrouped" && s.__groupId) continue;
      if (filterMode === "grouped" && !s.__groupId) continue;
      let ok = false;
      if (adv) ok = adv(c);
      else if (tk) ok = match(c, tk);
      if (ok) matched.push(s);
    }
    currentMatches = matched;
    cursor = 0;
    last = { query: q, total: matched.length, limited: matched.length };
    infoEl.textContent = `Matches: ${matched.length}  |  Filter: ${filterMode}`;
    if (navEl) {
      (navEl as any).style ||= {};
    }
    // Update nav and center on first match when not committing (preview mode)
    if (!commit && matched.length) {
      focusSprite(matched[0]);
    }
    if (navEl && (navEl as any).firstChild) {
      /* noop placeholder */
    }
    // Refresh nav controls
    if (typeof window !== "undefined") {
      const evt: (cb: () => void) => any = (window as any).requestAnimationFrame
        ? (window as any).requestAnimationFrame.bind(window)
        : (cb: () => void) => setTimeout(cb, 0);
      evt(() => {
        const total = currentMatches.length;
        if (counterEl)
          counterEl.textContent = total ? `${cursor + 1} / ${total}` : "0 / 0";
        if (prevBtn) prevBtn.disabled = cursor <= 0;
        if (nextBtn) nextBtn.disabled = cursor >= total - 1;
        if (navEl) navEl.style.display = total ? "flex" : "none";
      });
    }
    if (typeof window !== "undefined") {
      const evt2: (cb: () => void) => any = (window as any)
        .requestAnimationFrame
        ? (window as any).requestAnimationFrame.bind(window)
        : (cb: () => void) => setTimeout(cb, 0);
      evt2(() => {
        const total = currentMatches.length;
        if (counterEl)
          counterEl.textContent = total ? `${cursor + 1} / ${total}` : "0 / 0";
        if (prevBtn) prevBtn.disabled = cursor <= 0;
        if (nextBtn) nextBtn.disabled = cursor >= total - 1;
        if (navEl) navEl.style.display = total ? "flex" : "none";
      });
    }
    if (commit) {
      if (!matched.length) {
        infoEl.textContent = "No matches.";
        return;
      }
      const name = q;
      createGroupForSprites(matched, name);
      hide();
    }
  }

  function show(initial = "") {
    ensure();
    if (palette) palette.style.display = "flex";
    if (inputEl) {
      inputEl.value = initial;
      // Reset state preemptively (runSearch will also clear if empty)
      currentMatches = [];
      cursor = 0;
      if (counterEl) counterEl.textContent = "0 / 0";
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (navEl) navEl.style.display = "none";
      inputEl.focus();
      inputEl.select();
      runSearch(false);
    }
  }
  function hide() {
    if (palette) palette.style.display = "none";
  }

  // Public API (if needed later)
  return { show, hide };
}
