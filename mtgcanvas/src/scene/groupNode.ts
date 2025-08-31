// Completely redesigned group ("node") visuals to mimic ComfyUI-style nodes:
// - Flat modern rectangles with a colored header bar
// - Consistent 1px border, subtle body background
// - No runtime animations / easing; instant state changes
// - Simple resize handle triangle (bottom-right) when expanded
// - Clear separation of layout logic from visual drawing
// - Minimal mutable surface area

import * as PIXI from "pixi.js";
import { SelectionStore } from "../state/selectionStore";
import { Colors } from "../ui/theme";
import type { CardSprite } from "./cardNode";

// Public shape used elsewhere. Keep name for integration, but surface is simplified.
export interface GroupVisual {
  id: number;
  gfx: PIXI.Container; // root container positioned in world space
  frame: PIXI.Graphics; // body/background
  header: PIXI.Graphics; // header bar (colored)
  label: PIXI.Text; // name text
  count: PIXI.Text; // item count (right aligned)
  price: PIXI.Text; // total price text (rightmost)
  resize: PIXI.Graphics; // resize affordance (triangle)
  name: string;
  w: number;
  h: number;
  collapsed: boolean;
  _expandedH: number; // remembers height when collapsed
  items: Set<number>; // member card ids
  order: number[]; // ordering for layout
  _lastTextRes?: number; // internal: last applied resolution for dynamic crispness
  totalPrice: number; // cached aggregate price
  _zoomLabel?: PIXI.Text; // large centered label when zoomed far out
  _lastZoomPhase?: number; // memo of last applied phase (0..1)
  _overlayDrag?: PIXI.Graphics; // transparent drag surface when overlay visible
}

// Styling constants (tuned to approximate ComfyUI aesthetic while remaining generic)
// Slightly larger header for improved readability and to better host inline controls.
export const HEADER_HEIGHT = 50;
const BODY_RADIUS = 6;
// Colors are derived from CSS via the centralized Colors helper.
// Sample on theme changes to avoid per-frame cost.
let BORDER_COLOR = Colors.panelBorder();
let BORDER_COLOR_SELECTED = Colors.accent();
let BODY_BG = Colors.panelBg(); // flat body background
let BODY_BG_COLLAPSED = Colors.panelBgAlt();
let HEADER_TEXT_COLOR = Colors.panelFg();
let COUNT_TEXT_COLOR = Colors.panelFgDim();
let PRICE_TEXT_COLOR = Colors.panelFg();
let OVERLAY_TEXT_COLOR = Colors.overlayText(); // zoom overlay text color (theme-aware)
// Shared presentation constants
export const GROUP_DIM_ALPHA = 0.4; // frame/header opacity in normal view
// Outline thickness
const BORDER_WIDTH = 10;
const BORDER_WIDTH_SELECTED = 10;
export function applyGroupTheme() {
  // Map CSS vars to internal palette via Colors helper.
  BORDER_COLOR = Colors.panelBorder();
  BORDER_COLOR_SELECTED = Colors.accent();
  BODY_BG = Colors.panelBg();
  BODY_BG_COLLAPSED = Colors.panelBgAlt();
  HEADER_TEXT_COLOR = Colors.panelFg();
  COUNT_TEXT_COLOR = Colors.panelFgDim();
  PRICE_TEXT_COLOR = HEADER_TEXT_COLOR;
  // Overlay text: theme-aware via centralized helper
  OVERLAY_TEXT_COLOR = Colors.overlayText();
}
// Initial sample (safe if executed before DOM ready; will be resampled on first theme ensure anyway)
try {
  applyGroupTheme();
} catch {}
import { registerThemeListener } from "../ui/theme";
registerThemeListener(() => applyGroupTheme());
const FONT_FAMILY = "Inter, system-ui, sans-serif";
// Vertical placement is computed per text based on its font size for precise centering.

// Layout constants for cards inside a group
const GRID_SIZE = 8; // match reduced global grid for consistent snapping when resizing groups
const CARD_W = 100;
const CARD_H = 140;
// Choose PAD_X so that (innerW + 2*PAD_X) is divisible by GRID_SIZE for any column count.
// With CARD_W=100 and GAP_X=4, innerW = 104*c - 4; picking PAD_X=18 makes innerW + 2*PAD_X = 104*c + 32, a multiple of 8.
const PAD_X = 18; // inner left/right (slightly increased to ensure visible right padding)
// Choose a top padding that, when added to HEADER_HEIGHT (50), lands on the 8px grid: 50 + 6 = 56.
// This prevents snap() from inflating the gap and keeps cards snug under the title bar.
const PAD_Y = 6; // inner top below header
// Bottom inner padding: keep visual gap symmetric to top by default.
// With PAD_Y=6 and innerH = 144*r - 4, choosing PAD_BOTTOM_EXTRA=6 keeps sizes aligned to the 8px grid
// while avoiding an oversized bottom gutter.
const PAD_BOTTOM_EXTRA = 6; // extra bottom padding so cards don't touch frame
// Choose gaps that keep (CARD + GAP) divisible by GRID_SIZE so snap() preserves spacing.
// 100 + 4 = 104, 140 + 4 = 144, both divisible by 8. Visually ≈8px at common zooms.
const GAP_X = 4;
const GAP_Y = 4;
function snap(v: number) {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

// No per-group color; colors come from theme variables for consistency.

export function createGroupVisual(
  id: number,
  x: number,
  y: number,
  w = 320,
  h = 280,
): GroupVisual {
  const gfx = new PIXI.Container();
  gfx.sortableChildren = true;
  gfx.x = x;
  gfx.y = y;
  gfx.eventMode = "static";
  gfx.cursor = "default";
  // Enable Pixi built-in culling for the group container itself.
  // Note: member cards are top-level siblings (not children) so their visibility is controlled elsewhere.
  try {
    (gfx as any).cullable = true;
    (gfx as any).cullArea = new PIXI.Rectangle(0, 0, w, h);
  } catch {}
  // Render groups beneath their member cards; cards will be assigned zIndex >= (group zIndex + 1)
  gfx.zIndex = 40; // elevated but still below dynamically raised dragging cards
  const frame = new PIXI.Graphics();
  frame.eventMode = "static";
  frame.cursor = "default";
  (frame as any).__groupBody = true;
  frame.zIndex = 0;
  const header = new PIXI.Graphics();
  header.eventMode = "static";
  header.cursor = "move";
  (header as any).__groupHeader = true;
  header.zIndex = 1;
  const label = new PIXI.Text({
    text: `Group ${id}`,
    style: {
      fill: HEADER_TEXT_COLOR,
      fontSize: 13,
      fontFamily: FONT_FAMILY,
      fontWeight: "500",
      lineHeight: 13,
    },
  });
  // Let header receive pointer events even when hovering text
  (label as any).eventMode = "none";
  label.zIndex = 2;
  const count = new PIXI.Text({
    text: "0",
    style: {
      fill: COUNT_TEXT_COLOR,
      fontSize: 12,
      fontFamily: FONT_FAMILY,
      lineHeight: 12,
    },
  });
  (count as any).eventMode = "none";
  count.zIndex = 2;
  const price = new PIXI.Text({
    text: "$0.00",
    style: {
      fill: PRICE_TEXT_COLOR,
      fontSize: 12,
      fontFamily: FONT_FAMILY,
      fontWeight: "500",
      lineHeight: 12,
    },
  });
  (price as any).eventMode = "none";
  price.zIndex = 2;
  const resize = new PIXI.Graphics();
  resize.eventMode = "static";
  resize.cursor = "nwse-resize";
  resize.zIndex = 3;
  const gv: GroupVisual = {
    id,
    gfx,
    frame,
    header,
    label,
    count,
    price,
    resize,
    name: `Group ${id}`,
    w,
    h,
    collapsed: false,
    _expandedH: h,
    items: new Set(),
    order: [],
    totalPrice: 0,
  };
  // Zoom-out overlay label (initially hidden)
  const zoomLabel = new PIXI.Text({
    text: gv.name,
    style: {
      fill: OVERLAY_TEXT_COLOR,
      fontSize: 96,
      fontFamily: FONT_FAMILY,
      fontWeight: "600",
      align: "center",
      lineHeight: 100,
    },
  });
  zoomLabel.visible = false;
  zoomLabel.alpha = 0; // start hidden
  zoomLabel.zIndex = 4;
  gv._zoomLabel = zoomLabel;
  // Dedicated transparent drag surface placed below text
  const overlayDrag = new PIXI.Graphics();
  overlayDrag.visible = false;
  overlayDrag.alpha = 0;
  (overlayDrag as any).eventMode = "none";
  overlayDrag.zIndex = 5;
  gv._overlayDrag = overlayDrag;
  gfx.addChild(
    frame,
    header,
    label,
    count,
    price,
    resize,
    overlayDrag,
    zoomLabel,
  );
  // Ensure default (non-overlay) alphas are applied at creation
  gfx.alpha = 1;
  frame.alpha = GROUP_DIM_ALPHA;
  header.alpha = GROUP_DIM_ALPHA;
  label.alpha = 1;
  count.alpha = 1;
  price.alpha = 1;
  drawGroup(gv, false);
  return gv;
}

// Core renderer for group visuals.
export function drawGroup(gv: GroupVisual, selected: boolean) {
  const { frame, header, label, count, resize, w, h, collapsed } = gv;
  frame.clear();
  header.clear();
  resize.clear();
  const borderColor = selected ? BORDER_COLOR_SELECTED : BORDER_COLOR;
  const bw = selected ? BORDER_WIDTH_SELECTED : BORDER_WIDTH;

  // Ensure header texts reflect current theme on every draw
  try {
    (label.style as any).fill = HEADER_TEXT_COLOR;
    (count.style as any).fill = COUNT_TEXT_COLOR;
  } catch {}
  // Keep default header text fully opaque unless overlay presentation dims them later
  label.alpha = 1;
  count.alpha = 1;
  // Unify title bar font sizes (label, count, price) to a comfortable size
  const innerHeaderH = Math.max(0, HEADER_HEIGHT - bw);
  const desiredCommonBase = 18; // previous comfortable size
  const desiredScaled = Math.round(desiredCommonBase * 1.5); // increase by 1.5x
  const commonSize = Math.max(12, Math.min(desiredScaled, innerHeaderH - 6));
  try {
    (label.style as any).fontSize = commonSize;
    (label.style as any).fontWeight = "500";
    (label.style as any).lineHeight = commonSize;
    (count.style as any).fontSize = commonSize;
    (count.style as any).fontWeight = "500";
    (count.style as any).lineHeight = commonSize;
  } catch {}

  // Body (hide card area when collapsed)
  const bodyH = collapsed ? HEADER_HEIGHT : h;
  // Draw outer border ring as a filled rounded rect (avoids stroke joint artifacts)
  frame.roundRect(0, 0, w, bodyH, BODY_RADIUS).fill({ color: borderColor });
  // Draw inner body fill inset by border width.
  // Important: do NOT draw it under the header region, so the header color sits over the same background as the border ring.
  const innerW = Math.max(0, w - bw * 2);
  const innerH = Math.max(0, bodyH - bw * 2);
  const hh = Math.max(0, HEADER_HEIGHT - bw);
  if (innerW > 0 && innerH > 0) {
    // Always leave header area unfilled so it shows the border ring color
    const startY = bw + hh;
    const fillH = innerH - hh;
    if (fillH > 0) {
      // Use simple rect for body under header; rounded corners still apply at bottom via BODY_RADIUS-bw
      frame.rect(bw, startY, innerW, fillH).fill({
        color: collapsed ? BODY_BG_COLLAPSED : BODY_BG,
      });
    }
  }

  header.hitArea = new PIXI.Rectangle(0, 0, w, HEADER_HEIGHT);

  // Label text (truncate if needed)
  label.text = gv.name + (collapsed ? " ▸" : "");
  // Keep header text away from thick borders
  label.x = bw + 8;
  truncateLabelIfNeeded(gv);
  // y set later with common baseline

  // Price & count text (always show) - price rightmost, count just left of it
  const price = gv.price;
  try {
    (price.style as any).fontSize = commonSize;
    (price.style as any).fontWeight = "500";
    (price.style as any).lineHeight = commonSize;
  } catch {}
  price.text = `$${gv.totalPrice.toFixed(2)}`;
  price.x = w - bw - price.width - 8;
  // y set later with common baseline
  // Update price style and opacity after price is in scope
  try {
    (price.style as any).fill = PRICE_TEXT_COLOR;
  } catch {}
  price.alpha = 1;
  count.text = gv.items.size.toString();
  count.x = Math.max(bw + 8, price.x - count.width - 6);
  // y set later with common baseline

  // Align all header texts to the same vertical baseline with a slight upward optical lift
  const headerTop = bw; // inner top after border thickness
  const baseCenter = Math.round(headerTop + (innerHeaderH - commonSize) / 2);
  const baselineLift = Math.max(2, Math.round(commonSize * 0.34)); // ~18% of size, lifted more
  const yCommon = baseCenter - baselineLift;
  label.y = yCommon;
  price.y = yCommon;
  count.y = yCommon;

  // Legacy resize triangle removed (edge/corner resize active everywhere). Keep graphic hidden & non-interactive.
  resize.visible = false;
  resize.eventMode = "none";
  resize.hitArea = null as any;
  // Keep the group container's culling bounds in sync with current size/state
  try {
    const gAny: any = gv.gfx as any;
    gAny.cullable = true;
    // When collapsed, only the header is visible and should participate in culling.
    const cullH = collapsed ? HEADER_HEIGHT : h;
    const ca = gAny.cullArea as PIXI.Rectangle | undefined;
    if (ca) {
      ca.x = 0;
      ca.y = 0;
      ca.width = w;
      ca.height = cullH;
    } else {
      gAny.cullArea = new PIXI.Rectangle(0, 0, w, cullH);
    }
  } catch {}
  // If overlay could be visible, mark for reflow next tick.
  if (gv._zoomLabel && gv._zoomLabel.visible) positionZoomOverlay(gv);
}

function truncateLabelIfNeeded(gv: GroupVisual) {
  // Simple ellipsis if label + count overlap
  // Reserve space for count + price on right
  const maxLabelWidth = gv.w - 16 - (gv.count.width + 6 + gv.price.width) - 10; // padding and gap
  if (gv.label.width <= maxLabelWidth) return;
  const original = gv.name + (gv.collapsed ? " ▸" : "");
  let txt = original;
  while (txt.length > 3 && gv.label.width > maxLabelWidth) {
    txt = txt.slice(0, -1);
    gv.label.text = txt + "…";
  }
}

// Layout cards into a grid inside group body.
// Note: For freeform-in-group behavior
// Regardless of strategy, card positions are always snapped to the global grid.
export function layoutGroup(
  gv: GroupVisual,
  sprites: CardSprite[],
  onMoved?: (s: CardSprite) => void,
) {
  if (gv.collapsed) return;
  const items = fastLookupSprites(gv.order, sprites);
  if (!items.length) return;
  const usableW = Math.max(1, gv.w - PAD_X * 2);
  const cols = Math.max(1, Math.floor((usableW + GAP_X) / (CARD_W + GAP_X)));
  items.forEach((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const tx = gv.gfx.x + PAD_X + col * (CARD_W + GAP_X);
    const ty = gv.gfx.y + HEADER_HEIGHT + PAD_Y + row * (CARD_H + GAP_Y);
    // Always snap to global grid so cards align inside and outside groups.
    const nx = snap(tx);
    const ny = snap(ty);
    if (s.x !== nx || s.y !== ny) {
      s.x = nx;
      s.y = ny;
      onMoved && onMoved(s);
    }
    // Ensure grouped cards render above group frame/background.
    const desiredZ = gv.gfx.zIndex + 1;
    if (s.zIndex < desiredZ) {
      s.zIndex = desiredZ;
      (s as any).__baseZ = desiredZ;
    }
  });
  const rows = Math.ceil(items.length / cols);
  const neededH =
    HEADER_HEIGHT +
    PAD_Y +
    rows * CARD_H +
    (rows - 1) * GAP_Y +
    PAD_Y +
    PAD_BOTTOM_EXTRA;
  if (neededH > gv.h) {
    gv.h = snap(neededH);
    gv._expandedH = gv.h;
  }
  drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
  // Maintain overlay position after layout growth when overlay is currently visible
  if (gv._zoomLabel && gv._zoomLabel.visible) positionZoomOverlay(gv);
}

// ---- Freeform helpers (no grid) ----
function rectsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  gapX: number,
  gapY: number,
) {
  return !(
    ax + aw + gapX <= bx ||
    bx + bw + gapX <= ax ||
    ay + ah + gapY <= by ||
    by + bh + gapY <= ay
  );
}

function overlapArea(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): number {
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

function memberSprites(
  gv: GroupVisual,
  sprites: CardSprite[],
  excludeId?: number,
): CardSprite[] {
  const list = fastLookupSprites(gv.order, sprites);
  return excludeId == null ? list : list.filter((s) => s.__id !== excludeId);
}

// Ensure all member sprites render above the group's own graphics (frame/header/overlay).
// Useful after restoring membership from persistence where zIndex wasn't adjusted by layout.
export function ensureMembersZOrder(gv: GroupVisual, sprites: CardSprite[]) {
  const desired = (gv.gfx.zIndex ?? 0) + 1;
  const idMap = getIdMapFast(sprites);
  for (const id of gv.items) {
    const s = idMap.get(id);
    if (!s) continue;
    if (s.zIndex < desired) {
      s.zIndex = desired;
      (s as any).__baseZ = desired;
    }
  }
}

// Place a specific card inside the group at the first available slot near a preferred point.
// If no space is available, grow the group's height to make room and place at the new bottom row.
export function placeCardInGroup(
  gv: GroupVisual,
  sprite: CardSprite,
  sprites: CardSprite[],
  onMoved?: (s: CardSprite) => void,
  preferredWorldX?: number,
  preferredWorldY?: number,
) {
  const others = memberSprites(gv, sprites, sprite.__id);
  // Compute inner bounds
  const left = snap(gv.gfx.x + PAD_X);
  const top = snap(gv.gfx.y + HEADER_HEIGHT + PAD_Y);
  const right = gv.gfx.x + gv.w - PAD_X;
  const bottom = gv.gfx.y + gv.h - PAD_Y - PAD_BOTTOM_EXTRA;
  const step = GRID_SIZE; // search on grid-aligned steps
  // Start search near preferred point if provided, else top-left
  const startX = snap(
    Math.min(
      Math.max(preferredWorldX ?? left, left),
      Math.max(left, right - CARD_W),
    ),
  );
  const startY = snap(
    Math.min(
      Math.max(preferredWorldY ?? top, top),
      Math.max(top, bottom - CARD_H),
    ),
  );

  function fitsAt(x: number, y: number) {
    for (const o of others) {
      if (
        rectsOverlap(
          x,
          y,
          CARD_W,
          CARD_H,
          o.x,
          o.y,
          CARD_W,
          CARD_H,
          GAP_X,
          GAP_Y,
        )
      )
        return false;
    }
    return true;
  }

  // Spiral-ish expanding search from preferred point
  const maxRadius = Math.max(gv.w, gv.h);
  let placed = false;
  let px = startX,
    py = startY;
  outer: for (let radius = 0; radius <= maxRadius; radius += CARD_W / 2) {
    for (let dy = -radius; dy <= radius; dy += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        const tx = snap(Math.min(Math.max(startX + dx, left), right - CARD_W));
        const ty = snap(Math.min(Math.max(startY + dy, top), bottom - CARD_H));
        if (fitsAt(tx, ty)) {
          px = tx;
          py = ty;
          placed = true;
          break outer;
        }
      }
    }
  }
  if (!placed) {
    // No resize allowed: choose the least-overlapping grid slot within bounds
    let bestX = snap(left),
      bestY = snap(top);
    let bestScore = Number.POSITIVE_INFINITY;
    for (let y = snap(top); y <= bottom - CARD_H; y += step) {
      for (let x = snap(left); x <= right - CARD_W; x += step) {
        let score = 0;
        for (const o of others)
          score += overlapArea(x, y, CARD_W, CARD_H, o.x, o.y, CARD_W, CARD_H);
        if (score < bestScore) {
          bestScore = score;
          bestX = x;
          bestY = y;
          if (score === 0) break;
        }
      }
      if (bestScore === 0) break;
    }
    px = bestX;
    py = bestY;
    placed = true;
  }
  const nx = snap(px),
    ny = snap(py);
  if (sprite.x !== nx || sprite.y !== ny) {
    sprite.x = nx;
    sprite.y = ny;
    onMoved && onMoved(sprite);
  }
  const desiredZ = gv.gfx.zIndex + 1;
  if (sprite.zIndex < desiredZ) {
    sprite.zIndex = desiredZ;
    (sprite as any).__baseZ = desiredZ;
  }
}

export function autoPackGroup(
  gv: GroupVisual,
  sprites: CardSprite[],
  onMoved?: (s: CardSprite) => void,
) {
  const items = fastLookupSprites(gv.order, sprites);
  if (!items.length) return;
  const n = items.length;
  const idealCols = Math.max(1, Math.round(Math.sqrt(n * (CARD_H / CARD_W))));
  const cols = idealCols;
  const rows = Math.ceil(n / cols);
  const innerW = cols * CARD_W + (cols - 1) * GAP_X;
  const innerH = rows * CARD_H + (rows - 1) * GAP_Y;
  gv.w = snap(innerW + PAD_X * 2);
  gv.h = snap(HEADER_HEIGHT + PAD_Y + innerH + PAD_Y + PAD_BOTTOM_EXTRA);
  gv._expandedH = gv.h;
  layoutGroup(gv, sprites, onMoved);
  drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
  if (gv._zoomLabel && gv._zoomLabel.visible) positionZoomOverlay(gv);
}

export function insertionIndexForPoint(
  gv: GroupVisual,
  worldX: number,
  worldY: number,
): number {
  const innerX = worldX - gv.gfx.x - PAD_X;
  const innerY = worldY - gv.gfx.y - HEADER_HEIGHT - PAD_Y;
  if (innerX < 0 || innerY < 0) return 0;
  const usableW = Math.max(1, gv.w - PAD_X * 2);
  const cols = Math.max(1, Math.floor((usableW + GAP_X) / (CARD_W + GAP_X)));
  const col = Math.max(
    0,
    Math.min(cols - 1, Math.floor(innerX / (CARD_W + GAP_X))),
  );
  const row = Math.max(0, Math.floor(innerY / (CARD_H + GAP_Y)));
  const idx = row * cols + col;
  return Math.max(0, Math.min(gv.order.length, idx));
}

export function addCardToGroupOrdered(
  gv: GroupVisual,
  cardId: number,
  insertIndex: number,
) {
  if (gv.items.has(cardId)) return;
  gv.items.add(cardId);
  if (insertIndex >= 0 && insertIndex <= gv.order.length)
    gv.order.splice(insertIndex, 0, cardId);
  else gv.order.push(cardId);
}

export function removeCardFromGroup(gv: GroupVisual, cardId: number) {
  if (!gv.items.has(cardId)) return;
  gv.items.delete(cardId);
  const idx = gv.order.indexOf(cardId);
  if (idx >= 0) gv.order.splice(idx, 1);
}

// ---- Dynamic Text Resolution (crisp zoom) ----
// Call this each frame (cheap; early exit unless threshold crossed)
export function updateGroupTextQuality(
  gv: GroupVisual,
  worldScale: number,
  dpr: number = globalThis.devicePixelRatio || 1,
) {
  // Desired effective resolution: base on scale * devicePixelRatio, clamped.
  const target = Math.min(4, Math.max(1, worldScale * dpr));
  const last = gv._lastTextRes || 0;
  // Only rebake if we crossed a ~30% change or an integer-ish boundary to avoid churn.
  if (
    Math.abs(target - last) < 0.3 &&
    !(Math.floor(target) !== Math.floor(last))
  )
    return;
  gv._lastTextRes = target;
  // Apply to both text objects. Pixi v8 allows setting resolution then forcing update.
  const lbl: any = gv.label as any;
  const cnt: any = gv.count as any;
  const pr: any = gv.price as any;
  if (lbl.resolution !== undefined) {
    lbl.resolution = target;
    lbl.dirty = true;
    lbl.updateText && lbl.updateText();
  } else if (lbl.texture?.baseTexture?.setResolution)
    lbl.texture.baseTexture.setResolution(target);
  if (cnt.resolution !== undefined) {
    cnt.resolution = target;
    cnt.dirty = true;
    cnt.updateText && cnt.updateText();
  } else if (cnt.texture?.baseTexture?.setResolution)
    cnt.texture.baseTexture.setResolution(target);
  if (pr.resolution !== undefined) {
    pr.resolution = target;
    pr.dirty = true;
    pr.updateText && pr.updateText();
  } else if (pr.texture?.baseTexture?.setResolution)
    pr.texture.baseTexture.setResolution(target);
  // Ensure mipmaps & filtering for text base textures (helps minified readability when zoomed out)
  [lbl, cnt, pr].forEach((t) => {
    try {
      const bt: any = t.texture?.baseTexture;
      if (bt?.style) {
        bt.style.mipmap = "on";
        bt.style.scaleMode = "linear";
        if (bt.style.anisotropicLevel !== undefined)
          bt.style.anisotropicLevel = 4;
      }
    } catch {}
  });
  // After rebake widths may shift; re-truncate label if necessary.
  truncateLabelIfNeeded(gv);
}

// ---- Metrics (price + count) ----
export function updateGroupMetrics(gv: GroupVisual, sprites: CardSprite[]) {
  let total = 0;
  const idMap = getIdMapFast(sprites);
  for (const id of gv.items) {
    const sp = idMap.get(id);
    const card = sp?.__card;
    if (card) {
      // Scryfall style pricing: card.prices.usd (string or null)
      const usd = card.prices?.usd;
      if (usd) {
        const v = parseFloat(usd);
        if (!isNaN(v)) total += v;
      }
    }
  }
  gv.totalPrice = total;
  // Refresh overlay (visible only) so totals stay in sync at macro zoom
  if (gv._zoomLabel && gv._zoomLabel.visible) positionZoomOverlay(gv);
}

// ---- Fast lookup helpers for large group ops ----
function getIdMapFast(sprites: CardSprite[]): Map<number, CardSprite> {
  try {
    const m = (window as any).__mtgIdToSprite as
      | Map<number, CardSprite>
      | undefined;
    if (m && typeof m.get === "function") return m;
  } catch {}
  // Fallback: build a local index once
  const idx = new Map<number, CardSprite>();
  for (let i = 0; i < sprites.length; i++) idx.set(sprites[i].__id, sprites[i]);
  return idx;
}

function fastLookupSprites(ids: number[], sprites: CardSprite[]): CardSprite[] {
  const map = getIdMapFast(sprites);
  const out: CardSprite[] = [];
  for (let i = 0; i < ids.length; i++) {
    const s = map.get(ids[i]);
    if (s) out.push(s);
  }
  return out;
}

// ---------------- Zoom-Out Presentation -----------------
// Fade cards + normal chrome out as user zooms far out; fade in large centered group label so the
// whole group becomes a readable info tile at macro scale.
// Thresholds (world scale): below HIGH start fade; at/below LOW overlay fully active.
// Hard-coded to "kick in sharply at zooms < 1" per request.
const ZOOM_OVERLAY_HIGH = 0.85; // deactivate when zooming in past this
const ZOOM_OVERLAY_LOW = 0.75; // activate when zooming out past this

function positionZoomOverlay(gv: GroupVisual) {
  if (!gv._zoomLabel) return;
  const zl = gv._zoomLabel;
  zl.text = `${gv.name}\n${gv.items.size} cards  $${gv.totalPrice.toFixed(2)}`;
  // Ensure color stays theme-appropriate (dark in light mode)
  try {
    (zl.style as any).fill = OVERLAY_TEXT_COLOR;
  } catch {}
  // Constrain width and adjust font size downward if necessary (simple heuristic)
  const pad = 16;
  const maxWidth = Math.max(60, gv.w - pad * 2);
  const style: any = zl.style;
  style.wordWrap = true;
  style.wordWrapWidth = maxWidth;
  let size = 96;
  style.fontSize = size;
  (zl as any).dirty = true;
  (zl as any).updateText && (zl as any).updateText();
  while (zl.width > maxWidth && size > 18) {
    size -= 2;
    style.fontSize = size;
    (zl as any).dirty = true;
    (zl as any).updateText && (zl as any).updateText();
  }
  zl.x = (gv.w - zl.width) / 2;
  zl.y = (gv.h - zl.height) / 2;
  // Make text non-interactive; a separate drag surface will receive input.
  (zl as any).eventMode = "none";
  (zl as any).cursor = "default";
}

export function updateGroupZoomPresentation(
  gv: GroupVisual,
  worldScale: number,
  sprites: CardSprite[],
) {
  if (gv.collapsed) {
    if (gv._zoomLabel) {
      gv._zoomLabel.visible = false;
      gv._zoomLabel.alpha = 0;
    }
    gv._lastZoomPhase = 0;
    return;
  }
  // Hysteresis: activate when worldScale <= LOW, deactivate when worldScale >= HIGH; in-between keep previous.
  const prevPhase = gv._lastZoomPhase ?? 0;
  const prevOverlayActive = prevPhase > 0;
  let overlayActive: boolean;
  if (prevOverlayActive) overlayActive = worldScale <= ZOOM_OVERLAY_HIGH;
  else overlayActive = worldScale <= ZOOM_OVERLAY_LOW;
  // Cooldown to prevent rapid flapping on boundary due to momentum/rounding
  const nowTs = performance.now();
  const lastToggle: number = (gv as any).__overlayToggleAt ?? 0;
  if (overlayActive !== prevOverlayActive && nowTs - lastToggle < 250) {
    overlayActive = prevOverlayActive;
  }
  (gv as any).__lastOverlayScale = worldScale;
  const toggled = overlayActive !== prevOverlayActive;
  gv._lastZoomPhase = overlayActive ? 1 : 0;
  const overlay = gv._zoomLabel;
  if (overlay) {
    const wasVisible = overlay.visible;
    if (toggled) {
      if (overlayActive && !wasVisible) {
        overlay.visible = true;
        overlay.alpha = 1;
        positionZoomOverlay(gv);
      } else if (!overlayActive && wasVisible) {
        overlay.alpha = 0;
        overlay.visible = false;
      }
    }
    // Avoid expensive per-frame text reflow when many groups are visible.
    // Layout routines call positionZoomOverlay(gv) on demand when dimensions/content change.
  }
  // When overlay active state changes, toggle chrome visibility once.
  if (toggled) {
    if (overlayActive) {
      gv.header.visible = false;
      gv.header.eventMode = "none" as any;
      gv.label.visible = false;
      gv.count.visible = false;
      gv.price.visible = false;
    } else {
      gv.header.visible = true;
      gv.header.eventMode = "static" as any;
      gv.label.visible = true;
      gv.count.visible = true;
      gv.price.visible = true;
    }
  }
  // Maintain a dedicated transparent drag surface with an inset hitArea so edges remain clickable.
  const dragSurf = gv._overlayDrag as PIXI.Graphics | undefined;
  if (dragSurf) {
    if (overlayActive) {
      const EDGE_PX = 16; // must match main.ts EDGE_PX
      const prevScale: number = (gv as any).__lastDragScale ?? 0;
      const prevW: number = (gv as any).__lastDragW ?? -1;
      const prevH: number = (gv as any).__lastDragH ?? -1;
      const scale = Math.max(0.0001, worldScale);
      const scaleDelta = Math.abs(scale - prevScale);
      const sizeChanged = gv.w !== prevW || gv.h !== prevH;
      if (toggled || scaleDelta > 0.05 || sizeChanged) {
        const inset = Math.min(gv.w / 2, Math.min(gv.h / 2, EDGE_PX / scale));
        const iw = Math.max(0, gv.w - inset * 2);
        const ih = Math.max(0, gv.h - inset * 2);
        (dragSurf as any).eventMode = "static";
        (dragSurf as any).cursor = "move";
        dragSurf.visible = true;
        (dragSurf as any).hitArea = new PIXI.Rectangle(inset, inset, iw, ih);
        (gv as any).__lastDragScale = scale;
        (gv as any).__lastDragW = gv.w;
        (gv as any).__lastDragH = gv.h;
      }
    } else if (toggled) {
      dragSurf.visible = false;
      (dragSurf as any).eventMode = "none";
      (dragSurf as any).hitArea = null as any;
    }
  }
  // If nothing toggled and no drag update was needed, we’re done.
  if (!toggled) return;
  // If the overlay active state didn't change since last frame, skip per-card work entirely.
  if (overlayActive === prevOverlayActive) return;
  (gv as any).__overlayToggleAt = nowTs;
  try {
    (window as any).__overlayToggles =
      ((window as any).__overlayToggles | 0) + 1;
  } catch {}
  // Adjust member card sprite visibility/alpha
  const idToSprite: Map<number, CardSprite> | undefined = (window as any)
    .__mtgIdToSprite;
  const now = performance.now();
  for (const id of gv.items) {
    const sp = idToSprite
      ? idToSprite.get(id)
      : sprites.find((s) => s.__id === id);
    if (!sp) continue;
    // Flag overlay activity for interaction layer so card drags are suppressed when overlay intended for group drag.
    (sp as any).__groupOverlayActive = overlayActive;
    // Toggle eventMode so sibling overlay can receive pointer events (cards are siblings, not children of group)
    const desiredMode = overlayActive ? "none" : "static";
    if ((sp as any).eventMode !== desiredMode)
      (sp as any).eventMode = desiredMode as any;
    if (overlayActive) {
      if (sp.cursor !== "default") sp.cursor = "default";
      if (sp.alpha !== 0) sp.alpha = 0;
      if (sp.visible) {
        sp.visible = false;
        (sp as any).__hiddenAt = now;
        // Mark overlay-hidden time for budget logic and optionally schedule a budget pass soon.
        try {
          (window as any).__overlayHiddenCount =
            ((window as any).__overlayHiddenCount | 0) + 1;
        } catch {}
      }
    } else {
      if (sp.cursor !== "pointer") sp.cursor = "pointer";
      if (sp.alpha !== 1) sp.alpha = 1;
      if (!sp.visible) {
        sp.visible = true;
        (sp as any).__hiddenAt = undefined;
      }
    }
  }
  // Dim frame + header consistently (same opacity whether overlay is active or not)
  gv.frame.alpha = GROUP_DIM_ALPHA;
  gv.header.alpha = GROUP_DIM_ALPHA;
}
