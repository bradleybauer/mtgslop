import { createPanel, ensureThemeStyles } from "./theme";

export interface ImportExportOptions {
  getAllNames: () => string[]; // all sprite names (one per sprite)
  getSelectedNames: () => string[]; // names for selected sprites
  importByNames: (
    items: { name: string; count: number }[],
    opt?: {
      onProgress?: (done: number, total?: number) => void;
      signal?: AbortSignal;
    },
  ) => Promise<{ imported: number; unknown: string[] }>; // performs import, returns stats
  // Optional: provide a preformatted text export of groups and ungrouped cards
  getGroupsExport?: () => string;
  // Optional: provide scoped grouped export, limited to 'all' or 'selection'
  getGroupsExportScoped?: (scope: "all" | "selection") => string;
  // Optional: import the simple groups text format (headings + list items)
  importGroups?: (
    data: {
      groups: { name: string; cards: string[] }[];
      ungrouped: string[];
    },
    opt?: {
      onProgress?: (done: number, total?: number) => void;
      signal?: AbortSignal;
    },
  ) => Promise<{ imported: number; unknown: string[] }>;
  // Optional: Scryfall search integration – when provided, panel shows a Search tab
  scryfallSearchAndPlace?: (
    query: string,
    opt: {
      maxCards?: number;
      groupName?: string;
      onProgress?: (fetched: number, total?: number) => void;
      signal?: AbortSignal;
    },
  ) => Promise<{ imported: number; error?: string }>;
  // Optional: Debug helper to clear persisted data (positions, groups, imported cards)
  clearPersistedData?: () => Promise<void>;
}

export interface ImportExportAPI {
  show(): void;
  hide(): void;
}

// Strip trailing metadata often present in exports (set code, collector number, foil flags, etc.).
// Examples handled:
//   "Omo, Queen of Vesuva (M3C) 2 *F*" -> "Omo, Queen of Vesuva"
//   "Forest (MH3) 318" -> "Forest"
//   "Arcane Signet [M3C] 283" -> "Arcane Signet"
// We intentionally avoid trimming around '//' to keep split/double-faced names intact.
function extractBaseCardName(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return s;
  // Cut at first space+opening parenthesis or bracket
  const paren = s.indexOf(" (");
  const brack = s.indexOf(" [");
  let cut = -1;
  if (paren >= 0) cut = paren;
  if (brack >= 0) cut = cut >= 0 ? Math.min(cut, brack) : brack;
  // If not found, optionally cut at a trailing token like " *F*" or " *Foil*"
  if (cut < 0) {
    const foil1 = s.indexOf(" *F*");
    const foil2 = s.toLowerCase().indexOf(" *foil*");
    if (foil1 >= 0) cut = foil1;
    if (foil2 >= 0) cut = cut >= 0 ? Math.min(cut, foil2) : foil2;
  }
  // Final guard: if still not found but there's a trailing number chunk after a space,
  // and the part before looks non-empty, cut before that number (helps with "Name 123").
  if (cut < 0) {
    const m = s.match(/^(.*?)(\s+)(\d{1,4})(\s*.*)?$/);
    if (m && m[1] && m[1].trim().length >= 2) cut = (m[1] as string).length;
  }
  const out = cut >= 0 ? s.slice(0, cut) : s;
  return out.trim();
}

function parseDecklist(text: string): { name: string; count: number }[] {
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

function parseGroupsText(
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
    // List items: plain lines are now the canonical format (no leading '-'/'*').
    // For backward compatibility, also accept lines starting with '-' or '*'.
    // Also allow an optional leading count: "3 Lightning Bolt" duplicates the entry 3 times.
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
    else {
      // No heading yet: treat as ungrouped list style
      pushMany(ungrouped);
    }
  }
  if (!hasHeading && !(ungrouped.length && groups.length === 0)) return null; // likely not a groups format
  return { groups, ungrouped };
}

export function installImportExport(
  opts: ImportExportOptions,
): ImportExportAPI {
  ensureThemeStyles();
  let panel: HTMLDivElement | null = null;
  let exportArea: HTMLTextAreaElement | null = null;
  let importArea: HTMLTextAreaElement | null = null;
  let scopeAll = true; // true=all, false=selection
  let statusEl: HTMLDivElement | null = null;

  function ensure() {
    if (panel) return panel;
    const el = createPanel({
      width: "min(1100px, 90vw)",
      maxHeight: "86vh",
      scroll: true,
      pointer: true,
    });
    el.id = "import-export-panel";
    el.style.left = "50%";
    el.style.top = "10%";
    el.style.transform = "translateX(-50%)";
    el.style.zIndex = "10030";
    // Use uniform padding around the panel edges
    el.style.padding = "16px";
    el.innerHTML = `
      
      <div style="display:block;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;align-items:start;" id="ie-content">
        <div>
          <h2 style="margin-top:0">Export</h2>
          <textarea id="ie-export" class="ui-input" style="width:100%;min-height:300px;white-space:pre;resize:none;" readonly placeholder="Exported decklist will appear here"></textarea>
          <div style="display:flex;align-items:center;justify-content:flex-start;margin-top:10px;gap:12px;">
            <div style="display:flex;gap:10px;align-items:center;">
              <button id="ie-copy" type="button" class="ui-btn">Copy</button>
              <button id="ie-download" type="button" class="ui-btn">Download .txt</button>
            </div>
            <div style="display:flex;gap:12px;align-items:center;">
              <label class="ui-pill" style="display:inline-flex;gap:8px;align-items:center;padding:6px 10px;cursor:pointer;"><input id="ie-scope-all" type="radio" name="ie-scope" checked style="margin:0 6px 0 0"/> All</label>
              <label class="ui-pill" style="display:inline-flex;gap:8px;align-items:center;padding:6px 10px;cursor:pointer;"><input id="ie-scope-sel" type="radio" name="ie-scope" style="margin:0 6px 0 0"/> Selection</label>
            </div>
          </div>
        </div>
        <div>
          <h2 style="margin-top:0">Import</h2>
          <textarea id="ie-import" class="ui-input" style="width:100%;min-height:300px;white-space:pre;resize:none;" placeholder="Paste decklist: e.g.\n4 Lightning Bolt\n2 Counterspell\nIsland x8"></textarea>
          <div style="display:flex;gap:10px;margin-top:10px;align-items:center;">
            <button id="ie-import-btn" type="button" class="ui-btn">Import</button>
            <div id="ie-status" style="opacity:.8;font-size:12px;"></div>
          </div>
        </div>
        ${
          opts.scryfallSearchAndPlace
            ? `
        <div id="ie-scry-pane" style="grid-column:1 / span 2;">
          <h2>Import from Scryfall search</h2>
          <div style="display:flex;gap:10px;align-items:center;margin:8px 0 10px;">
            <input id="ie-scry-query" class="ui-input" style="flex:1;padding:10px 12px;" placeholder="Scryfall query (e.g., o:infect t:creature cmc<=3)"/>
            <button id="ie-scry-run" class="ui-btn" type="button">Import</button>
          </div>
          <div id="ie-scry-status" style="opacity:.8;font-size:12px;"></div>
        </div>`
            : ""
        }
        </div>
      </div>
    `;
    // Wire controls
    exportArea = el.querySelector("#ie-export") as HTMLTextAreaElement;
    importArea = el.querySelector("#ie-import") as HTMLTextAreaElement;
    statusEl = el.querySelector("#ie-status") as HTMLDivElement;
    // no explicit close button; use Esc or moving cursor away from FAB area to hide
    const copyBtn = el.querySelector("#ie-copy") as HTMLButtonElement;
    const dlBtn = el.querySelector("#ie-download") as HTMLButtonElement;

    const scopeAllEl = el.querySelector("#ie-scope-all") as HTMLInputElement;
    const scopeSelEl = el.querySelector("#ie-scope-sel") as HTMLInputElement;
    const importBtn = el.querySelector("#ie-import-btn") as HTMLButtonElement;
    const scryPane = el.querySelector("#ie-scry-pane") as HTMLDivElement | null;

    const refreshExport = () => {
      const scope: "all" | "selection" = scopeAll ? "all" : "selection";
      const txt = opts.getGroupsExportScoped
        ? opts.getGroupsExportScoped(scope)
        : opts.getGroupsExport
          ? opts.getGroupsExport()
          : "";
      if (exportArea) exportArea.value = txt;
    };

    scopeAllEl.onchange = () => {
      scopeAll = true;
      refreshExport();
    };
    scopeSelEl.onchange = () => {
      scopeAll = false;
      refreshExport();
    };

    // no format selector; always output counts + groups
    copyBtn.onclick = async () => {
      if (!exportArea) return;
      try {
        await navigator.clipboard.writeText(exportArea.value);
        (copyBtn as any).textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
      } catch {}
    };
    dlBtn.onclick = () => {
      if (!exportArea) return;
      const blob = new Blob([exportArea.value], {
        type: "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mtg-export.txt";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 0);
    };
    // Panel can be closed via Esc key (handled below) or by FAB hover logic
    // Clear Data moved to Debug panel
    importBtn.onclick = async () => {
      if (!importArea) return;
      const inputText = importArea.value;
      if (!inputText.trim()) {
        if (statusEl) statusEl.textContent = "Nothing to import.";
        return;
      }
      // Clear immediately to avoid accidental double import on rapid clicks
      importArea.value = "";
      // Disable button during import to prevent re-entry
      const prevLabel = importBtn.textContent;
      importBtn.disabled = true;
      importBtn.textContent = "Importing…";
      // Try groups format first
      const asGroups = parseGroupsText(inputText);
      if (asGroups && opts.importGroups) {
        if (statusEl) statusEl.textContent = "Importing groups…";
        const res = await opts.importGroups(asGroups, {
          onProgress: (done, total) => {
            if (!statusEl) return;
            if (typeof total === "number" && total > 0)
              statusEl.textContent = `Resolving ${done}/${total}…`;
            else statusEl.textContent = `Resolving ${done}…`;
          },
        });
        if (statusEl)
          statusEl.textContent = `Imported ${res.imported}${(res as any).limited ? ` (limited by cap)` : ""}. ${res.unknown.length ? "Unknown: " + res.unknown.join(", ") : "All resolved."}`;
        importBtn.disabled = false;
        importBtn.textContent = prevLabel || "Import";
        return;
      }
      // Fallback to decklist format
      const items = parseDecklist(inputText);
      if (!items.length) {
        if (statusEl) statusEl.textContent = "Nothing to import.";
        importBtn.disabled = false;
        importBtn.textContent = prevLabel || "Import";
        return;
      }
      if (statusEl) statusEl.textContent = "Importing…";
      try {
        const res = await opts.importByNames(items, {
          onProgress: (done, total) => {
            if (!statusEl) return;
            if (typeof total === "number" && total > 0)
              statusEl.textContent = `Resolving ${done}/${total}…`;
            else statusEl.textContent = `Resolving ${done}…`;
          },
        });
        if (statusEl)
          statusEl.textContent = `Imported ${res.imported}${(res as any).limited ? ` (limited by cap)` : ""}. ${res.unknown.length ? "Unknown: " + res.unknown.join(", ") : "All resolved."}`;
      } finally {
        importBtn.disabled = false;
        importBtn.textContent = prevLabel || "Import";
      }
    };

    // Scryfall search wiring
    if (opts.scryfallSearchAndPlace && scryPane) {
      const runBtn = el.querySelector(
        "#ie-scry-run",
      ) as HTMLButtonElement | null;
      const qEl = el.querySelector("#ie-scry-query") as HTMLInputElement | null;
      const scryStatus = el.querySelector(
        "#ie-scry-status",
      ) as HTMLDivElement | null;
      let scryInFlight = false;
      let scryAbort: AbortController | null = null;
      const setScryBusy = (busy: boolean) => {
        scryInFlight = busy;
        if (qEl) qEl.disabled = busy;
        if (runBtn) {
          runBtn.disabled = false;
          runBtn.textContent = busy ? "Cancel" : "Import";
        }
      };
      const runOrCancel = async () => {
        if (scryInFlight) {
          // Treat click as cancel
          try {
            scryAbort?.abort();
          } catch {}
          return;
        }
        const q = (qEl?.value || "").trim();
        if (!q) {
          if (scryStatus) scryStatus.textContent = "Enter a query.";
          return;
        }
        const groupName = q.slice(0, 64);
        if (scryStatus) scryStatus.textContent = "Searching…";
        scryAbort = new AbortController();
        setScryBusy(true);
        try {
          const res = await opts.scryfallSearchAndPlace!(q, {
            groupName,
            signal: scryAbort.signal,
            onProgress: (fetched, total) => {
              if (!scryStatus) return;
              if (typeof total === "number" && total > 0)
                scryStatus.textContent = `Fetching ${fetched}/${total}…`;
              else scryStatus.textContent = `Fetching ${fetched}…`;
            },
          });
          scryStatus &&
            (scryStatus.textContent = res.error
              ? res.error
              : `Imported ${res.imported} cards${(res as any).limited ? " (limited by cap)" : ""}.`);
        } catch (e: any) {
          if (
            e &&
            (e.name === "AbortError" || /aborted/i.test(e.message || ""))
          ) {
            scryStatus && (scryStatus.textContent = "Canceled.");
          } else {
            scryStatus &&
              (scryStatus.textContent =
                "Search failed: " + (e?.message || String(e)));
          }
        } finally {
          setScryBusy(false);
          scryAbort = null;
        }
      };
      runBtn?.addEventListener("click", runOrCancel);
      qEl?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          if (!scryInFlight) runOrCancel();
        }
      });
    }

    document.body.appendChild(el);
    panel = el;
    return el;
  }

  function show() {
    const elp = ensure();
    elp.style.display = "block"; // pre-populate export
    // Position under the Import/Export FAB if present
    try {
      const fab = document.getElementById("ie-fab");
      if (fab) {
        const rect = fab.getBoundingClientRect();
        elp.style.position = "fixed";
        elp.style.left = "auto";
        elp.style.right = "14px";
        elp.style.top = `${Math.round(rect.bottom + 8)}px`;
        elp.style.transform = "none";
      } else {
        // Fallback to centered position
        elp.style.left = "50%";
        elp.style.top = "10%";
        elp.style.right = "auto";
        elp.style.transform = "translateX(-50%)";
      }
    } catch {}
    // Use current scope selection when showing
    const scope: "all" | "selection" = scopeAll ? "all" : "selection";
    const txt = opts.getGroupsExportScoped
      ? opts.getGroupsExportScoped(scope)
      : opts.getGroupsExport
        ? opts.getGroupsExport()
        : "";
    if (exportArea) exportArea.value = txt;
    // focus import area for quick paste
    setTimeout(() => importArea?.focus(), 0);
  }
  function hide() {
    if (panel) panel.style.display = "none";
  }

  // Global Esc to close when visible
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && panel && panel.style.display !== "none") hide();
    },
    { capture: true },
  );

  return { show, hide };
}
