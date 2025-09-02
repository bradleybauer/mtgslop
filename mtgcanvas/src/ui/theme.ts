// Central UI theming helpers for floating panels / overlays.
// Provides consistent palette, typography, borders, scrollbar styling.

export interface PanelOptions {
  width?: string;
  maxHeight?: string;
  scroll?: boolean;
  pointer?: boolean;
}

let injected = false;
export type ThemeId = "dark" | "light" | "blackYellow";
let currentTheme: ThemeId = "dark";
type ThemeListener = (theme: ThemeId) => void;
const listeners: ThemeListener[] = [];
export function registerThemeListener(cb: ThemeListener) {
  if (!listeners.includes(cb)) listeners.push(cb);
}
// Theme palettes and Pixi numeric color helpers live here to avoid a separate colors.ts.
export const ThemePalettes: Record<ThemeId, any> = {
  dark: {
    canvasBg: "#1e1e1e",
    panelBg: "#101b24",
    panelBgAlt: "#0d1720e6",
    panelBorder: "#23485a",
    panelFg: "#d5e8f2",
    panelFgDim: "#9ab3c1",
    panelAccent: "#6fb9ff",
    successAccent: "#5fcba4",
    inputBg: "#182830",
    inputBorder: "#325261",
    inputFg: "#e8f7ff",
    btnBg: "#20333d",
    btnBorder: "#2d5366",
    btnFg: "#cbe8f5",
    btnBgHover: "#2c4b59",
    dangerBg: "#402529",
    dangerBorder: "#5a3137",
    menuHoverBg: "#1d3440",
    menuDividerBg: "#1e323d",
    pillBg: "#1d2c34",
    pillBorder: "#2f4955",
    pillFg: "#c6dde6",
    pillActiveOutline: "#4d90a8",
    scrollbarThumb: "#2f4f62",
    badgeBg: "#1f3340",
    badgeFg: "#99ffdd",
    panelShadow: "0 4px 18px -4px rgba(0,0,0,0.65)",
    fabHoverShadow: "0 4px 20px -6px rgba(0,0,0,0.35)",
  },
  light: {
    canvasBg: "#f6f7f9",
    panelBg: "#f2f5f7",
    panelBgAlt: "#ffffffdd",
    panelBorder: "#b9c7d2",
    panelFg: "#1d2a33",
    panelFgDim: "#4a5b65",
    panelAccent: "#236fa1",
    successAccent: "#2f7f64",
    inputBg: "#ffffff",
    inputBorder: "#b7c5cf",
    inputFg: "#132028",
    btnBg: "#e4ecf1",
    btnBorder: "#b7c5cf",
    btnFg: "#243640",
    btnBgHover: "#d3e2ea",
    dangerBg: "#f8e1e4",
    dangerBorder: "#e3a4ab",
    menuHoverBg: "#e1ebf1",
    menuDividerBg: "#d2dde3",
    pillBg: "#e3edf3",
    pillBorder: "#b7c5cf",
    pillFg: "#243640",
    pillActiveOutline: "#236fa1",
    scrollbarThumb: "#b7c5cf",
    badgeBg: "#d8e5ef",
    badgeFg: "#225555",
    panelShadow: "0 4px 20px -6px rgba(0,0,0,0.18)",
    fabHoverShadow: "0 4px 20px -6px rgba(0,0,0,0.35)",
  },
  blackYellow: {
    // High-contrast black + yellow scheme
    canvasBg: "#0b0b0c",
    panelBg: "#101010",
    panelBgAlt: "#101010e6",
    panelBorder: "#2a2a2a",
    panelFg: "#f5f5f5",
    panelFgDim: "#c8c8c8",
    panelAccent: "#ffd400",
    successAccent: "#9be564",
    inputBg: "#141414",
    inputBorder: "#ffd400",
    inputFg: "#fafafa",
    btnBg: "#121212",
    btnBorder: "#2a2a2a",
    btnFg: "#f2f2f2",
    btnBgHover: "#1a1a1a",
    dangerBg: "#2b1719",
    dangerBorder: "#5a2b31",
    menuHoverBg: "#1a1a1a",
    menuDividerBg: "#242424",
    pillBg: "#141414",
    pillBorder: "#2a2a2a",
    pillFg: "#f0f0f0",
    pillActiveOutline: "#ffd400",
    scrollbarThumb: "#2a2a2a",
    badgeBg: "#171717",
    badgeFg: "#ffd400",
    panelShadow: "0 4px 18px -4px rgba(0,0,0,0.65)",
    fabHoverShadow: "0 4px 20px -6px rgba(0,0,0,0.35)",
  },
};

// UI scaling: allow font and control sizes to adapt across DPI/platforms.
// Backed by CSS var --ui-scale; persistent via localStorage key "uiScale".
let uiScale = 1;
const UI_SCALE_KEY = "uiScale";
const UI_SCALE_MODE_KEY = "uiScaleManual"; // '1' => manual, otherwise auto

export function setUiScale(scale: number) {
  // clamp sane range
  const s = Math.max(0.7, Math.min(1.3, Number(scale) || 1));
  uiScale = s;
  document.documentElement.style.setProperty("--ui-scale", String(s));
  if (typeof localStorage !== "undefined")
    localStorage.setItem(UI_SCALE_KEY, String(s));
}
export function getUiScale(): number {
  return uiScale;
}
export function isUiScaleManual(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(UI_SCALE_MODE_KEY) === "1";
}
// Apply persisted or auto-detected UI scale. Keep small bias to shrink on Windows high-DPI.
function hexToNum(hex: string): number {
  const s = (hex || "").replace("#", "").slice(0, 6);
  const n = parseInt(s, 16);
  return Number.isFinite(n) ? n : 0x000000;
}
function getActiveThemeId(): ThemeId {
  const t = (document.documentElement.getAttribute("data-theme") ||
    currentTheme) as ThemeId;
  return (t in ThemePalettes ? t : "dark") as ThemeId;
}
function isLightTheme(): boolean {
  return getActiveThemeId() === "light";
}
function P() {
  return ThemePalettes[getActiveThemeId()];
}
export const Colors = {
  canvasBg(): number {
    return hexToNum(P().canvasBg);
  },
  panelBg(): number {
    return hexToNum(P().panelBg);
  },
  panelBgAlt(): number {
    return hexToNum(P().panelBg);
  },
  panelBorder(): number {
    return hexToNum(P().panelBorder);
  },
  panelFg(): number {
    return hexToNum(P().panelFg);
  },
  panelFgDim(): number {
    return hexToNum(P().panelFgDim);
  },
  accent(): number {
    return hexToNum(P().panelAccent);
  },
  successAccent(): number {
    return hexToNum(P().successAccent);
  },
  overlayText(): number {
    return isLightTheme() ? this.panelFg() : 0xffffff;
  },
  bannerText(): number {
    return this.accent();
  },
  bannerShadow(): number {
    return 0x000000;
  },
  boundsStroke(): number {
    return isLightTheme() ? 0x8a949e : 0xf4f7fa;
  },
  marqueeFill(): number {
    return this.accent();
  },
  marqueeStroke(): number {
    return this.accent();
  },
  cardPlaceholderFill(): number {
    return 0xffffff;
  },
  cardPlaceholderStroke(): number {
    return 0x000000;
  },
  cardSelectedStroke(): number {
    return this.accent();
  },
  cardSelectedTint(): number {
    const a = this.accent();
    const r = (a >> 16) & 0xff,
      g = (a >> 8) & 0xff,
      b = a & 0xff;
    const mix = (c: number) => Math.min(255, Math.round(c + (255 - c) * 0.5));
    return (mix(r) << 16) | (mix(g) << 8) | mix(b);
  },
  badgeBg(): number {
    return hexToNum(P().badgeBg);
  },
  badgeStroke(): number {
    return this.accent();
  },
  badgeArrows(): number {
    const a = this.accent();
    const r = (a >> 16) & 0xff,
      g = (a >> 8) & 0xff,
      b = a & 0xff;
    const mix = (c: number) => Math.min(255, Math.round(c + (255 - c) * 0.25));
    return (mix(r) << 16) | (mix(g) << 8) | mix(b);
  },
  debugBlue(): number {
    return 0x3355ff;
  },
  debugGreen(): number {
    return 0x33cc66;
  },
  debugRed(): number {
    return 0xff3366;
  },
  cardDefaultTint(): number {
    return 0xffffff;
  },
};
export function ensureThemeStyles() {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.id = "app-theme-panels";
  const d = ThemePalettes.dark;
  const l = ThemePalettes.light;
  const y = ThemePalettes.blackYellow;
  style.textContent = `
  :root { --panel-font:'Inter',system-ui,monospace; --ui-scale: ${uiScale}; --fab-size: calc(56px * var(--ui-scale)); }
  /* DARK THEME */
  :root, .theme-dark {
    --canvas-bg:${d.canvasBg};
    --panel-bg:${d.panelBg};
    --panel-bg-alt:${d.panelBgAlt};
    --panel-border:${d.panelBorder};
    --panel-radius:10px;
    --panel-fg:${d.panelFg};
    --panel-fg-dim:${d.panelFgDim};
    --panel-accent:${d.panelAccent};
  --panel-shadow:${d.panelShadow};
    --success-accent:${d.successAccent};
  /* Cohesive FAB colors (derived from panel + accent) */
  --fab-bg: color-mix(in srgb, var(--panel-accent) 18%, var(--panel-bg) 82%);
  --fab-fg: var(--panel-fg);
  --fab-border: var(--panel-border);
    --input-bg:${d.inputBg}; --input-border:${d.inputBorder}; --input-fg:${d.inputFg};
    --btn-bg:${d.btnBg}; --btn-border:${d.btnBorder}; --btn-fg:${d.btnFg}; --btn-bg-hover:${d.btnBgHover};
    --danger-bg:${d.dangerBg}; --danger-border:${d.dangerBorder};
    --menu-hover-bg:${d.menuHoverBg}; --menu-divider-bg:${d.menuDividerBg};
  --pill-bg:${d.pillBg}; --pill-border:${d.pillBorder}; --pill-fg:${d.pillFg}; --pill-active-outline:${d.pillActiveOutline};
  /* Make set icons light on dark */
  --set-icon-filter: invert(1) brightness(1.1) contrast(1.05);
  }
  /* LIGHT THEME */
  .theme-light {
    --canvas-bg:${l.canvasBg};
    --panel-bg:${l.panelBg};
    --panel-bg-alt:${l.panelBgAlt};
    --panel-border:${l.panelBorder};
    --panel-fg:${l.panelFg};
    --panel-fg-dim:${l.panelFgDim};
    --panel-accent:${l.panelAccent};
  --panel-shadow:${l.panelShadow};
    --success-accent:${l.successAccent};
  --fab-bg: color-mix(in srgb, var(--panel-accent) 12%, var(--panel-bg) 88%);
  --fab-fg: var(--panel-fg);
  --fab-border: var(--panel-border);
    --input-bg:${l.inputBg}; --input-border:${l.inputBorder}; --input-fg:${l.inputFg};
    --btn-bg:${l.btnBg}; --btn-border:${l.btnBorder}; --btn-fg:${l.btnFg}; --btn-bg-hover:${l.btnBgHover};
    --danger-bg:${l.dangerBg}; --danger-border:${l.dangerBorder};
    --menu-hover-bg:${l.menuHoverBg}; --menu-divider-bg:${l.menuDividerBg};
  --pill-bg:${l.pillBg}; --pill-border:${l.pillBorder}; --pill-fg:${l.pillFg}; --pill-active-outline:${l.pillActiveOutline};
  /* Leave set icons unfiltered in light theme */
  --set-icon-filter: none;
  }
  /* BLACK & YELLOW THEME */
  .theme-blackYellow {
    --canvas-bg:${y.canvasBg};
    --panel-bg:${y.panelBg};
    --panel-bg-alt:${y.panelBgAlt};
    --panel-border:${y.panelBorder};
    --panel-fg:${y.panelFg};
    --panel-fg-dim:${y.panelFgDim};
    --panel-accent:${y.panelAccent};
    --panel-shadow:${y.panelShadow};
    --success-accent:${y.successAccent};
  /* Higher-contrast FABs for black/yellow */
  --fab-bg: var(--panel-accent);
  --fab-fg: #000000;
  --fab-border: #806b00;
    --input-bg:${y.inputBg}; --input-border:${y.inputBorder}; --input-fg:${y.inputFg};
    --btn-bg:${y.btnBg}; --btn-border:${y.btnBorder}; --btn-fg:${y.btnFg}; --btn-bg-hover:${y.btnBgHover};
    --danger-bg:${y.dangerBg}; --danger-border:${y.dangerBorder};
    --menu-hover-bg:${y.menuHoverBg}; --menu-divider-bg:${y.menuDividerBg};
  --pill-bg:${y.pillBg}; --pill-border:${y.pillBorder}; --pill-fg:${y.pillFg}; --pill-active-outline:${y.pillActiveOutline};
  /* High-contrast theme: ensure bright set icons */
  --set-icon-filter: invert(1) sepia(0.2) saturate(1.2) brightness(1.15);
  }
  /* Panels */
  .ui-panel { background:var(--panel-bg-alt); backdrop-filter:blur(6px) saturate(1.2); -webkit-backdrop-filter:blur(6px) saturate(1.2); color:var(--panel-fg); border:1px solid var(--panel-border); border-radius:var(--panel-radius); box-shadow:var(--panel-shadow); font-family:var(--panel-font); font-size:calc(15px * var(--ui-scale)); line-height:1.7; padding:calc(20px * var(--ui-scale)) calc(22px * var(--ui-scale)); }
  .ui-panel h1,.ui-panel h2,.ui-panel h3{ font-weight:600; letter-spacing:.6px; text-transform:uppercase; font-size:calc(14px * var(--ui-scale)); color:var(--panel-accent); margin:calc(12px * var(--ui-scale)) 0 calc(8px * var(--ui-scale)); }
  .ui-panel small{ opacity:.75; }
  .ui-panel-scroll{ overflow:auto; scrollbar-width:thin; }
  .ui-panel-scroll::-webkit-scrollbar{ width:calc(10px * var(--ui-scale)); }
  .ui-panel-scroll::-webkit-scrollbar-track{ background:var(--panel-bg); }
  .ui-panel-scroll::-webkit-scrollbar-thumb{ background:${d.scrollbarThumb}; border-radius:calc(4px * var(--ui-scale)); }
  /* Badges */
  .ui-badge{ display:inline-block; padding:calc(4px * var(--ui-scale)) calc(10px * var(--ui-scale)); border-radius:calc(8px * var(--ui-scale)); font-size:calc(12px * var(--ui-scale)); line-height:1.3; background:${d.badgeBg}; color:${d.badgeFg}; margin:0 calc(6px * var(--ui-scale)) calc(6px * var(--ui-scale)) 0; }
  .theme-light .ui-badge{ background:${l.badgeBg}; color:${l.badgeFg}; }
  .theme-blackYellow .ui-badge{ background:${y.badgeBg}; color:${y.badgeFg}; }
  /* Inputs */
  .ui-input{ background:var(--input-bg); border:1px solid var(--input-border); border-radius:calc(10px * var(--ui-scale)); padding:calc(10px * var(--ui-scale)) calc(12px * var(--ui-scale)); font-family:var(--panel-font); font-size:calc(16px * var(--ui-scale)); color:var(--input-fg); outline:none; box-sizing:border-box; }
  .ui-input-lg{ font-size:calc(28px * var(--ui-scale)); padding:calc(14px * var(--ui-scale)) calc(16px * var(--ui-scale)); }
  .ui-input:focus{ box-shadow:0 0 0 2px color-mix(in srgb, var(--panel-accent) 35%, transparent); }
  /* Buttons */
  .ui-btn, .ui-pill{ background:var(--btn-bg); border:1px solid var(--btn-border); color:var(--btn-fg); font-family:var(--panel-font); font-size:calc(14px * var(--ui-scale)); border-radius:calc(10px * var(--ui-scale)); padding:calc(9px * var(--ui-scale)) calc(12px * var(--ui-scale)); cursor:pointer; user-select:none; transition:background .15s, color .15s, border-color .15s; }
  .ui-btn:hover{ background:var(--btn-bg-hover); }
  .ui-btn.danger{ background:var(--danger-bg); border-color:var(--danger-border); }
  .ui-pill{ background:var(--pill-bg); border-color:var(--pill-border); color:var(--pill-fg); font-size:calc(14px * var(--ui-scale)); border-radius:calc(22px * var(--ui-scale)); padding:calc(9px * var(--ui-scale)) calc(14px * var(--ui-scale)); }
  .ui-pill[data-active='true']{ outline:1px solid var(--pill-active-outline); }
  /* Ensure native radios inside pills use theme colors (avoid default blue) */
  .ui-pill input[type='radio']{ accent-color: var(--pill-active-outline); margin-right:calc(6px * var(--ui-scale)); }
  .ui-pill input[type='radio']:focus-visible{ outline:2px solid var(--pill-active-outline); outline-offset:2px; }
  /* Menu */
  .ui-menu{ background:var(--panel-bg-alt); border:1px solid var(--panel-border); border-radius:calc(10px * var(--ui-scale)); font-family:var(--panel-font); font-size:calc(14px * var(--ui-scale)); line-height:1.55; color:var(--panel-fg); box-shadow:0 6px 20px -6px rgba(0,0,0,0.4); padding:calc(9px * var(--ui-scale)) calc(9px * var(--ui-scale)) calc(7px * var(--ui-scale)); }
  .ui-menu .divider{ height:1px; background:var(--menu-divider-bg); margin:calc(6px * var(--ui-scale)) calc(4px * var(--ui-scale)); }
  .ui-menu-item{ padding:calc(10px * var(--ui-scale)) calc(14px * var(--ui-scale)); cursor:pointer; border-radius:calc(8px * var(--ui-scale)); }
  .ui-menu-item:hover{ background:var(--menu-hover-bg); }
  .ui-menu-item.disabled{ opacity:.5; cursor:default; }
  /* Perf overlay monospace */
  .perf-grid{ font-family:monospace; font-size:calc(15px * var(--ui-scale)); line-height:1.5; white-space:pre; }
  .theme-toggle-btn{ position:fixed; bottom:calc(14px * var(--ui-scale)); left:calc(14px * var(--ui-scale)); width:var(--fab-size); height:var(--fab-size); border-radius:50%; background:var(--fab-bg); color:var(--fab-fg); border:1px solid var(--fab-border); font-family:var(--panel-font); font-size:calc(26px * var(--ui-scale)); line-height:var(--fab-size); text-align:center; cursor:pointer; user-select:none; z-index:9999; box-shadow:var(--panel-shadow); transition:filter .2s, box-shadow .2s, background .2s; }
  .theme-toggle-btn:hover{ filter:brightness(1.06); box-shadow:${l.fabHoverShadow}; }
  body{ background:var(--canvas-bg); color:var(--panel-fg); }
  /* Card Info Panel set icon */
  .cip-set-icon{ filter: var(--set-icon-filter); }
  /* App title banner (HTML/CSS replacement for Pixi banner) */
  .title-banner{
    position:fixed;
    top:calc(12px * var(--ui-scale));
    left:calc(16px * var(--ui-scale));
    z-index:10050;
    padding:calc(10px * var(--ui-scale)) calc(14px * var(--ui-scale));
    border-radius:calc(12px * var(--ui-scale));
    background:var(--panel-bg-alt);
    color:var(--panel-accent);
    border:1px solid var(--panel-border);
    font-family:'Inter', system-ui, ui-sans-serif, Segoe UI, Roboto, Helvetica, Arial;
    font-weight:900;
    letter-spacing:1.2px;
    font-size:calc(28px * var(--ui-scale));
    line-height:1.1;
    box-shadow:var(--panel-shadow);
    filter: drop-shadow(1px 2px 1px rgba(0,0,0,0.45));
    user-select:none;
  }
  `;
  document.head.appendChild(style);
  // Restore persisted theme
  const stored = localStorage.getItem("appTheme");
  if (stored === "light" || stored === "dark" || stored === "blackYellow") {
    setTheme(stored as any);
  } else {
    document.documentElement.classList.add("theme-dark");
  }
}

export function setTheme(t: ThemeId) {
  currentTheme = t;
  document.documentElement.classList.remove(
    "theme-dark",
    "theme-light",
    "theme-blackYellow",
  );
  document.body.classList.remove(
    "theme-dark",
    "theme-light",
    "theme-blackYellow",
  );
  document.documentElement.classList.add("theme-" + t);
  document.body.classList.add("theme-" + t);
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("appTheme", t);
  listeners.forEach((l) => {
    l(t);
  });
}
export function toggleTheme() {
  // Cycle through available themes deterministically
  const order: ThemeId[] = ["dark", "light", "blackYellow"];
  const idx = order.indexOf(currentTheme);
  const next = order[(idx + 1) % order.length];
  setTheme(next);
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
      "position:fixed;top:calc(16px * var(--ui-scale));right:calc(16px * var(--ui-scale));display:flex;flex-direction:row-reverse;gap:calc(12px * var(--ui-scale));align-items:center;z-index:9999;";
    document.body.appendChild(bar);
  }
  const fab = document.createElement("div");
  fab.id = "theme-fab";
  fab.title = "Toggle theme";
  fab.setAttribute("role", "button");
  fab.setAttribute("aria-label", "Toggle theme");
  // Style as a circular button that sits inside the top FAB bar
  fab.style.cssText =
    "position:relative;width:var(--fab-size);height:var(--fab-size);border-radius:50%;background:var(--fab-bg);color:var(--fab-fg);border:1px solid var(--fab-border);display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;box-shadow:var(--panel-shadow);transition:filter .2s, box-shadow .2s, background .2s;";
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
    // Show moon for non-light themes (dark, blackYellow), sun for light
    const isLight = currentTheme === "light";
    fab.innerHTML = isLight ? sunSVG : moonSVG;
    fab.setAttribute(
      "aria-label",
      isLight
        ? "Light theme"
        : currentTheme === "blackYellow"
          ? "Black & Yellow theme"
          : "Dark theme",
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
