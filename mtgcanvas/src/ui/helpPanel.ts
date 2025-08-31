export interface HelpAPI {
  toggle(): void;
  show(): void;
  hide(): void;
  showCentered(): void;
  ensureFab(): void;
}

const HELP_SECTIONS = [
  {
    title: "Navigation",
    items: [
      ["Pan", "Space+Drag / Right Mouse Drag"],
      ["Zoom", "Mouse Wheel"],
      ["Zoom In / Out", "Ctrl + (+ / -)"],
      ["Fit All", "F"],
      ["Fit Selection", "Shift+F or Z"],
      ["Reset Zoom", "Ctrl+0"],
    ],
  },
  {
    title: "Selection",
    items: [
      ["Single", "Click"],
      ["Add / Toggle", "Shift+Click"],
      ["Marquee", "Drag empty space (Shift = additive)"],
      ["Select All / Clear", "Ctrl+A / Esc"],
      ["Delete", "Delete key"],
    ],
  },
  {
    title: "Cards",
    items: [["Move", "Drag"]],
  },
  {
    title: "Groups",
    items: [
      ["Create", "G (around selection) or empty at center"],
      ["Delete", "Delete key"],
    ],
  },
  {
    title: "Search",
    items: [["Open Search", "Ctrl+F or /"]],
  },
  {
    title: "Help & Misc",
    items: [
      ["Help", "Hover the “?” button (top-right)"],
      ["Import / Export", "Ctrl+I"],
      ["Recover View", "Press F if you get lost"],
    ],
  },
];

function buildHelpHTML() {
  return `<div class="help-root">${HELP_SECTIONS.map((sec) => `\n      <section><h2>${sec.title}</h2><ul>${sec.items.map((i) => `<li><b>${i[0]}:</b> <span>${i[1]}</span></li>`).join("")}</ul></section>`).join("")}\n</div>`;
}
import { ensureThemeStyles } from "./theme";
function ensureHelpStyles() {
  if (document.getElementById("help-style")) return;
  const style = document.createElement("style");
  style.id = "help-style";
  style.textContent = `.help-root{font:calc(16px * var(--ui-scale))/1.6 var(--panel-font);padding:4px 0;text-align:left;} .help-root h2{margin:14px 0 6px;color:var(--panel-accent);} .help-root section:first-of-type h2{margin-top:0;} .help-root ul{list-style:none;margin:0;padding:0;} .help-root li{margin:0 0 8px;padding:4px 0;border-bottom:1px solid color-mix(in srgb,var(--panel-fg) 12%, transparent);} .help-root li:last-child{border-bottom:none;} .help-root b{color:var(--panel-fg);font-weight:600;} .help-root span{color:var(--panel-fg-dim);} .help-root section{margin-bottom:10px;} .help-root .tips ul li{border-bottom:none;}
  .ui-help-centered{position:fixed !important; left:50% !important; top:50% !important; right:auto !important; transform:translate(-50%, -50%); max-width:min(90vw, calc(720px * var(--ui-scale))) !important; width:auto !important; z-index:10000 !important;}`;
  document.head.appendChild(style);
}

export function initHelp(): HelpAPI {
  let helpEl: HTMLDivElement | null = null;
  let helpVisible = false;
  const FAB_BAR_ID = "top-fab-bar";
  function ensureFabBar(): HTMLDivElement {
    let bar = document.getElementById(FAB_BAR_ID) as HTMLDivElement | null;
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = FAB_BAR_ID;
    bar.style.cssText =
      "position:fixed;top:calc(16px * var(--ui-scale));right:calc(16px * var(--ui-scale));display:flex;flex-direction:row-reverse;gap:calc(10px * var(--ui-scale));align-items:center;z-index:9999;";
    document.body.appendChild(bar);
    return bar;
  }
  function createHelp() {
    console.log("[help] createHelp invoked");
    ensureThemeStyles();
    ensureHelpStyles();
    helpEl = document.createElement("div");
    helpEl.className = "ui-panel ui-panel-scroll";
    helpEl.style.position = "fixed";
    helpEl.style.top = "calc(12px * var(--ui-scale))";
    helpEl.style.right = "calc(12px * var(--ui-scale))";
    helpEl.style.width = "min(90vw, calc(560px * var(--ui-scale)))";
    helpEl.style.maxHeight = "70vh";
    helpEl.style.zIndex = "9998";
    helpEl.style.border = "2px solid var(--panel-accent)";
    helpEl.innerHTML = buildHelpHTML();
    document.body.appendChild(helpEl);
  }
  function setVisible(v: boolean) {
    if (!helpEl) createHelp();
    helpVisible = v;
    if (helpEl) {
      helpEl.style.setProperty("display", v ? "block" : "none", "important");
      if (v) helpEl.focus?.();
    }
  }
  function setCentered(on: boolean) {
    if (!helpEl) createHelp();
    if (!helpEl) return;
    if (on) helpEl.classList.add("ui-help-centered");
    else helpEl.classList.remove("ui-help-centered");
  }
  function toggle() {
    const now = performance.now();
    const last = (window as any).__lastHelpToggle || 0;
    if (now - last < 120) {
      return;
    } // debounce to prevent double handlers flipping twice
    (window as any).__lastHelpToggle = now;
    setVisible(!helpVisible);
    console.log("[help] toggle -> visible=", helpVisible);
  }
  const show = () => setVisible(true);
  const hide = () => setVisible(false);
  const showCentered = () => {
    setCentered(true);
    setVisible(true);
  };
  function ensureFab() {
    if (document.getElementById("help-fab")) return;
    ensureThemeStyles();
    ensureHelpStyles();
    const bar = ensureFabBar();
    const fab = document.createElement("div");
    fab.id = "help-fab";
    fab.style.cssText =
      "position:relative;width:var(--fab-size);height:var(--fab-size);border-radius:50%;background:var(--fab-bg);color:var(--fab-fg);border:1px solid var(--fab-border);display:flex;align-items:center;justify-content:center;font:calc(28px * var(--ui-scale))/1 var(--panel-font);text-align:center;cursor:help;user-select:none;box-shadow:var(--panel-shadow);";
    fab.textContent = "?";
    fab.title = "Help";
    const panel = document.createElement("div");
    panel.id = "help-fab-panel";
    panel.className = "ui-panel ui-panel-scroll";
    panel.style.position = "absolute";
    panel.style.top = "calc(6px + var(--fab-size))";
    panel.style.right = "0";
    panel.style.width = "min(90vw, calc(560px * var(--ui-scale)))";
    panel.style.maxHeight = "70vh";
    panel.style.display = "none";
    panel.innerHTML = buildHelpHTML();
    fab.appendChild(panel);
    let hover = false;
    let hideTimer: any = null;
    function show() {
      // Notify other FAB panels to close
      window.dispatchEvent(
        new CustomEvent("mtg:fabs:open", { detail: { id: "help" } }),
      );
      panel.style.display = "block";
    }
    function scheduleHide() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!hover) panel.style.display = "none";
      }, 250);
    }
    fab.addEventListener("mouseenter", () => {
      hover = true;
      show();
    });
    fab.addEventListener("mouseleave", () => {
      hover = false;
      scheduleHide();
    });
    panel.addEventListener("mouseenter", () => {
      hover = true;
      show();
    });
    panel.addEventListener("mouseleave", () => {
      hover = false;
      scheduleHide();
    });
    let pinned = false;
    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      pinned = !pinned;
      if (pinned) {
        show();
        panel.style.display = "block";
      } else {
        hover = false;
        scheduleHide();
      }
    });
    // Close help FAB panel when another FAB opens
    window.addEventListener(
      "mtg:fabs:open",
      (ev: any) => {
        if (!ev || ev.detail?.id === "help") return;
        pinned = false;
        hover = false;
        panel.style.display = "none";
      },
      { capture: true },
    );
    bar.appendChild(fab);
  }
  return { toggle, show, hide, showCentered, ensureFab };
}
