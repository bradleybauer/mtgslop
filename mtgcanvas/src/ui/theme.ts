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
    --panel-fab-bg:#264b66;
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
    --panel-fab-bg:#3478b8;
    --input-bg:#ffffff; --input-border:#b7c5cf; --input-fg:#132028;
    --btn-bg:#e4ecf1; --btn-border:#b7c5cf; --btn-fg:#243640; --btn-bg-hover:#d3e2ea;
    --danger-bg:#f8e1e4; --danger-border:#e3a4ab;
    --menu-hover-bg:#e1ebf1; --menu-divider-bg:#d2dde3;
    --pill-bg:#e3edf3; --pill-border:#b7c5cf; --pill-fg:#243640; --pill-active-outline:#236fa1;
  }
  /* Panels */
  .ui-panel { background:var(--panel-bg-alt); backdrop-filter:blur(6px) saturate(1.2); -webkit-backdrop-filter:blur(6px) saturate(1.2); color:var(--panel-fg); border:1px solid var(--panel-border); border-radius:var(--panel-radius); font:14px/1.55 var(--panel-font); box-shadow:var(--panel-shadow); padding:14px 16px; }
  .ui-panel h1,.ui-panel h2,.ui-panel h3{ font-weight:600; letter-spacing:.55px; text-transform:uppercase; font-size:13px; color:var(--panel-accent); margin:10px 0 6px; }
  .ui-panel small{ opacity:.75; }
  .ui-panel-scroll{ overflow:auto; scrollbar-width:thin; }
  .ui-panel-scroll::-webkit-scrollbar{ width:8px; }
  .ui-panel-scroll::-webkit-scrollbar-track{ background:var(--panel-bg); }
  .ui-panel-scroll::-webkit-scrollbar-thumb{ background:#2f4f62; border-radius:4px; }
  /* Badges */
  .ui-badge{ display:inline-block; padding:2px 6px; border-radius:6px; font-size:11px; line-height:1.2; background:#1f3340; color:#9fd; margin:0 4px 4px 0; }
  .theme-light .ui-badge{ background:#d8e5ef; color:#255; }
  /* Inputs */
  .ui-input{ background:var(--input-bg); border:1px solid var(--input-border); border-radius:6px; padding:8px 10px; font:14px var(--panel-font); color:var(--input-fg); outline:none; box-sizing:border-box; }
  .ui-input-lg{ font-size:24px; padding:12px 14px; }
  .ui-input:focus{ box-shadow:0 0 0 2px color-mix(in srgb, var(--panel-accent) 35%, transparent); }
  /* Buttons */
  .ui-btn, .ui-pill{ background:var(--btn-bg); border:1px solid var(--btn-border); color:var(--btn-fg); font:13px var(--panel-font); border-radius:6px; padding:6px 10px; cursor:pointer; user-select:none; transition:background .15s, color .15s, border-color .15s; }
  .ui-btn:hover{ background:var(--btn-bg-hover); }
  .ui-btn.danger{ background:var(--danger-bg); border-color:var(--danger-border); }
  .ui-pill{ background:var(--pill-bg); border-color:var(--pill-border); color:var(--pill-fg); font-size:13px; border-radius:18px; padding:6px 12px; }
  .ui-pill[data-active='true']{ outline:1px solid var(--pill-active-outline); }
  /* Menu */
  .ui-menu{ background:var(--panel-bg-alt); border:1px solid var(--panel-border); border-radius:6px; font:13px/1.45 var(--panel-font); color:var(--panel-fg); box-shadow:0 4px 18px -4px rgba(0,0,0,0.4); padding:6px 6px 4px; }
  .ui-menu .divider{ height:1px; background:var(--menu-divider-bg); margin:6px 4px; }
  .ui-menu-item{ padding:6px 10px; cursor:pointer; border-radius:4px; }
  .ui-menu-item:hover{ background:var(--menu-hover-bg); }
  .ui-menu-item.disabled{ opacity:.5; cursor:default; }
  /* Perf overlay monospace */
  .perf-grid{ font:13px/1.35 monospace; white-space:pre; }
  .theme-toggle-btn{ position:fixed; bottom:14px; left:14px; width:46px; height:46px; border-radius:50%; background:var(--panel-fab-bg); color:#fff; font:22px/46px var(--panel-font); text-align:center; cursor:pointer; user-select:none; z-index:9999; box-shadow:0 2px 6px rgba(0,0,0,0.35); transition:background .25s; }
  .theme-toggle-btn:hover{ filter:brightness(1.15); }
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
  if (document.getElementById("theme-toggle-btn")) return;
  const btn = document.createElement("button");
  btn.id = "theme-toggle-btn";
  // Flat, modern small pill toggle bottom-left
  btn.className = "ui-btn";
  btn.style.position = "fixed";
  btn.style.bottom = "12px";
  btn.style.left = "12px";
  btn.style.zIndex = "10040";
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.gap = "6px";
  btn.style.fontSize = "12px";
  btn.style.padding = "6px 10px";
  btn.style.borderRadius = "18px";
  btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.25)";
  btn.style.backdropFilter = "blur(6px)";
  // vendor prefix via setProperty to satisfy TS
  btn.style.setProperty("-webkit-backdrop-filter", "blur(6px)");
  const sun = "☀️";
  const moon = "🌙";
  function updateLabel() {
    btn.textContent =
      currentTheme === "dark" ? sun + " Day" : " " + moon + " Night";
  }
  updateLabel();
  btn.title = "Toggle day/night (theme)";
  btn.onclick = () => {
    toggleTheme();
    updateLabel();
  };
  document.body.appendChild(btn);
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
