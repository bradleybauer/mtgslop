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
  name?: string;
  oracle_text?: string;
  type_line?: string;
  cmc?: number;
  layout?: string;
  color_identity?: string[] | string | null;
}

type Predicate = (card: CardLike) => boolean;

interface TokenNode { type: 'pred'; fn: Predicate; }
interface OrNode { type: 'or'; parts: Node[]; }
type Node = TokenNode | OrNode;

function ciString(ci: CardLike['color_identity']): string {
  if (!ci) return '';
  if (Array.isArray(ci)) return ci.join('').toUpperCase();
  return String(ci).toUpperCase();
}

const FIELD_ALIASES: Record<string,string> = {
  name:'name', n:'name',
  o:'oracle_text', oracle:'oracle_text',
  t:'type_line', type:'type_line',
  layout:'layout',
  cmc:'cmc', mv:'cmc',
  c:'color_identity', ci:'color_identity'
};

const NUM_FIELDS = new Set(['cmc']);
const TEXT_FIELDS = new Set(['name','oracle_text','type_line','layout']);

export function parseScryfallQuery(input: string): Predicate | null {
  const src = (input||'').trim(); if (!src) return null;
  try {
    const tokens = lexical(src);
    const node = parse(tokens);
    return card => evalNode(node, card);
  } catch (e) {
    console.warn('[scryfallQuery] parse failed – fallback to simple contains', e);
    return null;
  }
}

interface LexToken { v: string; neg?: boolean; }

function lexical(src:string): LexToken[] {
  const out: LexToken[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|\S+/g; // quoted or bare
  let m:RegExpExecArray|null;
  while ((m = re.exec(src))) {
    let raw = m[0];
    let neg = false;
    if (raw.startsWith('-')) { neg = true; raw = raw.slice(1); }
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1,-1).replace(/\\"/g,'"');
    if (raw) out.push({ v: raw, neg });
  }
  return out;
}

function parse(tokens: LexToken[]): Node {
  // Split by OR
  const groups: LexToken[][] = []; let cur: LexToken[] = [];
  for (const t of tokens) {
    if (t.v.toLowerCase() === 'or') { if (cur.length) groups.push(cur); cur = []; }
    else cur.push(t);
  }
  if (cur.length) groups.push(cur);
  const parts = groups.map(g=> ({ type:'pred', fn: buildAnd(g) }) as TokenNode);
  if (parts.length === 1) return parts[0];
  return { type:'or', parts } as OrNode;
}

function buildAnd(group: LexToken[]): Predicate {
  const preds: Predicate[] = [];
  for (const t of group) {
    const p = buildTokenPredicate(t.v, t.neg||false);
    if (p) preds.push(p);
  }
  if (!preds.length) return ()=>true;
  return card => preds.every(fn=> fn(card));
}

function buildTokenPredicate(raw:string, neg:boolean): Predicate | null {
  // field? token
  const m = raw.match(/^([a-zA-Z_][a-zA-Z0-9_]*):(.+)$/);
  if (m) {
    const fieldAlias = m[1].toLowerCase();
    // Allow quoting of field value even when only the value portion is quoted (e.g. -o:"+1/+1").
    // Our lexer only strips quotes when the ENTIRE token is quoted; for field prefixes the quotes
    // remain embedded, so strip them here if present so negations like -o:"+1/+1" work.
    let value = m[2];
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1,-1).replace(/\\"/g,'"');
    }
    const field = FIELD_ALIASES[fieldAlias];
    if (!field) return null;
    if (field === 'color_identity') return colorIdentityPredicate(value, neg);
    if (NUM_FIELDS.has(field)) return numericFieldPredicate(field, value, neg);
    if (TEXT_FIELDS.has(field)) return textFieldPredicate(field, value, neg);
    return null;
  }
  // Bare numeric forms: cmc>=3, mv=2 etc.
  const numBare = raw.match(/^(cmc|mv)(<=|>=|!=|=|<|>)(\d+(?:\.\d+)*)$/i);
  if (numBare) {
    const field = FIELD_ALIASES[numBare[1].toLowerCase()];
    return numericFieldPredicate(field, numBare[2] + numBare[3], neg);
  }
  // Bare color identity forms: c=uw, c>=uw, c<=wub, c!=g, cwu (contains at least w,u)
  const ciBare = raw.match(/^(c|ci)(<=|>=|=|!=)?([wubrg]+)$/i);
  if (ciBare) {
    const spec = (ciBare[2]||'') + ciBare[3];
    return colorIdentityPredicate(spec, neg);
  }
  // Free text token -> search name OR oracle
  return freeTextPredicate(raw, neg);
}

function freeTextPredicate(txt:string, neg:boolean): Predicate {
  const pattern = wcToRegex(txt.toLowerCase());
  return card => {
    const hay = ((card.name||'') + '\n' + (card.oracle_text||'')).toLowerCase();
    const hit = pattern.test(hay);
    return neg ? !hit : hit;
  };
}

function textFieldPredicate(field:string, raw:string, neg:boolean): Predicate {
  const rx = wcToRegex(raw.toLowerCase());
  return card => {
    const val = (card as any)[field];
    const hit = typeof val === 'string' && rx.test(val.toLowerCase());
    return neg ? !hit : hit;
  };
}

function numericFieldPredicate(field:string, raw:string, neg:boolean): Predicate {
  // Accept forms: >=3, <=2, >4, <5, =3, 3, !=4
  const m = raw.match(/^(<=|>=|!=|=|<|>)?\s*(\d+(?:\.\d+)?)$/);
  if (!m) return ()=> true; // malformed -> no-op
  const op = m[1]||'='; const num = parseFloat(m[2]);
  return card => {
    const v = (card as any)[field];
    if (typeof v !== 'number') return false;
    let pass=false;
    switch(op){
      case '=': pass = v===num; break;
      case '!=': pass = v!==num; break;
      case '>': pass = v>num; break;
      case '>=': pass = v>=num; break;
      case '<': pass = v<num; break;
      case '<=': pass = v<=num; break;
    }
    return neg ? !pass : pass;
  };
}

function colorIdentityPredicate(specRaw:string, neg:boolean): Predicate {
  // Supported: =wubrg exact, >=uw (at least), <=gw (subset), !=w (not exact), plain letters -> contains ALL letters (>= semantics).
  const m = specRaw.match(/^(<=|>=|=|!=)?([wubrg]+)/i);
  if (!m) return ()=> true;
  const op = m[1] || '>='; // default implicit -> contains all
  const letters = [...new Set(m[2].toUpperCase().split(''))];
  return card => {
    const id = ciString(card.color_identity);
    const set = new Set(id.split('').filter(x=> x));
    const target = new Set(letters);
    let pass=false;
    if (op==='=') pass = eqSet(set,target);
    else if (op==='!=') pass = !eqSet(set,target);
    else if (op==='>=') pass = subset(target,set); // set has all target
    else if (op==='<=') pass = subset(set,target); // set is subset
    return neg ? !pass : pass;
  };
}

function wcToRegex(pat:string): RegExp {
  // Escape regex special then replace * with .* for simple wildcard
  const esc = pat.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\\\*/g,'__AST__');
  const re = esc.replace(/__AST__/g,'.*');
  return new RegExp(re, 'i');
}

function subset(a:Set<string>, b:Set<string>): boolean { // a subset of b
  for (const v of a) if (!b.has(v)) return false; return true;
}
function eqSet(a:Set<string>, b:Set<string>): boolean { return a.size===b.size && subset(a,b); }

function evalNode(node: Node, card: CardLike): boolean {
  if (node.type==='pred') return node.fn(card);
  if (node.type==='or') return node.parts.some(p=> evalNode(p, card));
  return true;
}
