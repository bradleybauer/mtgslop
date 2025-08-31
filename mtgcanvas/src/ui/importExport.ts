import { createPanel, ensureThemeStyles } from "./theme";
import {
  extractBaseCardName,
  parseDecklist,
  parseGroupsText,
} from "../services/decklist";
export { extractBaseCardName, parseDecklist };

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

export function installImportExport(
  opts: ImportExportOptions,
): ImportExportAPI {
  ensureThemeStyles();
  let panel: HTMLDivElement | null = null;
  let exportArea: HTMLTextAreaElement | null = null;
  let importArea: HTMLTextAreaElement | null = null;
  let scopeAll = true; // true=all, false=selection
  let statusEl: HTMLDivElement | null = null;
  // Busy state to prevent concurrent operations
  let textInFlight = false;
  let scryInFlight = false;
  // Refs to Scryfall controls (if present)
  let scryRunBtn: HTMLButtonElement | null = null;
  let scryQueryEl: HTMLInputElement | null = null;
  let scryStatusEl: HTMLDivElement | null = null;
  // Abort controller for text import
  let textAbort: AbortController | null = null;

  // Keep both panes in sync when one is busy
  const updateBusyUI = () => {
    const otherBusyMsg = "Blocked: another import is in progress.";
    // Text import controls
    if (importArea) importArea.disabled = scryInFlight; // prevent editing while Scryfall runs
    const importBtn = panel?.querySelector(
      "#ie-import-btn",
    ) as HTMLButtonElement | null;
    if (importBtn) {
      // Mirror Scryfall behavior: when running, show Cancel and keep enabled
      if (textInFlight) {
        importBtn.disabled = false;
        importBtn.textContent = "Cancel";
        importBtn.title = "Click to cancel the import.";
      } else {
        importBtn.disabled = !!scryInFlight;
        importBtn.textContent = "Import";
        importBtn.title = scryInFlight
          ? "Scryfall import is in progress. Cancel it to enable."
          : "Import cards from the text area.";
      }
    }
    if (scryInFlight && statusEl && !textInFlight)
      statusEl.textContent = otherBusyMsg;

    // Scryfall controls
    if (scryQueryEl) scryQueryEl.disabled = textInFlight || scryInFlight; // disabled during either busy state
    if (scryRunBtn) {
      // When Scryfall is busy, button is active as "Cancel"; otherwise disabled if text import is busy
      if (scryInFlight) {
        scryRunBtn.disabled = false;
        scryRunBtn.textContent = "Cancel";
        scryRunBtn.title = "Click to cancel the Scryfall import.";
      } else {
        scryRunBtn.disabled = textInFlight;
        scryRunBtn.textContent = "Import";
        scryRunBtn.title = textInFlight
          ? "Text import is in progress. Wait or cancel it first."
          : "Run Scryfall import";
      }
    }
    if (textInFlight && scryStatusEl && !scryInFlight)
      scryStatusEl.textContent = otherBusyMsg;
  };

  function summarizeUnknown(unknown: string[], maxShow = 20): string {
    const n = unknown.length | 0;
    if (n <= 0) return "All resolved.";
    if (n <= maxShow) return `Unknown: ${unknown.join(", ")}`;
    const first = unknown.slice(0, maxShow);
    return `Unknown: ${n} names (showing first ${maxShow}): ${first.join(", ")}`;
  }

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
            <div id="ie-status" style="opacity:.88;font-size:16px;"></div>
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
          <div id="ie-scry-status" style="opacity:.88;font-size:16px;"></div>
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
    // Disable spell/grammar on text areas
    if (exportArea) {
      exportArea.spellcheck = false;
      exportArea.setAttribute("autocapitalize", "off");
      exportArea.setAttribute("autocorrect", "off");
      exportArea.setAttribute("data-gramm", "false");
      exportArea.setAttribute("data-gramm_editor", "false");
    }
    if (importArea) {
      importArea.spellcheck = false;
      importArea.setAttribute("autocapitalize", "off");
      importArea.setAttribute("autocorrect", "off");
      importArea.setAttribute("data-gramm", "false");
      importArea.setAttribute("data-gramm_editor", "false");
    }
    // no explicit close button; use Esc or moving cursor away from FAB area to hide
    const copyBtn = el.querySelector("#ie-copy") as HTMLButtonElement;
    const dlBtn = el.querySelector("#ie-download") as HTMLButtonElement;

    const scopeAllEl = el.querySelector("#ie-scope-all") as HTMLInputElement;
    const scopeSelEl = el.querySelector("#ie-scope-sel") as HTMLInputElement;
    const importBtn = el.querySelector("#ie-import-btn") as HTMLButtonElement;
    // Initialize disabled state after wiring up controls
    updateBusyUI();
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
      // If already running, treat as cancel
      if (textInFlight) {
        try {
          textAbort?.abort();
        } catch {}
        return;
      }
      if (!importArea) return;
      if (scryInFlight) {
        // Don't allow text import while Scryfall is running
        if (statusEl)
          statusEl.textContent =
            "Scryfall import is in progress. Cancel it first.";
        return;
      }
      const inputText = importArea.value;
      if (!inputText.trim()) {
        if (statusEl) statusEl.textContent = "Nothing to import.";
        return;
      }
      // Start import; allow cancel via AbortController
      textAbort = new AbortController();
      textInFlight = true;
      updateBusyUI();
      // Try groups format first
      const asGroups = parseGroupsText(inputText);
      if (asGroups && opts.importGroups) {
        if (statusEl) statusEl.textContent = "Importing groups…";
        try {
          const res = await opts.importGroups(asGroups, {
            onProgress: (done, total) => {
              if (!statusEl) return;
              if (typeof total === "number" && total > 0)
                statusEl.textContent = `Resolving ${done}/${total}…`;
              else statusEl.textContent = `Resolving ${done}…`;
            },
            signal: textAbort.signal,
          });
          if (statusEl)
            statusEl.textContent = `Imported ${res.imported}${(res as any).limited ? ` (limited by cap)` : ""}. ${summarizeUnknown(res.unknown)}`;
        } catch (e: any) {
          if (
            e &&
            (e.name === "AbortError" || /aborted/i.test(e.message || ""))
          ) {
            if (statusEl) statusEl.textContent = "Canceled.";
          } else {
            if (statusEl)
              statusEl.textContent =
                "Import failed: " + (e?.message || String(e));
          }
        } finally {
          textInFlight = false;
          textAbort = null;
          updateBusyUI();
        }
        return;
      }
      // Fallback to decklist format
      const items = parseDecklist(inputText);
      if (!items.length) {
        if (statusEl) statusEl.textContent = "Nothing to import.";
        textInFlight = false;
        updateBusyUI();
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
          signal: textAbort.signal,
        });
        if (statusEl)
          statusEl.textContent = `Imported ${res.imported}${(res as any).limited ? ` (limited by cap)` : ""}. ${summarizeUnknown(res.unknown)}`;
      } catch (e: any) {
        if (
          e &&
          (e.name === "AbortError" || /aborted/i.test(e.message || ""))
        ) {
          if (statusEl) statusEl.textContent = "Canceled.";
        } else {
          if (statusEl)
            statusEl.textContent =
              "Import failed: " + (e?.message || String(e));
        }
      } finally {
        textInFlight = false;
        textAbort = null;
        updateBusyUI();
      }
    };

    // Scryfall search wiring
    if (opts.scryfallSearchAndPlace && scryPane) {
      scryRunBtn = el.querySelector("#ie-scry-run") as HTMLButtonElement | null;
      scryQueryEl = el.querySelector(
        "#ie-scry-query",
      ) as HTMLInputElement | null;
      // opt-out spell/grammar/autocap on scryfall input
      if (scryQueryEl) {
        scryQueryEl.spellcheck = false;
        scryQueryEl.setAttribute("autocapitalize", "off");
        scryQueryEl.setAttribute("autocorrect", "off");
        scryQueryEl.setAttribute("data-gramm", "false");
        scryQueryEl.setAttribute("data-gramm_editor", "false");
      }
      scryStatusEl = el.querySelector(
        "#ie-scry-status",
      ) as HTMLDivElement | null;
      let scryAbort: AbortController | null = null;
      const runOrCancel = async () => {
        if (scryInFlight) {
          // Treat click as cancel
          try {
            scryAbort?.abort();
          } catch {}
          return;
        }
        if (textInFlight) {
          if (scryStatusEl)
            scryStatusEl.textContent =
              "Text import is in progress. Wait or cancel it first.";
          return;
        }
        const q = (scryQueryEl?.value || "").trim();
        if (!q) {
          if (scryStatusEl) scryStatusEl.textContent = "Enter a query.";
          return;
        }
        const groupName = q.slice(0, 64);
        if (scryStatusEl) scryStatusEl.textContent = "Searching…";
        scryAbort = new AbortController();
        scryInFlight = true;
        updateBusyUI();
        try {
          const res = await opts.scryfallSearchAndPlace!(q, {
            groupName,
            signal: scryAbort.signal,
            onProgress: (fetched, total) => {
              if (!scryStatusEl) return;
              if (typeof total === "number" && total > 0)
                scryStatusEl.textContent = `Fetching ${fetched}/${total}…`;
              else scryStatusEl.textContent = `Fetching ${fetched}…`;
            },
          });
          scryStatusEl &&
            (scryStatusEl.textContent = res.error
              ? res.error
              : `Imported ${res.imported} cards${(res as any).limited ? " (limited by cap)" : ""}.`);
        } catch (e: any) {
          if (
            e &&
            (e.name === "AbortError" || /aborted/i.test(e.message || ""))
          ) {
            scryStatusEl && (scryStatusEl.textContent = "Canceled.");
          } else {
            scryStatusEl &&
              (scryStatusEl.textContent =
                "Search failed: " + (e?.message || String(e)));
          }
        } finally {
          scryInFlight = false;
          updateBusyUI();
          scryAbort = null;
        }
      };
      scryRunBtn?.addEventListener("click", runOrCancel);
      scryQueryEl?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey) {
          ev.preventDefault();
          if (!scryInFlight && !textInFlight) runOrCancel();
        }
      });
      // Initialize disabled state on first render
      updateBusyUI();
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
