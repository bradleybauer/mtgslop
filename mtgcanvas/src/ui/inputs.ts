// Utilities for input behavior across the app

/**
 * Disable browser spellcheck/grammar check (and mobile autocorrect/capitalize)
 * for all text inputs, search inputs, textareas, and contenteditable elements.
 * Applies to existing nodes and any nodes added in the future via a MutationObserver.
 */
export function disableSpellAndGrammarGlobally(options?: {
  includeContentEditable?: boolean;
}) {
  const includeCE = options?.includeContentEditable !== false;

  const selectorParts = [
    'input[type="text"]',
    'input[type="search"]',
    "input:not([type])",
    "textarea",
  ];
  if (includeCE)
    selectorParts.push("[contenteditable]", '[contenteditable="true"]');
  const selector = selectorParts.join(",");

  const apply = (el: Element) => {
    if (!(el instanceof HTMLElement)) return;
    const tag = el.tagName;
    const isCE = includeCE && (el as HTMLElement).isContentEditable;
    const isTextInput =
      tag === "TEXTAREA" ||
      (tag === "INPUT" &&
        ((el as HTMLInputElement).type === "text" ||
          (el as HTMLInputElement).type === "search" ||
          !(el as HTMLInputElement).type));
    if (!isTextInput && !isCE) return;

    // Disable spell and grammar check (Chrome/Firefox/Edge honor this on supported elements)
    (el as any).spellcheck = false;
    el.setAttribute("spellcheck", "false");
    // Mobile hints
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocorrect", "off");
    // Some grammar extensions honor this opt-out
    el.setAttribute("data-gramm", "false");
    el.setAttribute("data-gramm_editor", "false");
  };

  const applyAll = (root: ParentNode | Document) => {
    if (!root) return;
    (root as ParentNode).querySelectorAll?.(selector)?.forEach?.(apply);
  };

  // Initial pass
  if (typeof document !== "undefined") {
    applyAll(document);
    // Observe additions
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === "childList") {
          m.addedNodes.forEach((n) => {
            if (n.nodeType === 1) {
              const el = n as Element;
              apply(el);
              // Recurse into subtree
              (el as Element).querySelectorAll?.(selector)?.forEach?.(apply);
            }
          });
        } else if (m.type === "attributes" && (m.target as Element)) {
          const t = m.target as Element;
          if (t.matches && t.matches(selector)) apply(t);
        }
      }
    });
    obs.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: includeCE ? ["contenteditable"] : undefined,
    });
  }
}
