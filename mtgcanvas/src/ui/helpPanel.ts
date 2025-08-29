export interface HelpAPI {
  toggle(): void;
  ensureFab(): void;
}

const HELP_SECTIONS = [
  {
    title: "Navigation",
    items: [
      ["Pan", "Space + Drag / Middle Mouse Drag"],
      ["Zoom", "Wheel (cursor focus)"],
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
    ],
  },
  {
    title: "Cards",
    items: [
      ["Move", "Drag"],
      ["Nudge", "Arrow Keys (Shift = 5×)"],
    ],
  },
  {
    title: "Groups",
    items: [
      ["Create", "G (around selection) or empty at center"],
      ["Move", "Drag header"],
      ["Resize", "Drag bottom-right handle"],
      ["Rename", "Double-click header or F2"],
      ["Delete", "Del (cards or groups)"],
      ["Layout", "Grid auto-layout"],
    ],
  },
  {
    title: "Help & Misc",
    items: [
      ["Toggle Help", "H or ?"],
      ["Import / Export", "Ctrl+I"],
      ["Help FAB", "Hover / click “?” bottom-right"],
      ["Recover View", "Press F if you get lost"],
    ],
  },
];

function buildHelpHTML() {
  return `<div class="help-root">${HELP_SECTIONS.map((sec) => `\n      <section><h2>${sec.title}</h2><ul>${sec.items.map((i) => `<li><b>${i[0]}:</b> <span>${i[1]}</span></li>`).join("")}</ul></section>`).join("")}\n      <section class="tips"><h2>Tips</h2><ul><li>Alt disables snapping temporarily.</li><li>Shift while marquee adds to selection.</li><li>Use Fit Selection (Z) to zoom to current work.</li></ul></section>\n    </div>`;
}
import { ensureThemeStyles } from "./theme";
function ensureHelpStyles() {
  if (document.getElementById("help-style")) return;
  const style = document.createElement("style");
  style.id = "help-style";
  style.textContent = `.help-root{font:14px/1.55 var(--panel-font);padding:2px 0;} .help-root h2{margin:12px 0 4px;color:var(--panel-accent);} .help-root section:first-of-type h2{margin-top:0;} .help-root ul{list-style:none;margin:0;padding:0;} .help-root li{margin:0 0 6px;padding:3px 0;border-bottom:1px solid color-mix(in srgb,var(--panel-fg) 12%, transparent);} .help-root li:last-child{border-bottom:none;} .help-root b{color:var(--panel-fg);font-weight:600;} .help-root span{color:var(--panel-fg-dim);} .help-root section{margin-bottom:8px;} .help-root .tips ul li{border-bottom:none;}`;
  document.head.appendChild(style);
}

export function initHelp(): HelpAPI {
  let helpEl: HTMLDivElement | null = null;
  let helpVisible = false;
  function createHelp() {
    console.log("[help] createHelp invoked");
    ensureThemeStyles();
    ensureHelpStyles();
    helpEl = document.createElement("div");
    helpEl.className = "ui-panel ui-panel-scroll";
    helpEl.style.position = "fixed";
    helpEl.style.top = "10px";
    helpEl.style.right = "10px";
    helpEl.style.width = "480px";
    helpEl.style.maxHeight = "70vh";
    helpEl.style.zIndex = "9998";
    helpEl.style.border = "2px solid var(--panel-accent)";
    helpEl.innerHTML = buildHelpHTML();
    document.body.appendChild(helpEl);
  }
  function toggle() {
    const now = performance.now();
    const last = (window as any).__lastHelpToggle || 0;
    if (now - last < 120) {
      return;
    } // debounce to prevent double handlers flipping twice
    (window as any).__lastHelpToggle = now;
    if (!helpEl) createHelp();
    helpVisible = !helpVisible;
    if (helpEl) {
      helpEl.style.setProperty(
        "display",
        helpVisible ? "block" : "none",
        "important",
      );
      if (helpVisible) {
        helpEl.focus?.();
      }
      console.log("[help] toggle -> visible=", helpVisible);
    }
  }
  function ensureFab() {
    if (document.getElementById("help-fab")) return;
    ensureThemeStyles();
    ensureHelpStyles();
    const fab = document.createElement("div");
    fab.id = "help-fab";
    fab.style.cssText =
      "position:fixed;bottom:14px;right:14px;width:48px;height:48px;border-radius:50%;background:var(--panel-fab-bg);color:#fff;font:26px/48px var(--panel-font);text-align:center;cursor:help;user-select:none;z-index:9999;box-shadow:0 2px 6px rgba(0,0,0,0.4);";
    fab.textContent = "?";
    fab.title = "Help";
    const panel = document.createElement("div");
    panel.id = "help-fab-panel";
    panel.className = "ui-panel ui-panel-scroll";
    panel.style.position = "absolute";
    panel.style.bottom = "54px";
    panel.style.right = "0";
    panel.style.width = "480px";
    panel.style.maxHeight = "60vh";
    panel.style.display = "none";
    panel.innerHTML = buildHelpHTML();
    fab.appendChild(panel);
    let hover = false;
    let hideTimer: any = null;
    function show() {
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
    document.body.appendChild(fab);
  }
  return { toggle, ensureFab };
}
