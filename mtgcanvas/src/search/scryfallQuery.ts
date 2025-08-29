// Detailed current search syntax (based on scryfallQuery.ts implementation)

// Overall model

// Input is tokenized into space‑separated tokens (respecting quoted phrases).
// Top‑level is OR groups: the literal token OR (case‑insensitive, unquoted) splits groups. Everything between ORs is ANDed.
// Inside a group every token must match (logical AND). Negation (-prefix) flips that single token’s result after it is evaluated.
// No parentheses; precedence is: evaluate each group (AND), then OR the groups.
// If parsing throws, the system falls back to the legacy simple token matcher (not described here).
// Token forms

// Field filters (colon form): fieldAlias:value Supported aliases: name / n o / oracle (oracle_text) t / type (type_line) layout cmc / mv (numerical) c / ci (color_identity) Examples: o:infect name:"glistener elf" cmc:3 (equals 3) cmc:>=5 c:uw (contains U and W, maybe more) c:=uw (exactly UW) c:<=wub (subset of WUB; i.e. mono-W, mono-U, mono-B, UW, WB, UB, or WUB) c:!=g (color identity not exactly G)

// Bare numeric comparison (no colon): cmc>=3, mv=2, cmc!=5, mv<4 (Operator required in bare form; otherwise use cmc:3.)

// Bare color identity form (no colon): c=uw, c>=uw, c<=wub, c!=g, cwu

// If only letters (e.g. cwu) it means “contains at least these letters” (>= semantics).
// Letters are deduplicated; case-insensitive.
// Valid letters: w u b r g (colorless is just absence; no special symbol).
// Free text token (no recognized field pattern):

// Matches (case-insensitive) against (name + newline + oracle_text).
// Wildcard * allowed inside token (draw* => draw, drawing, draws).
// Quoted phrase "draw a card" keeps spaces (exact substring match unless you add * inside).
// Example: poison infect (both must appear somewhere in name or oracle_text unless OR used).
// Field text with wildcards: o:draw* t:beast name:"blade of*" (the * inside the quotes still works)

// Negation:

// Prefix a token with - (outside quotes) to invert it.
// Examples: -o:land (oracle_text does NOT contain “land”) -t:creature (type_line does NOT contain “creature”) -c:<=w (NOT (subset of W)) ⇒ any card whose color identity includes a non‑W color. Caution: Double negation via operator + prefix can flip logic unexpectedly: -c:!=g means exactly mono‑green (because inner !=g then outer negation).
// OR:

// Literal token OR splits groups.
// Example: o:poison OR o:infect (Two groups: [o:poison] OR [o:infect])
// Within a single group you currently cannot change precedence; to emulate (A OR B) AND C you must duplicate: (A C) OR (B C).
// Phrases / quoting:

// "..." wraps a phrase; spaces preserved.
// Escaped quote inside phrase: ".
// For field values: o:"+1/+1 counter"
// In field tokens where only the value is quoted (o:"+1/+1"), the code strips the surrounding quotes.
// Wildcards:

// expands to .* (greedy) in a case-insensitive regex; no ? or other regex metacharacters are honored.
// All other regex special characters are escaped literally (no native regex mode).
// Case handling:

// All text comparisons are case-insensitive.
// Color identity semantics recap

// Internal color identity extracted as uppercase concatenation (order doesn’t matter).
// Operators: = exact same set (order irrelevant) != not exactly that set
// = card’s identity is a superset (contains all letters you listed, may have more) <= card’s identity is a subset (contains only letters from the listed set, may have fewer)

// No operator (just letters) ⇒ >=
// Negation (-prefix) wraps the result.
// Numeric comparisons

// Only cmc / mv supported.
// Allowed operators: = != > >= < <=
// Colon form: cmc:>=5, cmc:3
// Bare form: cmc>=5 (operator required)
// Values parsed as float.
// Free text AND behavior

// poison infect => card must contain poison AND infect somewhere (unless separated by OR)
// -infect poison => contains poison but not infect.
// Examples

// o:infect t:creature cmc<=3 Infect creatures with CMC ≤ 3.
// c=uw t:instant o:counter Exactly Azorius instant with “counter” in oracle text.
// c>=ug -t:creature o:draw* Non-creature spells in UG (at least U and G) with oracle text starting with “draw”.
// o:"+1/+1 counter" -o:"at the beginning" Contains “+1/+1 counter” but not “at the beginning”.
// (Emulated (A OR B) AND C) o:poison CMC<=4 OR o:infect CMC<=4
// Unsupported (yet)

// Parentheses for grouping / precedence.
// Advanced Scryfall fields: set:, rarity:, legal:, is:, game:, produced:, id:, mana cost symbol filters, power/toughness (pow:/tou:), loyalty, keywords (k:), flavor text (ft:), artist, tag/meta filters.
// Complex color ops like is:monocolor, identity comparisons beyond current simple operators.
// Comparison on power/toughness/loyalty.
// Mana cost pattern searching.
// Regex mode, fuzzy (~) searching, distance/word boundary logic.
// Implicit phrase semantics (currently all substring).
// Edge/caveats

// Token OR inside quotes is treated as literal text, not a logical OR separator.
// A token consisting only of - (rare) is ignored (empty after stripping).
// Double negative patterns (-c:!=g) invert expected meaning.
// Large OR chains evaluated linearly (fine for current scale).
// No whitespace trimming inside quoted phrases beyond removing outer quotes.
// Performance notes

// All predicates are executed in memory against currently loaded card objects.
// Color identity letters deduplicated before comparisons.
// Wildcards create simple regexes; excessive leading * may slow matches in huge sets (acceptable for current dataset sizes).
// Potential enhancements (if wanted)

// Parentheses & full precedence tree.
// Additional Scryfall fields (set:, rarity:, is:, pow:, tou:, mana:, produced:, etc.).
// Phrase boundary or whole word operator.
// Exact/regex mode flag.
// Highlight of matched substrings in UI.
// Precompiled per-field indexes for faster large-scale filtering.
// De-morgan simplification to warn on double-negatives.
// Ask for any of these and they can be added incrementally. Let me know if you want a concise cheat sheet rendered in the UI.

export interface CardLike {
  // Core
  name?: string;
  oracle_text?: string;
  type_line?: string;
  cmc?: number; // aka manavalue
  layout?: string;
  color_identity?: string[] | string | null;
  colors?: string[] | null;
  mana_cost?: string | null;
  power?: string | number | null;
  toughness?: string | number | null;
  loyalty?: string | number | null;
  produced_mana?: string[] | null;
  keywords?: string[] | null;
  // Printing / set
  set?: string | null; // set code
  set_type?: string | null;
  collector_number?: string | null;
  released_at?: string | null; // yyyy-mm-dd
  lang?: string | null;
  rarity?: string | null; // common, uncommon, rare, mythic, special, bonus
  prices?: {
    usd?: string | null;
    eur?: string | null;
    tix?: string | null;
  } | null;
  games?: string[] | null; // ['paper','mtgo','arena']
  digital?: boolean | null;
  promo?: boolean | null;
  story_spotlight?: boolean | null;
  reserved?: boolean | null;
  highres_image?: boolean | null;
  foil?: boolean | null; // legacy
  nonfoil?: boolean | null; // legacy
  finishes?: string[] | null; // ['nonfoil','foil','etched','glossy']
  border_color?: string | null; // black, white, borderless, silver
  frame?: string | null; // 1993, 1997, 2003, 2015, future
  frame_effects?: string[] | null; // ['legendary','colorshifted', ...]
  security_stamp?: string | null; // oval, triangle, arena, acorn
  // Faces
  card_faces?: Array<{
    name?: string;
    oracle_text?: string;
    type_line?: string;
    mana_cost?: string | null;
    watermark?: string | null;
    color_indicator?: string[] | null;
    artist?: string | null;
  }> | null;
  // Misc
  artist?: string | null;
  flavor_text?: string | null;
  watermark?: string | null;
  color_indicator?: string[] | null;
  legalities?: Record<
    string,
    "legal" | "not_legal" | "banned" | "restricted" | "suspended" | string
  > | null;
}

type Predicate = (card: CardLike) => boolean;

interface TokenNode {
  type: "pred";
  fn: Predicate;
}
interface OrNode {
  type: "or";
  parts: Node[];
}
type Node = TokenNode | OrNode;

function ciString(ci: CardLike["color_identity"]): string {
  if (!ci) return "";
  if (Array.isArray(ci)) return ci.join("").toUpperCase();
  return String(ci).toUpperCase();
}

const FIELD_ALIASES: Record<string, string> = {
  // Text
  name: "name",
  n: "name",
  o: "oracle_text",
  oracle: "oracle_text",
  fo: "oracle_text",
  fulloracle: "oracle_text",
  kw: "keywords",
  keyword: "keywords",
  t: "type_line",
  type: "type_line",
  layout: "layout",
  // Colors / identity (Scryfall semantics: c -> color identity; printed colors via 'color')
  c: "color_identity",
  ci: "color_identity",
  id: "color_identity",
  identity: "color_identity",
  color: "colors",
  // Mana & values
  mana: "mana_cost",
  m: "mana_cost",
  cmc: "cmc",
  mv: "cmc",
  manavalue: "cmc",
  // Power/toughness/loyalty
  pow: "power",
  power: "power",
  tou: "toughness",
  toughness: "toughness",
  loy: "loyalty",
  loyalty: "loyalty",
  pt: "pt",
  powtou: "pt",
  // Sets / rarity / numbers
  r: "rarity",
  rarity: "rarity",
  e: "set",
  s: "set",
  set: "set",
  edition: "set",
  st: "set_type",
  cn: "collector_number",
  number: "collector_number",
  // Prices
  usd: "usd",
  eur: "eur",
  tix: "tix",
  // Dates / language
  year: "year",
  date: "released_at",
  lang: "lang",
  language: "lang",
  // Artist / flavor / watermark
  a: "artist",
  artist: "artist",
  ft: "flavor_text",
  flavor: "flavor_text",
  wm: "watermark",
  watermark: "watermark",
  // Games / border / frame / stamp
  game: "games",
  border: "border_color",
  frame: "frame",
  stamp: "security_stamp",
};

const TEXT_FIELDS = new Set([
  "name",
  "oracle_text",
  "type_line",
  "layout",
  "artist",
  "flavor_text",
  "watermark",
  "set",
  "set_type",
  "collector_number",
  "border_color",
  "frame",
  "security_stamp",
  "lang",
]);

// Rarity order for comparisons
const RARITY_ORDER: Record<string, number> = {
  common: 1,
  uncommon: 2,
  rare: 3,
  special: 4,
  mythic: 5,
  bonus: 6,
};

// Display/control keywords we accept and ignore (no-op) to be syntax-compatible
const NOOP_FIELDS = new Set([
  "display",
  "order",
  "direction",
  "prefer",
  "unique",
  "include",
  "sort",
  "new",
]);

export function parseScryfallQuery(input: string): Predicate | null {
  const src = (input || "").trim();
  if (!src) return null;
  try {
    const tokens = lexical(src);
    // No special-casing of plain queries: default free text will search name + type + oracle (Scryfall-like)
    const node = parse(tokens);
    return (card) => evalNode(node, card);
  } catch (e) {
    console.warn(
      "[scryfallQuery] parse failed – fallback to simple contains",
      e,
    );
    return null;
  }
}

interface LexToken {
  v: string;
  neg?: boolean;
  exact?: boolean;
}

function lexical(src: string): LexToken[] {
  const out: LexToken[] = [];
  let buf = "";
  let inQ = false;
  let escaped = false;
  function pushBuf() {
    if (!buf) return;
    let raw = buf;
    let neg = false;
    let exact = false;
    if (raw.startsWith("-")) {
      neg = true;
      raw = raw.slice(1);
    }
    if (raw.startsWith("!")) {
      exact = true;
      raw = raw.slice(1);
    }
    // Note: do not strip inner quotes here; buildTokenPredicate handles field-value quotes
    out.push({ v: raw, neg, exact });
    buf = "";
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQ = !inQ;
      buf += ch;
      continue;
    }
    if (!inQ && (ch === "(" || ch === ")")) {
      pushBuf();
      out.push({ v: ch });
      continue;
    }
    if (!inQ && /\s/.test(ch)) {
      pushBuf();
      continue;
    }
    buf += ch;
  }
  pushBuf();
  return out;
}

function parse(tokens: LexToken[]): Node {
  // Recursive descent with precedence: OR between terms, AND within terms, parentheses supported
  let i = 0;
  function parseExpression(): Node {
    let node = parseTerm();
    while (i < tokens.length && tokens[i].v.toLowerCase() === "or") {
      i++;
      const rhs = parseTerm();
      node = { type: "or", parts: [node, rhs] } as OrNode;
    }
    return node;
  }
  function parseTerm(): Node {
    const preds: Predicate[] = [];
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.v === ")" || tok.v.toLowerCase() === "or") break;
      if (tok.v === "(") {
        i++;
        const inner = parseExpression();
        if (tokens[i]?.v === ")") i++;
        const fn: Predicate = (card) => evalNode(inner, card);
        preds.push(fn);
        continue;
      }
      i++;
      const p = buildTokenPredicate(tok.v, !!tok.neg, !!tok.exact);
      if (p) preds.push(p);
    }
    if (!preds.length) return { type: "pred", fn: () => true } as TokenNode;
    return {
      type: "pred",
      fn: (card) => preds.every((fn) => fn(card)),
    } as TokenNode;
  }
  const ast = parseExpression();
  return ast;
}

function buildTokenPredicate(
  raw: string,
  neg: boolean,
  exact: boolean,
): Predicate | null {
  // field? token
  const m = raw.match(/^([a-zA-Z_][a-zA-Z0-9_]*):(.+)$/);
  if (m) {
    const fieldAlias = m[1].toLowerCase();
    // Allow quoting of field value even when only the value portion is quoted (e.g. -o:"+1/+1").
    // Our lexer only strips quotes when the ENTIRE token is quoted; for field prefixes the quotes
    // remain embedded, so strip them here if present so negations like -o:"+1/+1" work.
    let value = m[2];
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    if (NOOP_FIELDS.has(fieldAlias)) return () => true;
    // not:foo -> is:foo with negation
    if (fieldAlias === "not") {
      return buildTokenPredicate("is:" + value, !neg, exact);
    }
    const field = FIELD_ALIASES[fieldAlias];
    if (!field) {
      if (fieldAlias === "is") return isPredicate(value, neg);
      if (fieldAlias === "has") return hasPredicate(value, neg);
      if (fieldAlias === "f" || fieldAlias === "format")
        return formatPredicate(value, "legal", neg);
      if (fieldAlias === "banned") return formatPredicate(value, "banned", neg);
      if (fieldAlias === "restricted")
        return formatPredicate(value, "restricted", neg);
      if (fieldAlias === "in") return gamesPredicate(value, neg);
      if (fieldAlias === "devotion") return devotionPredicate(value, neg);
      if (fieldAlias === "produces") return producesPredicate(value, neg);
      return null;
    }
    if (field === "color_identity") return colorIdentityPredicate(value, neg);
    if (field === "colors") return colorsPredicate(value, neg);
    if (field === "mana_cost") return manaCostPredicate(value, neg);
    if (field === "pt") return ptTotalPredicate(value, neg);
    if (field === "rarity") return rarityPredicate(value, neg);
    if (field === "usd" || field === "eur" || field === "tix")
      return pricePredicate(field, value, neg);
    if (field === "games") return gamesPredicate(value, neg);
    if (field === "released_at") return datePredicate(value, neg);
    if (field === "year") return yearPredicate(value, neg);
    if (field === "collector_number")
      return collectorNumberPredicate(value, neg);
    if (field === "keywords") return keywordPredicate(value, neg);
    if (field === "set") return setPredicate(value, neg);
    if (field === "lang") {
      if (value.trim().toLowerCase() === "any") return () => true;
      return textFieldPredicate("lang", value, neg);
    }
    if (field === "set_type") return textFieldPredicate("set_type", value, neg);
    if (
      field === "power" ||
      field === "toughness" ||
      field === "loyalty" ||
      field === "cmc"
    ) {
      // manavalue even/odd shorthand (mv:even / manavalue:odd via alias earlier)
      const v = value.trim().toLowerCase();
      if (field === "cmc" && (v === "even" || v === "odd"))
        return mvParityPredicate(v === "even", neg);
      return numericFieldPredicate(field, value, neg);
    }
    if (TEXT_FIELDS.has(field)) return textFieldPredicate(field, value, neg);
    return null;
  }
  // Bare numeric forms: cmc>=3, mv=2, pow>=3, tou<5, loy=3, pt>=10 etc.
  const numBare = raw.match(
    /^(cmc|mv|pow|power|tou|toughness|loy|loyalty|pt|powtou)(<=|>=|!=|=|<|>)(\d+(?:\.\d+)*)$/i,
  );
  if (numBare) {
    const lhs = numBare[1].toLowerCase();
    if (lhs === "pt" || lhs === "powtou")
      return ptTotalPredicate(numBare[2] + numBare[3], neg);
    const alias = lhs === "mv" ? "cmc" : FIELD_ALIASES[lhs] || lhs;
    return numericFieldPredicate(alias, numBare[2] + numBare[3], neg);
  }
  // Bare color identity forms: c=uw, c>=uw, c<=wub, c!=g, cwu (contains at least w,u)
  const ciBare = raw.match(/^(c|ci)(<=|>=|=|!=)?([wubrg]+)$/i);
  if (ciBare) {
    const spec = (ciBare[2] || "") + ciBare[3];
    // Scryfall semantics: 'c' refers to color identity, not printed colors
    return colorIdentityPredicate(spec, neg);
  }
  // Cross-field numeric comparisons: pow>tou, power<=toughness, etc.
  const cross = raw.match(
    /^(pow|power|tou|toughness|loy|loyalty)\s*(<=|>=|!=|=|<|>)\s*(pow|power|tou|toughness|loy|loyalty)$/i,
  );
  if (cross) {
    const l = normalizeStatField(cross[1]);
    const op = cross[2];
    const r = normalizeStatField(cross[3]);
    return crossFieldPredicate(l, op, r, neg);
  }
  // Exact name (bare token with ! already stripped in lexer)
  if (exact) return exactNamePredicate(raw, neg);
  // Free text token -> search name OR oracle
  return freeTextPredicate(raw, neg);
}

function freeTextPredicate(txt: string, neg: boolean): Predicate {
  // If simple alphanumeric (no wildcard/regex), prefer word-boundary match to emulate Scryfall token behavior
  let needle = txt.toLowerCase();
  if (
    !needle.includes("*") &&
    !(needle.startsWith("/") && needle.endsWith("/")) &&
    /^[a-z0-9]+$/i.test(needle)
  ) {
    needle = `/${"\\b" + needle.replace(/\//g, "\\/") + "\\b"}/`;
  }
  const pattern = textToRegex(needle);
  return (card) => {
    // Scryfall free-text searches name + type_line + oracle
    const hay = (
      (card.name || "") +
      "\n" +
      (card.type_line || "") +
      "\n" +
      (oracleAggregate(card) || "")
    ).toLowerCase();
    const hit = pattern.test(hay);
    return neg ? !hit : hit;
  };
}

function textFieldPredicate(
  field: string,
  raw: string,
  neg: boolean,
): Predicate {
  const tmpl = raw.toLowerCase();
  return (card) => {
    const needle = tmpl.includes("~")
      ? tmpl.replace(/~/g, String(card.name || "").toLowerCase())
      : tmpl;
    const rx = textToRegex(needle);
    const val = (card as any)[field];
    let got: string | null = null;
    if (typeof val === "string") got = val;
    else if (
      val == null &&
      (field === "oracle_text" || field === "watermark")
    ) {
      // search faces if card-level missing
      const txt = facesConcat(card, field);
      got = txt || null;
    }
    const hit = !!(got && rx.test(got.toLowerCase()));
    return neg ? !hit : hit;
  };
}

function numericFieldPredicate(
  field: string,
  raw: string,
  neg: boolean,
): Predicate {
  // Accept forms: >=3, <=2, >4, <5, =3, 3, !=4
  const m = raw.match(/^(<=|>=|!=|=|<|>)?\s*(\d+(?:\.\d+)?)$/);
  if (!m) return () => true; // malformed -> no-op
  const op = m[1] || "=";
  const rhs = parseFloat(m[2]);
  return (card) => {
    const vRaw = (card as any)[field];
    const v = num(vRaw); // parse numbers stored as strings (e.g., power="2"); NaN for "*" etc.
    if (!isFinite(v)) return false;
    let pass = false;
    switch (op) {
      case "=":
        pass = v === rhs;
        break;
      case "!=":
        pass = v !== rhs;
        break;
      case ">":
        pass = v > rhs;
        break;
      case ">=":
        pass = v >= rhs;
        break;
      case "<":
        pass = v < rhs;
        break;
      case "<=":
        pass = v <= rhs;
        break;
    }
    return neg ? !pass : pass;
  };
}

function colorIdentityPredicate(specRaw: string, neg: boolean): Predicate {
  // Supported: =wubrg exact, >=uw (at least), <=gw (subset), !=w (not exact), plain letters -> contains ALL letters (>= semantics).
  const m = specRaw.match(/^(<=|>=|=|!=)?([wubrg]+)/i);
  if (!m) return () => true;
  const op = m[1] || ">="; // default implicit -> contains all
  const letters = [...new Set(m[2].toUpperCase().split(""))];
  return (card) => {
    const id = ciString(card.color_identity);
    const set = new Set(id.split("").filter((x) => x));
    const target = new Set(letters);
    let pass = false;
    if (op === "=") pass = eqSet(set, target);
    else if (op === "!=") pass = !eqSet(set, target);
    else if (op === ">=")
      pass = subset(target, set); // set has all target
    else if (op === "<=") pass = subset(set, target); // set is subset
    return neg ? !pass : pass;
  };
}

function colorsPredicate(specRaw: string, neg: boolean): Predicate {
  // Same operators as color identity but using printed colors set
  const m = specRaw.match(/^(<=|>=|=|!=)?([wubrg]+)/i);
  if (!m) return () => true;
  const op = m[1] || ">=";
  const letters = [...new Set(m[2].toUpperCase().split(""))];
  return (card) => {
    const arr = (card.colors || []) as string[];
    const set = new Set(arr.map((x) => x.toUpperCase()));
    const target = new Set(letters);
    let pass = false;
    if (op === "=") pass = eqSet(set, target);
    else if (op === "!=") pass = !eqSet(set, target);
    else if (op === ">=") pass = subset(target, set);
    else if (op === "<=") pass = subset(set, target);
    return neg ? !pass : pass;
  };
}

function textToRegex(pat: string): RegExp {
  // If /.../ regex form, honor it; else wildcard * -> .*
  if (pat.length >= 2 && pat.startsWith("/") && pat.endsWith("/")) {
    const body = pat.slice(1, -1);
    try {
      return new RegExp(body, "i");
    } catch {
      /* fallthrough */
    }
  }
  const esc = pat
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, "__AST__");
  const re = esc.replace(/__AST__/g, ".*");
  return new RegExp(re, "i");
}

function subset(a: Set<string>, b: Set<string>): boolean {
  // a subset of b
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
function eqSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && subset(a, b);
}

function evalNode(node: Node, card: CardLike): boolean {
  if (node.type === "pred") return node.fn(card);
  if (node.type === "or") return node.parts.some((p) => evalNode(p, card));
  return true;
}

// -------------------- Helpers & extended predicates --------------------

function facesConcat(
  card: CardLike,
  field: "oracle_text" | "watermark",
): string | undefined {
  if (!card.card_faces || !Array.isArray(card.card_faces)) return undefined;
  const parts: string[] = [];
  for (const f of card.card_faces) {
    const v = (f as any)[field];
    if (v) parts.push(String(v));
  }
  return parts.length ? parts.join("\n") : undefined;
}

function oracleAggregate(card: CardLike): string {
  return (card.oracle_text || facesConcat(card, "oracle_text") || "").trim();
}

function exactNamePredicate(value: string, neg: boolean): Predicate {
  let v = value;
  if (
    v.length > 1 &&
    ((v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'")))
  ) {
    v = v.slice(1, -1).replace(/\\"/g, '"');
  }
  const name = v.toLowerCase();
  return (card) => {
    const hit = (card.name || "").toLowerCase() === name;
    return neg ? !hit : hit;
  };
}

function isPredicate(valueRaw: string, neg: boolean): Predicate {
  const v = valueRaw.toLowerCase();
  const fn: Predicate = (card: CardLike) => {
    const type = (card.type_line || "").toLowerCase();
    const layout = (card.layout || "").toLowerCase();
    const oracle = oracleAggregate(card).toLowerCase();
    const keywords = (card.keywords || []).map((k) => k.toLowerCase());
    switch (v) {
      case "split":
        return layout.includes("split");
      case "flip":
        return layout.includes("flip");
      case "transform":
        return layout.includes("transform");
      case "meld":
        return layout.includes("meld");
      case "leveler":
        return layout.includes("leveler");
      case "dfc":
        return !!(card.card_faces && card.card_faces.length >= 2);
      case "mdfc":
        return layout.includes("modal");
      case "spell":
        return !/\bland\b/.test(type);
      case "permanent":
        return /(artifact|creature|enchantment|land|planeswalker|battle)\b/.test(
          type,
        );
      case "historic":
        return (
          /legendary\b/.test(type) ||
          /artifact\b/.test(type) ||
          /saga\b/.test(type)
        );
      case "party":
        return (
          /creature\b/.test(type) &&
          /(cleric|rogue|warrior|wizard)\b/.test(type)
        );
      case "modal":
        return /choose (one|two)/.test(oracle);
      case "vanilla":
        return /creature\b/.test(type) && oracle.length === 0;
      case "frenchvanilla": {
        if (!/creature\b/.test(type)) return false;
        const allowed = [
          "flying",
          "vigilance",
          "lifelink",
          "trample",
          "haste",
          "first strike",
          "double strike",
          "menace",
          "deathtouch",
          "reach",
          "indestructible",
          "hexproof",
          "prowess",
          "ward",
          "flash",
        ];
        const text = oracle; // already aggregated and lowercased
        // Heuristic: only contains allowed keywords and punctuation
        const stripped = text
          .replace(/[,:.;()\-—\u2014\u2212\s]+/g, " ")
          .trim();
        return (
          stripped.length > 0 &&
          stripped
            .split(" ")
            .every(
              (tok) =>
                allowed.includes(tok) || tok === "+1/+1" || tok === "flying,",
            )
        );
      }
      case "bear":
        return (
          /creature\b/.test(type) &&
          num(card.power) === 2 &&
          num(card.toughness) === 2 &&
          (card.cmc || 0) === 2
        );
      case "hybrid":
        return hasManaSymbol(card.mana_cost, /\{[^}]*\/[WUBRGCX][^}]*\}/i);
      case "phyrexian":
        return hasManaSymbol(card.mana_cost, /\{[WUBRGC]\/[pP]\}/);
      case "funny":
        return (
          (card.set_type || "").toLowerCase() === "funny" ||
          (card.security_stamp || "") === "acorn"
        );
      case "foil":
        return hasFinish(card, "foil");
      case "nonfoil":
        return hasFinish(card, "nonfoil");
      case "etched":
        return hasFinish(card, "etched");
      case "glossy":
        return hasFinish(card, "glossy");
      case "hires":
        return !!card.highres_image;
      case "promo":
        return !!card.promo;
      case "spotlight":
        return !!card.story_spotlight;
      case "reprint":
        return (card as any).reprint === true;
      case "unique":
        return (
          ((card as any).prints_count || (card as any).set_count || 0) <= 1
        );
      case "full":
        return (card as any).full_art === true;
      case "old":
        return (card.frame || "") === "1993" || (card.frame || "") === "1997";
      case "new":
        return (card.frame || "") === "2015";
      case "scryfallpreview":
        return (
          Array.isArray((card as any).promo_types) &&
          ((card as any).promo_types as string[]).some((x) =>
            String(x).toLowerCase().includes("scryfall"),
          )
        );
      case "digital":
        return !!card.digital;
      case "reserved":
        return !!card.reserved;
      case "commander":
        return (
          /legendary\s+creature\b/.test(type) ||
          /can be your commander/.test(oracle)
        );
      case "brawler":
        return (
          /legendary\s+creature\b/.test(type) ||
          /can be your commander/.test(oracle)
        );
      case "companion":
        return keywords.includes("companion");
      case "duelcommander":
        return (
          /legendary\s+creature\b/.test(type) ||
          /can be your commander/.test(oracle)
        );
      case "universesbeyond":
        return (card.set_type || "").toLowerCase().includes("universes");
      default:
        return false;
    }
  };
  return neg ? (c) => !fn(c) : fn;
}

function hasFinish(
  card: CardLike,
  kind: "foil" | "nonfoil" | "etched" | "glossy",
): boolean {
  if (Array.isArray(card.finishes))
    return card.finishes.map((s) => s.toLowerCase()).includes(kind);
  if (kind === "foil") return !!card.foil;
  if (kind === "nonfoil") return !!card.nonfoil;
  return false;
}

function hasPredicate(valueRaw: string, neg: boolean): Predicate {
  const v = valueRaw.toLowerCase();
  const fn: Predicate = (card: CardLike) => {
    switch (v) {
      case "indicator":
        return !!(
          card.color_indicator ||
          (card.card_faces || []).some(
            (f) =>
              f &&
              (f as any).color_indicator &&
              (f as any).color_indicator!.length,
          )
        );
      case "watermark":
        return !!(card.watermark || facesConcat(card, "watermark"));
      case "flavor":
        return !!card.flavor_text;
      case "security_stamp":
        return !!card.security_stamp;
      default:
        return false;
    }
  };
  return neg ? (c) => !fn(c) : fn;
}

function rarityPredicate(raw: string, neg: boolean): Predicate {
  const m = raw.match(/^(<=|>=|!=|=|<|>)?\s*([a-zA-Z]+)$/);
  if (!m) return () => true;
  const op = m[1] || "=";
  const rhs = (m[2] || "").toLowerCase();
  const rhsV = RARITY_ORDER[rhs] ?? -1;
  return (card) => {
    const lv = RARITY_ORDER[(card.rarity || "").toLowerCase()] ?? -1;
    let pass = false;
    switch (op) {
      case "=":
        pass = lv === rhsV;
        break;
      case "!=":
        pass = lv !== rhsV;
        break;
      case ">":
        pass = lv > rhsV;
        break;
      case ">=":
        pass = lv >= rhsV;
        break;
      case "<":
        pass = lv < rhsV;
        break;
      case "<=":
        pass = lv <= rhsV;
        break;
    }
    return neg ? !pass : pass;
  };
}

function keywordPredicate(raw: string, neg: boolean): Predicate {
  const rx = textToRegex(raw.toLowerCase());
  return (card) => {
    const ks = (card.keywords || []).map((k) => String(k).toLowerCase());
    const hit = ks.some((k) => rx.test(k));
    return neg ? !hit : hit;
  };
}

function setPredicate(raw: string, neg: boolean): Predicate {
  // Accept exact set code or regex/wildcards
  const rx = textToRegex(raw.toLowerCase());
  return (card) => {
    const v = (card.set || "").toLowerCase();
    const hit = !!v && rx.test(v);
    return neg ? !hit : hit;
  };
}

function collectorNumberPredicate(raw: string, neg: boolean): Predicate {
  // Allow numeric and lexicographic comparisons, or wildcard match
  const m = raw.match(/^(<=|>=|!=|=|<|>)?\s*([0-9A-Za-z]+)$/);
  if (!m) return textFieldPredicate("collector_number", raw, neg);
  const op = m[1] || "=";
  const rhs = m[2];
  const rhsNum = parseInt(rhs, 10);
  const rhsIsNum = !Number.isNaN(rhsNum) && String(rhsNum) === rhs;
  return (card) => {
    const v = card.collector_number || "";
    let pass = false;
    if (rhsIsNum) {
      const lv = parseInt(String(v).replace(/\D+/g, ""), 10);
      if (Number.isNaN(lv)) return false;
      switch (op) {
        case "=":
          pass = lv === rhsNum;
          break;
        case "!=":
          pass = lv !== rhsNum;
          break;
        case ">":
          pass = lv > rhsNum;
          break;
        case ">=":
          pass = lv >= rhsNum;
          break;
        case "<":
          pass = lv < rhsNum;
          break;
        case "<=":
          pass = lv <= rhsNum;
          break;
      }
    } else {
      // lex compare
      const lv = String(v);
      switch (op) {
        case "=":
          pass = lv === rhs;
          break;
        case "!=":
          pass = lv !== rhs;
          break;
        case ">":
          pass = lv > rhs;
          break;
        case ">=":
          pass = lv >= rhs;
          break;
        case "<":
          pass = lv < rhs;
          break;
        case "<=":
          pass = lv <= rhs;
          break;
      }
    }
    return neg ? !pass : pass;
  };
}

function pricePredicate(
  kind: "usd" | "eur" | "tix",
  raw: string,
  neg: boolean,
): Predicate {
  const m = raw.match(/^(<=|>=|!=|=|<|>)?\s*(\d+(?:\.\d+)?)$/);
  if (!m) return () => true;
  const op = m[1] || "=";
  const rhs = parseFloat(m[2]);
  return (card) => {
    const pStr = card.prices && (card.prices as any)[kind];
    const v = pStr ? parseFloat(pStr) : NaN;
    if (!isFinite(v)) return false;
    let pass = false;
    switch (op) {
      case "=":
        pass = v === rhs;
        break;
      case "!=":
        pass = v !== rhs;
        break;
      case ">":
        pass = v > rhs;
        break;
      case ">=":
        pass = v >= rhs;
        break;
      case "<":
        pass = v < rhs;
        break;
      case "<=":
        pass = v <= rhs;
        break;
    }
    return neg ? !pass : pass;
  };
}

function gamesPredicate(raw: string, neg: boolean): Predicate {
  // e.g. game:arena or -in:mtgo (we map both to games includes)
  const rx = textToRegex(raw.toLowerCase());
  return (card) => {
    const gs = (card.games || []).map((g) => String(g).toLowerCase());
    const hit = gs.some((g) => rx.test(g));
    return neg ? !hit : hit;
  };
}

function datePredicate(raw: string, neg: boolean): Predicate {
  // Accept yyyy-mm-dd or set code (we only support direct date here) with comparisons
  const m = raw.match(
    /^(<=|>=|!=|=|<|>)?\s*([0-9]{4})(?:-([0-9]{2})-([0-9]{2}))?$/,
  );
  if (!m) return () => true;
  const op = m[1] || "=";
  const year = parseInt(m[2], 10);
  const mm = m[3] ? parseInt(m[3], 10) : 1;
  const dd = m[4] ? parseInt(m[4], 10) : 1;
  const rhs = new Date(Date.UTC(year, mm - 1, dd)).getTime();
  return (card) => {
    const d = card.released_at ? Date.parse(card.released_at) : NaN;
    if (!isFinite(d)) return false;
    let pass = false;
    switch (op) {
      case "=":
        pass = d === rhs;
        break;
      case "!=":
        pass = d !== rhs;
        break;
      case ">":
        pass = d > rhs;
        break;
      case ">=":
        pass = d >= rhs;
        break;
      case "<":
        pass = d < rhs;
        break;
      case "<=":
        pass = d <= rhs;
        break;
    }
    return neg ? !pass : pass;
  };
}

function yearPredicate(raw: string, neg: boolean): Predicate {
  const m = raw.match(/^(<=|>=|!=|=|<|>)?\s*(\d{4})$/);
  if (!m) return () => true;
  const op = m[1] || "=";
  const rhs = parseInt(m[2], 10);
  return (card) => {
    const y = card.released_at
      ? new Date(card.released_at).getUTCFullYear()
      : (NaN as any);
    if (!isFinite(y)) return false;
    let pass = false;
    switch (op) {
      case "=":
        pass = y === rhs;
        break;
      case "!=":
        pass = y !== rhs;
        break;
      case ">":
        pass = y > rhs;
        break;
      case ">=":
        pass = y >= rhs;
        break;
      case "<":
        pass = y < rhs;
        break;
      case "<=":
        pass = y <= rhs;
        break;
    }
    return neg ? !pass : pass;
  };
}

function ptTotalPredicate(raw: string, neg: boolean): Predicate {
  // Compare (power + toughness)
  const m = raw.match(/^(<=|>=|!=|=|<|>)?\s*(\d+(?:\.\d+)?)$/);
  if (!m) return () => true;
  const op = m[1] || "=";
  const rhs = parseFloat(m[2]);
  return (card) => {
    const p = num(card.power);
    const t = num(card.toughness);
    if (!isFinite(p) || !isFinite(t)) return false;
    const v = p + t;
    let pass = false;
    switch (op) {
      case "=":
        pass = v === rhs;
        break;
      case "!=":
        pass = v !== rhs;
        break;
      case ">":
        pass = v > rhs;
        break;
      case ">=":
        pass = v >= rhs;
        break;
      case "<":
        pass = v < rhs;
        break;
      case "<=":
        pass = v <= rhs;
        break;
    }
    return neg ? !pass : pass;
  };
}

function manaCostPredicate(raw: string, neg: boolean): Predicate {
  // Support: m:WU, mana:{G}{U}, m>3WU, m:{R/P}, devotion:{u/b}{u/b}, produces=wu
  if (raw.trim().toLowerCase().startsWith("devotion")) {
    const spec = raw.split(/:|=/, 2)[1] || "";
    return devotionPredicate(spec, neg);
  }
  if (raw.trim().toLowerCase().startsWith("produces")) {
    const spec = raw.split(/:|=/, 2)[1] || "";
    return producesPredicate(spec, neg);
  }
  // Comparison against another cost spec
  const m = raw.match(/^(<=|>=|!=|=|<|>)?\s*(.+)$/);
  if (!m) return () => true;
  const op = m[1] || "=";
  const spec = m[2].trim();
  const want = parseCostSpec(spec);
  return (card) => {
    const mine = parseManaCost(card.mana_cost || "");
    let pass = false;
    switch (op) {
      case "=":
        pass = multisetEq(mine, want);
        break;
      case "!=":
        pass = !multisetEq(mine, want);
        break;
      case ">":
        pass = multisetSuperset(mine, want) && !multisetEq(mine, want);
        break;
      case ">=":
        pass = multisetSuperset(mine, want);
        break;
      case "<":
        pass = multisetSuperset(want, mine) && !multisetEq(mine, want);
        break;
      case "<=":
        pass = multisetSuperset(want, mine);
        break;
    }
    return neg ? !pass : pass;
  };
}

function devotionPredicate(specRaw: string, neg: boolean): Predicate {
  // spec like {u/b}{u/b}{u/b} or {G}{G}{G}
  const wants = (specRaw.match(/\{[^}]+\}/g) || []).map((tok) =>
    tok.replace(/[{}]/g, "").toUpperCase(),
  );
  return (card) => {
    const mine = (card.mana_cost || "").toUpperCase();
    const mineSyms = (mine.match(/\{[^}]+\}/g) || []).map((s) =>
      s.replace(/[{}]/g, ""),
    );
    // Greedy match: each wanted slot must be satisfied by some symbol in cost that contains any of its letters
    const pool = mineSyms.slice();
    for (const want of wants) {
      const choices = want.split("/");
      const idx = pool.findIndex((s) => choices.some((c) => s.includes(c)));
      if (idx === -1) return neg ? true : false;
      pool.splice(idx, 1);
    }
    return neg ? false : true;
  };
}

function producesPredicate(specRaw: string, neg: boolean): Predicate {
  // spec like wu or {W}{U}
  const letters = specRaw
    .replace(/[^WUBRG]/gi, "")
    .toUpperCase()
    .split("");
  const target = new Set(letters);
  return (card) => {
    const prod = (card.produced_mana || []) as string[];
    const have = new Set(prod.map((x) => x.toUpperCase()));
    let pass = true;
    for (const c of target)
      if (!have.has(c)) {
        pass = false;
        break;
      }
    return neg ? !pass : pass;
  };
}

function multisetEq(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}
function multisetSuperset(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  // a contains all of b (>=)
  return Object.keys(b).every((k) => (a[k] || 0) >= (b[k] || 0));
}

function parseCostSpec(spec: string): Record<string, number> {
  // Accept forms: {G}{U}, 2WU, 3WWU, {R/P}
  const out: Record<string, number> = {};
  const norm = spec.toUpperCase().replace(/\s+/g, "");
  const braces = norm.match(/\{[^}]+\}/g);
  if (braces) {
    for (const b of braces) {
      const key = b;
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  }
  // Unbraced shorthand: sequence of numbers/letters => expand to tokens
  // e.g. 2WWU => {2}{W}{W}{U}
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (/[0-9]/.test(ch)) {
      // parse number token
      let j = i + 1;
      while (j < norm.length && /[0-9]/.test(norm[j])) j++;
      const numTok = "{" + norm.slice(i, j) + "}";
      out[numTok] = (out[numTok] || 0) + 1;
      i = j;
      continue;
    }
    if (/[WUBRGCX]/.test(ch)) {
      const tok = "{" + ch + "}";
      out[tok] = (out[tok] || 0) + 1;
      i++;
      continue;
    }
    // ignore others
    i++;
  }
  return out;
}

function parseManaCost(cost: string): Record<string, number> {
  const out: Record<string, number> = {};
  const m = (cost || "").toUpperCase().match(/\{[^}]+\}/g) || [];
  for (const tok of m) out[tok] = (out[tok] || 0) + 1;
  return out;
}

function hasManaSymbol(cost: string | undefined | null, rx: RegExp): boolean {
  if (!cost) return false;
  return rx.test(cost);
}

function num(v: any): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : NaN;
}

// Formats and banlists
export function formatPredicate(
  formatRaw: string,
  status: "legal" | "banned" | "restricted",
  neg: boolean,
): Predicate {
  const fmt = formatRaw.toLowerCase();
  return (card) => {
    const leg = card.legalities || ({} as any);
    const v = String(leg[fmt] || "").toLowerCase();
    const pass = v === status;
    return neg ? !pass : pass;
  };
}

function mvParityPredicate(isEven: boolean, neg: boolean): Predicate {
  return (card) => {
    const mv = card.cmc;
    if (typeof mv !== "number" || !isFinite(mv)) return false;
    const pass = isEven ? Math.floor(mv) % 2 === 0 : Math.floor(mv) % 2 === 1;
    return neg ? !pass : pass;
  };
}

function normalizeStatField(s: string): "power" | "toughness" | "loyalty" {
  const v = s.toLowerCase();
  if (v === "pow" || v === "power") return "power";
  if (v === "tou" || v === "toughness") return "toughness";
  return "loyalty";
}

function crossFieldPredicate(
  l: "power" | "toughness" | "loyalty",
  op: string,
  r: "power" | "toughness" | "loyalty",
  neg: boolean,
): Predicate {
  return (card) => {
    const lv = num((card as any)[l]);
    const rv = num((card as any)[r]);
    if (!isFinite(lv) || !isFinite(rv)) return false;
    let pass = false;
    switch (op) {
      case "=":
        pass = lv === rv;
        break;
      case "!=":
        pass = lv !== rv;
        break;
      case ">":
        pass = lv > rv;
        break;
      case ">=":
        pass = lv >= rv;
        break;
      case "<":
        pass = lv < rv;
        break;
      case "<=":
        pass = lv <= rv;
        break;
    }
    return neg ? !pass : pass;
  };
}
