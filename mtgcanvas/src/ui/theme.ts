// Central UI theming helpers for floating panels / overlays.
// Provides consistent palette, typography, borders, scrollbar styling.

export interface PanelOptions { width?: string; maxHeight?: string; scroll?: boolean; pointer?: boolean; }

let injected = false;
let currentTheme: 'dark' | 'light' = 'dark';
export function ensureThemeStyles(){
  if (injected) return; injected = true;
  const style = document.createElement('style'); style.id='app-theme-panels';
  style.textContent = `
  :root { --panel-font:'Inter',system-ui,monospace; }
  :root, .theme-dark { --panel-bg:#101b24; --panel-bg-alt:#0d1720e6; --panel-border:#23485a; --panel-radius:10px; --panel-fg:#d5e8f2; --panel-accent:#6fb9ff; --panel-shadow:0 4px 18px -4px rgba(0,0,0,0.65); --panel-fab-bg:#264b66; }
  .theme-light { --panel-bg:#f2f5f7; --panel-bg-alt:#ffffffd9; --panel-border:#b9c7d2; --panel-fg:#1d2a33; --panel-accent:#236fa1; --panel-shadow:0 4px 18px -4px rgba(0,0,0,0.25); --panel-fab-bg:#3478b8; }
  .ui-panel { background:var(--panel-bg-alt); backdrop-filter:blur(6px) saturate(1.2); -webkit-backdrop-filter:blur(6px) saturate(1.2); color:var(--panel-fg); border:1px solid var(--panel-border); border-radius:var(--panel-radius); font:14px/1.55 var(--panel-font); box-shadow:var(--panel-shadow); padding:14px 16px; }
  .ui-panel h1,.ui-panel h2,.ui-panel h3{ font-weight:600; letter-spacing:.55px; text-transform:uppercase; font-size:13px; color:var(--panel-accent); margin:10px 0 6px; }
  .ui-panel small{ opacity:.75; }
  .ui-panel-scroll{ overflow:auto; scrollbar-width:thin; }
  .ui-panel-scroll::-webkit-scrollbar{ width:8px; }
  .ui-panel-scroll::-webkit-scrollbar-track{ background:var(--panel-bg); }
  .ui-panel-scroll::-webkit-scrollbar-thumb{ background:#2f4f62; border-radius:4px; }
  .ui-badge{ display:inline-block; padding:2px 6px; border-radius:6px; font-size:11px; line-height:1.2; background:#1f3340; color:#9fd; margin:0 4px 4px 0; }
  .theme-light .ui-badge{ background:#d8e5ef; color:#255; }
  .perf-grid{ font:13px/1.35 monospace; white-space:pre; }
  .theme-toggle-btn{ position:fixed; bottom:14px; left:14px; width:46px; height:46px; border-radius:50%; background:var(--panel-fab-bg); color:#fff; font:22px/46px var(--panel-font); text-align:center; cursor:pointer; user-select:none; z-index:9999; box-shadow:0 2px 6px rgba(0,0,0,0.35); transition:background .25s; }
  .theme-toggle-btn:hover{ filter:brightness(1.15); }
  `; document.head.appendChild(style);
  // Restore persisted theme
  const stored = localStorage.getItem('appTheme');
  if (stored==='light'||stored==='dark') { setTheme(stored as any); }
  else { document.documentElement.classList.add('theme-dark'); }
}

export function setTheme(t:'dark'|'light'){
  currentTheme = t;
  document.documentElement.classList.remove('theme-dark','theme-light');
  document.body.classList.remove('theme-dark','theme-light');
  document.documentElement.classList.add('theme-'+t);
  document.body.classList.add('theme-'+t);
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('appTheme', t);
}
export function toggleTheme(){ setTheme(currentTheme==='dark'?'light':'dark'); }

// Deprecated FAB toggle (removed by user request). Keeping function as no-op to avoid import errors.
export function ensureThemeToggleButton(){ /* no-op */ }

export function createPanel(opts:PanelOptions = {}): HTMLDivElement {
  ensureThemeStyles();
  const el = document.createElement('div');
  el.className = 'ui-panel'+(opts.scroll? ' ui-panel-scroll':'');
  el.style.position='fixed';
  if (opts.width) el.style.width = opts.width; else el.style.minWidth='260px';
  if (opts.maxHeight) el.style.maxHeight = opts.maxHeight;
  if (!opts.pointer) el.style.pointerEvents='none';
  return el;
}
