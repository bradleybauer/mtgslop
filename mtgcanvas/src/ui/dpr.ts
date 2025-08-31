// Cross-platform device-pixel-ratio helpers
// - Normalizes Windows fractional scale factors to crisper integer render targets by default
// - Supports user overrides via localStorage

function isWindows(): boolean {
  try {
    const ua = navigator.userAgent || navigator.platform || "";
    return /Windows|Win32|Win64/i.test(ua);
  } catch {
    return false;
  }
}

function readNumber(key: string): number | undefined {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

function readBool(key: string): boolean | undefined {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return undefined;
    return v === "true" || v === "1";
  } catch {
    return undefined;
  }
}

// Returns a platform-tuned DPR to use for the renderer and texture decisions.
// Defaults:
// - Windows: prefer integer DPR (ceil) for crisp sampling (e.g., 1.25/1.5 -> 2)
// - Others: use the native devicePixelRatio
// Overrides:
// - localStorage.forceResolution = number (e.g., 1, 1.5, 2, 3)
// - localStorage.preferIntegerDpr = true/false
export function getEffectiveDpr(): number {
  const forced = readNumber("forceResolution");
  if (forced && isFinite(forced) && forced > 0) return forced;

  const dpr = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
  const preferInt = readBool("preferIntegerDpr");
  const win = isWindows();
  const preferInteger = preferInt !== undefined ? preferInt : win;
  if (!preferInteger) return dpr;
  // Prefer a crisper integer render target. Ceil to avoid rounding down to 1 at 1.25–1.49.
  // Cap to a reasonable upper bound.
  const eff = Math.min(4, Math.ceil(dpr));
  return eff;
}

// Observe DPR changes and call onChange() when it changes meaningfully.
// Returns an unsubscribe function.
export function watchDpr(onChange: () => void): () => void {
  const listeners: Array<{
    mq: MediaQueryList;
    cb: (this: MediaQueryList, ev: MediaQueryListEvent) => any;
  }> = [];
  const dppxMarks = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 4];
  try {
    for (const v of dppxMarks) {
      const mq = matchMedia(`(resolution: ${v}dppx)`);
      const cb = () => onChange();
      // modern addEventListener
      (mq as any).addEventListener?.("change", cb) ||
        (mq as any).addListener?.(cb);
      listeners.push({ mq, cb });
    }
  } catch {
    // Fallback: periodic poll if matchMedia not available
    let last = getEffectiveDpr();
    const id = setInterval(() => {
      const cur = getEffectiveDpr();
      if (cur !== last) {
        last = cur;
        try {
          onChange();
        } catch {}
      }
    }, 750);
    return () => clearInterval(id as any);
  }
  return () => {
    for (const { mq, cb } of listeners) {
      try {
        (mq as any).removeEventListener?.("change", cb) ||
          (mq as any).removeListener?.(cb);
      } catch {}
    }
  };
}
