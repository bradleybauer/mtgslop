import { createPanel, ensureThemeStyles } from "./theme";

export interface ImportExportOptions {
  getAllNames: () => string[]; // all sprite names (one per sprite)
  getSelectedNames: () => string[]; // names for selected sprites
  importByNames: (
    items: { name: string; count: number }[],
  opt?: { onProgress?: (done: number, total?: number) => void; signal?: AbortSignal },
  ) => Promise<{ imported: number; unknown: string[] }>; // performs import, returns stats
  // Optional: provide a preformatted text export of groups and ungrouped cards
  getGroupsExport?: () => string;
  // Optional: import the simple groups text format (headings + list items)
  importGroups?: (
    data: {
      groups: { name: string; cards: string[] }[];
      ungrouped: string[];
    },
    opt?: { onProgress?: (done: number, total?: number) => void; signal?: AbortSignal },
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

function frontFace(name: string): string {
  const s = (name || "").trim();
  if (!s) return s;
  const i = s.indexOf("//");
  return i >= 0 ? s.slice(0, i).trim() : s;
}

function groupCounts(names: string[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const n of names) {
    const key = frontFace(n);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

function countsToText(items: { name: string; count: number }[]): string {
  return items.map((it) => `${it.count} ${it.name}`).join("\n");
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
    let m = line.match(/^(\d+)\s+(.+)$/);
    if (m) {
      out.push({ count: Math.max(1, parseInt(m[1], 10)), name: m[2].trim() });
      continue;
    }
    m = line.match(/^(.+?)\s*[xX]\s*(\d+)$/);
    if (m) {
      out.push({ name: m[1].trim(), count: Math.max(1, parseInt(m[2], 10)) });
      continue;
    }
    out.push({ name: line, count: 1 });
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
    // Headings like "# Group Name"; special heading "# Ungrouped"
    if (line.startsWith("#")) {
      hasHeading = true;
      const name = line.replace(/^#+\s*/, "").trim();
      if (!name) {
        current = null;
        inUngrouped = false;
        continue;
      }
      if (/^ungrouped$/i.test(name)) {
        current = null;
        inUngrouped = true;
        continue;
      }
      inUngrouped = false;
      current = { name, cards: [] };
      groups.push(current);
      continue;
    }
    if (/^\((empty|none)\)$/i.test(line)) continue; // ignore placeholders
    // List items: "- Card Name" or "* Card Name"; also accept plain lines if within a section
    let name = line;
    const m = line.match(/^[-*]\s*(.+)$/);
    if (m) name = m[1].trim();
    if (!name) continue;
    if (inUngrouped) ungrouped.push(name);
    else if (current) current.cards.push(name);
    else {
      // No heading yet: treat as ungrouped list style
      ungrouped.push(name);
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
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">
        <div style="font-size:26px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;opacity:.9;">Import / Export</div>
        <div style="margin-left:auto;display:flex;gap:6px;">
      ${opts.clearPersistedData ? '<button type="button" id="ie-clear-data" class="ui-btn danger" title="Clear persisted data (debug)" style="font-size:14px;padding:6px 10px">Clear Data…</button>' : ""}
          <button type="button" id="ie-close" class="ui-btn" title="Close" style="font-size:14px;padding:6px 10px">Close</button>
        </div>
      </div>
      <div style="display:block;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;" id="ie-content">
        <div>
          <h2>Export</h2>
          <div style="display:flex;gap:10px;align-items:center;margin:6px 0 8px;">
            <label class="ui-pill" style="display:inline-flex;gap:8px;align-items:center;padding:6px 10px;cursor:pointer;"><input id="ie-scope-all" type="radio" name="ie-scope" checked style="margin:0 6px 0 0"/> All</label>
            <label class="ui-pill" style="display:inline-flex;gap:8px;align-items:center;padding:6px 10px;cursor:pointer;"><input id="ie-scope-sel" type="radio" name="ie-scope" style="margin:0 6px 0 0"/> Selection</label>
            <div style="margin-left:auto;display:flex;gap:8px;align-items:center;">
              <label style="opacity:.85;">Format:</label>
              <select id="ie-format" class="ui-input" style="padding:4px 6px;">
                <option value="counts" selected>Counts (decklist)</option>
                <option value="groups">Groups</option>
              </select>
              <button id="ie-refresh" class="ui-btn" type="button">Refresh</button>
            </div>
          </div>
          <textarea id="ie-export" class="ui-input" style="width:100%;min-height:220px;white-space:pre;" readonly placeholder="Exported decklist will appear here"></textarea>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button id="ie-copy" type="button" class="ui-btn">Copy</button>
            <button id="ie-download" type="button" class="ui-btn">Download .txt</button>
          </div>
        </div>
        <div>
          <h2>Import</h2>
          <textarea id="ie-import" class="ui-input" style="width:100%;min-height:260px;white-space:pre;" placeholder="Paste decklist: e.g.\n4 Lightning Bolt\n2 Counterspell\nIsland x8"></textarea>
          <div style="display:flex;gap:8px;margin-top:8px;align-items:center;">
            <button id="ie-import-btn" type="button" class="ui-btn">Add to Canvas</button>
            <div id="ie-status" style="opacity:.8;font-size:12px;"></div>
          </div>
        </div>
        ${
          opts.scryfallSearchAndPlace
            ? `
        <div id="ie-scry-pane" style="grid-column:1 / span 2;">
          <h2>Import from Scryfall search</h2>
          <div style="display:flex;gap:8px;align-items:center;margin:6px 0 8px;">
            <input id="ie-scry-query" class="ui-input" style="flex:1;padding:8px 10px;" placeholder="Scryfall query (e.g., o:infect t:creature cmc<=3)"/>
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
    const closeBtn = el.querySelector("#ie-close") as HTMLButtonElement;
    const copyBtn = el.querySelector("#ie-copy") as HTMLButtonElement;
    const dlBtn = el.querySelector("#ie-download") as HTMLButtonElement;
    const refreshBtn = el.querySelector("#ie-refresh") as HTMLButtonElement;
    const formatSel = el.querySelector("#ie-format") as HTMLSelectElement;
    const clearBtn = el.querySelector(
      "#ie-clear-data",
    ) as HTMLButtonElement | null;
    const scopeAllEl = el.querySelector("#ie-scope-all") as HTMLInputElement;
    const scopeSelEl = el.querySelector("#ie-scope-sel") as HTMLInputElement;
    const importBtn = el.querySelector("#ie-import-btn") as HTMLButtonElement;
    const scryPane = el.querySelector("#ie-scry-pane") as HTMLDivElement | null;

    const refreshExport = () => {
      const fmt = formatSel?.value || "counts";
      if (fmt === "groups" && opts.getGroupsExport) {
        if (exportArea) exportArea.value = opts.getGroupsExport();
        return;
      }
      const names = scopeAll ? opts.getAllNames() : opts.getSelectedNames();
      const items = groupCounts(names);
      if (exportArea) exportArea.value = countsToText(items);
    };

    scopeAllEl.onchange = () => {
      scopeAll = true;
      refreshExport();
    };
    scopeSelEl.onchange = () => {
      scopeAll = false;
      refreshExport();
    };
    refreshBtn.onclick = () => refreshExport();
    formatSel.onchange = () => refreshExport();
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
    closeBtn.onclick = () => hide();
    if (clearBtn && opts.clearPersistedData) {
      clearBtn.onclick = async () => {
        const ok = window.confirm(
          "Clear persisted MTGCanvas data (positions, groups, imported cards)?\nThis will reload the page.",
        );
        if (!ok) return;
        clearBtn.disabled = true;
        clearBtn.textContent = "Clearing…";
        try {
          await opts.clearPersistedData!();
        } catch {}
        // Give the UI a moment to update then reload
        setTimeout(() => location.reload(), 200);
      };
    }
    importBtn.onclick = async () => {
      if (!importArea) return;
      const inputText = importArea.value;
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
          statusEl.textContent = `Imported ${res.imported}. ${res.unknown.length ? "Unknown: " + res.unknown.join(", ") : "All resolved."}`;
        return;
      }
      // Fallback to decklist format
      const items = parseDecklist(inputText);
      if (!items.length) {
        if (statusEl) statusEl.textContent = "Nothing to import.";
        return;
      }
      if (statusEl) statusEl.textContent = "Importing…";
  const res = await opts.importByNames(items, {
        onProgress: (done, total) => {
          if (!statusEl) return;
          if (typeof total === "number" && total > 0)
            statusEl.textContent = `Resolving ${done}/${total}…`;
          else statusEl.textContent = `Resolving ${done}…`;
        },
      });
      if (statusEl)
        statusEl.textContent = `Imported ${res.imported}. ${res.unknown.length ? "Unknown: " + res.unknown.join(", ") : "All resolved."}`;
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
              : `Imported ${res.imported} cards.`);
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
    // Use current format selection when showing
  const fmtSel = elp.querySelector("#ie-format") as HTMLSelectElement | null;
    const fmt = fmtSel?.value || "counts";
    if (fmt === "groups" && (opts as any).getGroupsExport) {
      if (exportArea) exportArea.value = (opts as any).getGroupsExport();
    } else {
      const names = scopeAll ? opts.getAllNames() : opts.getSelectedNames();
      if (exportArea) exportArea.value = countsToText(groupCounts(names));
    }
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
