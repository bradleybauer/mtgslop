// Central UI theming helpers for floating panels / overlays.
// Provides consistent palette, typography, borders, scrollbar styling.

export interface PanelOptions {
  width?: string;
  maxHeight?: string;
  scroll?: boolean;
  pointer?: boolean;
}

let injected = false;
let currentTheme: "dark" | "light" = "dark";
type ThemeListener = (theme: "dark" | "light") => void;
const listeners: ThemeListener[] = [];
export function registerThemeListener(cb: ThemeListener) {
  if (!listeners.includes(cb)) listeners.push(cb);
}
export function ensureThemeStyles() {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.id = "app-theme-panels";
  style.textContent = `
  :root { --panel-font:'Inter',system-ui,monospace; }
  /* DARK THEME */
  :root, .theme-dark {
    --canvas-bg:#1e1e1e;
    --panel-bg:#101b24;
    --panel-bg-alt:#0d1720e6;
    --panel-border:#23485a;
    --panel-radius:10px;
    --panel-fg:#d5e8f2;
    --panel-fg-dim:#9ab3c1;
    --panel-accent:#6fb9ff;
    --panel-shadow:0 4px 18px -4px rgba(0,0,0,0.65);
  /* Cohesive FAB colors (derived from panel + accent) */
  --fab-bg: color-mix(in srgb, var(--panel-accent) 18%, var(--panel-bg) 82%);
  --fab-fg: var(--panel-fg);
  --fab-border: var(--panel-border);
    --input-bg:#182830; --input-border:#325261; --input-fg:#e8f7ff;
    --btn-bg:#20333d; --btn-border:#2d5366; --btn-fg:#cbe8f5; --btn-bg-hover:#2c4b59;
    --danger-bg:#402529; --danger-border:#5a3137;
    --menu-hover-bg:#1d3440; --menu-divider-bg:#1e323d;
    --pill-bg:#1d2c34; --pill-border:#2f4955; --pill-fg:#c6dde6; --pill-active-outline:#4d90a8;
  }
  /* LIGHT THEME */
  .theme-light {
    --canvas-bg:#f6f7f9;
    --panel-bg:#f2f5f7;
    --panel-bg-alt:#ffffffdd;
    --panel-border:#b9c7d2;
    --panel-fg:#1d2a33;
    --panel-fg-dim:#4a5b65;
    --panel-accent:#236fa1;
    --panel-shadow:0 4px 20px -6px rgba(0,0,0,0.18);
  --fab-bg: color-mix(in srgb, var(--panel-accent) 12%, var(--panel-bg) 88%);
  --fab-fg: var(--panel-fg);
  --fab-border: var(--panel-border);
    --input-bg:#ffffff; --input-border:#b7c5cf; --input-fg:#132028;
    --btn-bg:#e4ecf1; --btn-border:#b7c5cf; --btn-fg:#243640; --btn-bg-hover:#d3e2ea;
    --danger-bg:#f8e1e4; --danger-border:#e3a4ab;
    --menu-hover-bg:#e1ebf1; --menu-divider-bg:#d2dde3;
    --pill-bg:#e3edf3; --pill-border:#b7c5cf; --pill-fg:#243640; --pill-active-outline:#236fa1;
  }
  /* Panels */
  .ui-panel { background:var(--panel-bg-alt); backdrop-filter:blur(6px) saturate(1.2); -webkit-backdrop-filter:blur(6px) saturate(1.2); color:var(--panel-fg); border:1px solid var(--panel-border); border-radius:var(--panel-radius); font:18px/1.7 var(--panel-font); box-shadow:var(--panel-shadow); padding:22px 24px; }
  .ui-panel h1,.ui-panel h2,.ui-panel h3{ font-weight:600; letter-spacing:.6px; text-transform:uppercase; font-size:17px; color:var(--panel-accent); margin:14px 0 10px; }
  .ui-panel small{ opacity:.75; }
  .ui-panel-scroll{ overflow:auto; scrollbar-width:thin; }
  .ui-panel-scroll::-webkit-scrollbar{ width:10px; }
  .ui-panel-scroll::-webkit-scrollbar-track{ background:var(--panel-bg); }
  .ui-panel-scroll::-webkit-scrollbar-thumb{ background:#2f4f62; border-radius:4px; }
  /* Badges */
  .ui-badge{ display:inline-block; padding:4px 10px; border-radius:8px; font-size:13px; line-height:1.3; background:#1f3340; color:#9fd; margin:0 6px 6px 0; }
  .theme-light .ui-badge{ background:#d8e5ef; color:#255; }
  /* Inputs */
  .ui-input{ background:var(--input-bg); border:1px solid var(--input-border); border-radius:10px; padding:12px 14px; font:18px var(--panel-font); color:var(--input-fg); outline:none; box-sizing:border-box; }
  .ui-input-lg{ font-size:32px; padding:16px 18px; }
  .ui-input:focus{ box-shadow:0 0 0 2px color-mix(in srgb, var(--panel-accent) 35%, transparent); }
  /* Buttons */
  .ui-btn, .ui-pill{ background:var(--btn-bg); border:1px solid var(--btn-border); color:var(--btn-fg); font:16px var(--panel-font); border-radius:10px; padding:10px 14px; cursor:pointer; user-select:none; transition:background .15s, color .15s, border-color .15s; }
  .ui-btn:hover{ background:var(--btn-bg-hover); }
  .ui-btn.danger{ background:var(--danger-bg); border-color:var(--danger-border); }
  .ui-pill{ background:var(--pill-bg); border-color:var(--pill-border); color:var(--pill-fg); font-size:16px; border-radius:22px; padding:10px 16px; }
  .ui-pill[data-active='true']{ outline:1px solid var(--pill-active-outline); }
  /* Menu */
  .ui-menu{ background:var(--panel-bg-alt); border:1px solid var(--panel-border); border-radius:10px; font:16px/1.55 var(--panel-font); color:var(--panel-fg); box-shadow:0 6px 20px -6px rgba(0,0,0,0.4); padding:10px 10px 8px; }
  .ui-menu .divider{ height:1px; background:var(--menu-divider-bg); margin:6px 4px; }
  .ui-menu-item{ padding:10px 14px; cursor:pointer; border-radius:8px; }
  .ui-menu-item:hover{ background:var(--menu-hover-bg); }
  .ui-menu-item.disabled{ opacity:.5; cursor:default; }
  /* Perf overlay monospace */
  .perf-grid{ font:15px/1.5 monospace; white-space:pre; }
  .theme-toggle-btn{ position:fixed; bottom:14px; left:14px; width:54px; height:54px; border-radius:50%; background:var(--fab-bg); color:var(--fab-fg); border:1px solid var(--fab-border); font:26px/54px var(--panel-font); text-align:center; cursor:pointer; user-select:none; z-index:9999; box-shadow:var(--panel-shadow); transition:filter .2s, box-shadow .2s, background .2s; }
  .theme-toggle-btn:hover{ filter:brightness(1.06); box-shadow:0 4px 20px -6px rgba(0,0,0,0.35); }
  body{ background:var(--canvas-bg); color:var(--panel-fg); }
  `;
  document.head.appendChild(style);
  // Restore persisted theme
  const stored = localStorage.getItem("appTheme");
  if (stored === "light" || stored === "dark") {
    setTheme(stored as any);
  } else {
    document.documentElement.classList.add("theme-dark");
  }
}

export function setTheme(t: "dark" | "light") {
  currentTheme = t;
  document.documentElement.classList.remove("theme-dark", "theme-light");
  document.body.classList.remove("theme-dark", "theme-light");
  document.documentElement.classList.add("theme-" + t);
  document.body.classList.add("theme-" + t);
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("appTheme", t);
  listeners.forEach((l) => {
    try {
      l(t);
    } catch {}
  });
}
export function toggleTheme() {
  setTheme(currentTheme === "dark" ? "light" : "dark");
}

// Deprecated FAB toggle (removed by user request). Keeping function as no-op to avoid import errors.
export function ensureThemeToggleButton() {
  ensureThemeStyles();
  if (document.getElementById("theme-fab")) return;
  // Reuse the top FAB bar if present; otherwise create it
  let bar = document.getElementById("top-fab-bar") as HTMLDivElement | null;
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "top-fab-bar";
    bar.style.cssText =
      "position:fixed;top:16px;right:16px;display:flex;flex-direction:row-reverse;gap:12px;align-items:center;z-index:9999;";
    document.body.appendChild(bar);
  }
  const fab = document.createElement("div");
  fab.id = "theme-fab";
  fab.title = "Toggle theme";
  fab.setAttribute("role", "button");
  fab.setAttribute("aria-label", "Toggle theme");
  // Style as a circular button that sits inside the top FAB bar
  fab.style.cssText =
    "position:relative;width:56px;height:56px;border-radius:50%;background:var(--fab-bg);color:var(--fab-fg);border:1px solid var(--fab-border);display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;box-shadow:var(--panel-shadow);transition:filter .2s, box-shadow .2s, background .2s;";
  // Make this the leftmost FAB within row-reverse layout by giving it highest order
  (fab.style as any).order = "999";
  fab.onmouseenter = () => (fab.style.filter = "brightness(1.06)");
  fab.onmouseleave = () => (fab.style.filter = "");
  const sunSVG =
    '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false" fill="none" xmlns="http://www.w3.org/2000/svg">\
    <circle cx="12" cy="12" r="5" fill="currentColor"/>\
    <line x1="12" y1="2" x2="12" y2="5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
    <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
    <line x1="2" y1="12" x2="5" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
    <line x1="19" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
    <line x1="4.93" y1="4.93" x2="6.76" y2="6.76" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
    <line x1="17.24" y1="17.24" x2="19.07" y2="19.07" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
    <line x1="4.93" y1="19.07" x2="6.76" y2="17.24" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
    <line x1="17.24" y1="6.76" x2="19.07" y2="4.93" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>\
  </svg>';
  const moonSVG =
    '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" focusable="false" fill="none" xmlns="http://www.w3.org/2000/svg">\
    <circle cx="12" cy="12" r="9" fill="currentColor"/>\
    <circle cx="16" cy="10" r="6.5" fill="var(--fab-bg)"/>\
  </svg>';
  const setIcon = () => {
    // Show an icon matching the current theme
    fab.innerHTML = currentTheme === "dark" ? moonSVG : sunSVG;
    fab.setAttribute(
      "aria-label",
      currentTheme === "dark" ? "Dark theme" : "Light theme",
    );
  };
  setIcon();
  fab.onclick = (e) => {
    e.stopPropagation();
    toggleTheme();
    setIcon();
  };
  // Keep icon in sync if theme changes elsewhere
  registerThemeListener(() => setIcon());
  bar.appendChild(fab);
}

export function createPanel(opts: PanelOptions = {}): HTMLDivElement {
  ensureThemeStyles();
  const el = document.createElement("div");
  el.className = "ui-panel" + (opts.scroll ? " ui-panel-scroll" : "");
  el.style.position = "fixed";
  if (opts.width) el.style.width = opts.width;
  else el.style.minWidth = "260px";
  if (opts.maxHeight) el.style.maxHeight = opts.maxHeight;
  if (!opts.pointer) el.style.pointerEvents = "none";
  return el;
}
