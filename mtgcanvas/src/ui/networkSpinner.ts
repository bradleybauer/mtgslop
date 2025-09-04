/**
 * Network activity spinner
 * - Patches global fetch to maintain an in-flight counter
 * - Renders a themed chip with a spinner in the top-right FAB bar (or top-right fallback)
 * - Debounced show/hide to avoid flicker for very fast requests
 */
import { ensureThemeStyles } from "./theme";

let installed = false;

export interface SpinnerOptions {
  showDelayMs?: number; // delay before showing once activity starts
  hideDelayMs?: number; // delay before hiding after activity ends
}

export function installNetworkActivitySpinner(opts: SpinnerOptions = {}) {
  if (installed) return;
  installed = true;

  ensureThemeStyles();

  const showDelay = opts.showDelayMs ?? 150;
  const hideDelay = opts.hideDelayMs ?? 200;

  // Inject styles and DOM
  const style = document.createElement("style");
  style.textContent = `
  @keyframes netspin { to { transform: rotate(360deg); } }
  /* FAB look to match the app */
  #net-activity-fab { position: fixed; top: calc(16px * var(--ui-scale)); right: calc(16px * var(--ui-scale)); width: var(--fab-size); height: var(--fab-size); border-radius: 50%; background: var(--fab-bg); color: var(--fab-fg); border: 1px solid var(--fab-border); display: flex; align-items: center; justify-content: center; box-shadow: var(--panel-shadow); z-index: 9999; opacity: 0; transform: translateY(-6px) scale(.95); transition: opacity .15s ease, transform .15s ease, box-shadow .15s ease, filter .15s ease; pointer-events: none; }
  #net-activity-fab.show { opacity: 1; transform: translateY(0) scale(1); filter: none; }
  #net-activity-fab.show:hover { box-shadow: var(--fab-hover-shadow, var(--panel-shadow)); }
  #net-activity-fab .ring { box-sizing: border-box; width: calc(26px * var(--ui-scale)); height: calc(26px * var(--ui-scale)); border: 3px solid color-mix(in srgb, var(--panel-fg) 25%, transparent); border-top-color: var(--panel-accent); border-radius: 50%; animation: netspin .9s linear infinite; filter: drop-shadow(0 0 3px color-mix(in srgb, var(--panel-accent) 45%, transparent)); }
  `;
  document.head.appendChild(style);

  const host = document.createElement("div");
  host.id = "net-activity-fab";
  host.setAttribute("aria-hidden", "true");
  const ring = document.createElement("div");
  ring.className = "ring";
  host.appendChild(ring);
  // Prefer mounting into the top FAB bar to visually group with app controls
  const mountIntoBar = () => {
    const fabBar = document.getElementById("top-fab-bar");
    if (!fabBar) return false;
    // As child of bar, use relative sizing/positioning identical to other FABs
    host.style.position = "relative";
    host.style.top = "auto";
    host.style.right = "auto";
    // Make it the leftmost item in a row-reverse flex bar: give it a high order and append last.
    (host.style as any).order = "9999";
    const bar = fabBar as HTMLElement;
    bar.appendChild(host);
    return true;
  };
  if (!mountIntoBar()) {
    // Fallback: fixed in top-right similar to FAB bar positioning
    document.body.appendChild(host);
    // Observe for bar creation and move into it once available
    const mo = new MutationObserver(() => {
      if (mountIntoBar()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  let inFlight = 0;
  let showTimer: number | null = null;
  let hideTimer: number | null = null;

  const update = () => {
    if (inFlight > 0) {
      // schedule show
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (host.classList.contains("show")) return;
      if (showTimer === null) {
        showTimer = window.setTimeout(() => {
          showTimer = null;
          if (inFlight > 0) host.classList.add("show");
        }, showDelay);
      }
    } else {
      // schedule hide
      if (showTimer !== null) {
        window.clearTimeout(showTimer);
        showTimer = null;
      }
      if (hideTimer === null) {
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          host.classList.remove("show");
        }, hideDelay);
      }
    }
  };

  const inc = () => {
    inFlight++;
    update();
  };
  const dec = () => {
    inFlight = Math.max(0, inFlight - 1);
    update();
  };

  // Patch fetch
  const g: any = globalThis as any;
  const originalFetch: typeof fetch | undefined = g.fetch?.bind(globalThis);
  if (!originalFetch) return; // environment without fetch; nothing to do

  const wrapped: typeof fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    inc();
    try {
      const p = originalFetch(input as any, init);
      // Ensure decrement on settle
      return p.finally(dec);
    } catch (e) {
      dec();
      throw e;
    }
  }) as typeof fetch;

  g.fetch = wrapped;

  // Expose optional manual hooks for non-fetch activity (e.g., websockets)
  g.__netSpinnerInc__ = inc;
  g.__netSpinnerDec__ = dec;
}
