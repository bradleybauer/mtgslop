// Pure utilities for parsing decklists and grouped card text.
// These are UI-agnostic and safe to unit test in a Node environment.

// Strip trailing metadata often present in exports (set code, collector number, foil flags, etc.).
// Examples handled:
//   "Omo, Queen of Vesuva (M3C) 2 *F*" -> "Omo, Queen of Vesuva"
//   "Forest (MH3) 318" -> "Forest"
//   "Arcane Signet [M3C] 283" -> "Arcane Signet"
// We intentionally avoid trimming around '//' to keep split/double-faced names intact.
export function extractBaseCardName(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return s;
  // Cut at first space+opening parenthesis or bracket
  const paren = s.indexOf(" (");
  const brack = s.indexOf(" [");
  let cut = -1;
  if (paren >= 0) cut = paren;
  if (brack >= 0) cut = cut >= 0 ? Math.min(cut, brack) : brack;
  const hadSetBracket = cut >= 0; // indicates we trimmed " (SET)" or " [SET]"
  // If not found, optionally cut at a trailing token like " *F*" or " *Foil*"
  if (cut < 0) {
    const foil1 = s.indexOf(" *F*");
    const foil2 = s.toLowerCase().indexOf(" *foil*");
    if (foil1 >= 0) cut = foil1;
    if (foil2 >= 0) cut = cut >= 0 ? Math.min(cut, foil2) : foil2;
  }
  // Final guard (narrowed): if still not found but there's a trailing number chunk at END OF LINE,
  // cut before that number (helps with exports like "Forest 318").
  // Do NOT cut if digits are followed by other characters (e.g., "Vault 112: ...").
  if (cut < 0 && hadSetBracket) {
    const m = s.match(/^(.*?)(?:\s+)(\d{1,4})\s*$/);
    if (m && m[1] && m[1].trim().length >= 2) cut = (m[1] as string).length;
  }
  const out = cut >= 0 ? s.slice(0, cut) : s;
  return out.trim();
}

export function parseDecklist(text: string): { name: string; count: number }[] {
  const out: { name: string; count: number }[] = [];
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;
    // Remove comments after '#'
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash).trim();
    if (!line) continue;
    // Accept variants: "3 Lightning Bolt", "Lightning Bolt x3", or just name
    // Also accept leading count with 'x': "3x Lightning Bolt"
    let m = line.match(/^(\d+)\s*[xX]\s+(.+)$/);
    if (m) {
      const base = extractBaseCardName(m[2]);
      out.push({ count: Math.max(1, parseInt(m[1], 10)), name: base });
      continue;
    }
    m = line.match(/^(\d+)\s+(.+)$/);
    if (m) {
      const base = extractBaseCardName(m[2]);
      out.push({ count: Math.max(1, parseInt(m[1], 10)), name: base });
      continue;
    }
    m = line.match(/^(.+?)\s*[xX]\s*(\d+)$/);
    if (m) {
      const base = extractBaseCardName(m[1]);
      out.push({ name: base, count: Math.max(1, parseInt(m[2], 10)) });
      continue;
    }
    out.push({ name: extractBaseCardName(line), count: 1 });
  }
  // Combine duplicates
  const grouped = new Map<string, number>();
  for (const it of out)
    grouped.set(it.name, (grouped.get(it.name) || 0) + it.count);
  return [...grouped.entries()].map(([name, count]) => ({ name, count }));
}

export function parseGroupsText(
  text: string,
): { groups: { name: string; cards: string[] }[]; ungrouped: string[] } | null {
  const lines = text.split(/\r?\n/);
  let hasHeading = false;
  const groups: { name: string; cards: string[] }[] = [];
  const ungrouped: string[] = [];
  let current: { name: string; cards: string[] } | null = null;
  let inUngrouped = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Headings like "# Group Name"; special sentinel heading "#ungrouped" (no space)
    if (line.startsWith("#")) {
      hasHeading = true;
      // Explicit ungrouped sentinel: exactly "#ungrouped" (case-insensitive)
      if (/^#ungrouped$/i.test(line)) {
        current = null;
        inUngrouped = true;
        continue;
      }
      const name = line.replace(/^#+\s*/, "").trim();
      if (!name) {
        current = null;
        inUngrouped = false;
        continue;
      }
      inUngrouped = false;
      current = { name, cards: [] };
      groups.push(current);
      continue;
    }
    if (/^\((empty|none)\)$/i.test(line)) continue; // ignore placeholders
    // List items: plain lines or those starting with '-'/'*'. Optional leading count.
    let item = line;
    const m = line.match(/^[-*]\s*(.+)$/);
    if (m) item = m[1].trim();
    if (!item) continue;
    let count = 1;
    let cm = item.match(/^(\d+)\s*[xX]\s+(.+)$/);
    if (cm) {
      count = Math.max(1, parseInt(cm[1], 10));
      item = cm[2].trim();
    } else {
      cm = item.match(/^(\d+)\s+(.+)$/);
      if (cm) {
        count = Math.max(1, parseInt(cm[1], 10));
        item = cm[2].trim();
      }
    }
    if (!item) continue;
    const pushMany = (arr: string[]) => {
      const base = extractBaseCardName(item);
      for (let i = 0; i < count; i++) arr.push(base);
    };
    if (inUngrouped) pushMany(ungrouped);
    else if (current) pushMany(current.cards);
    else pushMany(ungrouped);
  }
  if (!hasHeading && !(ungrouped.length && groups.length === 0)) return null;
  return { groups, ungrouped };
}
