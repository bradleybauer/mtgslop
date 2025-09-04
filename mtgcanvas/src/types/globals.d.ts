import type { CardSprite, ViewRect } from "../scene/cardNode";

declare global {
  interface Window {
    /** Returns the maximum zIndex among all non-HUD content (cards, groups). */
    __mtgMaxContentZ?: () => number;
    /** Returns all live card sprites in the scene. Must return an array (possibly empty). */
    __mtgGetSprites?: () => CardSprite[];
    /** Screen-space pan speed in px/s used to bias texture loading. */
    __lastPanSpeed?: number;
    /** Current world-space view rectangle used for culling/prefetch. */
    __mtgView?: ViewRect;
  }
}

export {};
