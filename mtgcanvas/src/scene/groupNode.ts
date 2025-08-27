// Completely redesigned group ("node") visuals to mimic ComfyUI-style nodes:
// - Flat modern rectangles with a colored header bar
// - Consistent 1px border, subtle body background
// - No runtime animations / easing; instant state changes
// - Simple resize handle triangle (bottom-right) when expanded
// - Clear separation of layout logic from visual drawing
// - Minimal mutable surface area

import * as PIXI from 'pixi.js';
import { SelectionStore } from '../state/selectionStore';
import type { CardSprite } from './cardNode';

// Public shape used elsewhere. Keep name for integration, but surface is simplified.
export interface GroupVisual {
  id: number;
  gfx: PIXI.Container;          // root container positioned in world space
  frame: PIXI.Graphics;          // body/background
  header: PIXI.Graphics;         // header bar (colored)
  label: PIXI.Text;              // name text
  count: PIXI.Text;              // item count (right aligned)
  price: PIXI.Text;              // total price text (rightmost)
  resize: PIXI.Graphics;         // resize affordance (triangle)
  name: string;
  color: number;                 // header color
  w: number;
  h: number;
  collapsed: boolean;
  _expandedH: number;            // remembers height when collapsed
  items: Set<number>;            // member card ids
  order: number[];               // ordering for layout
  _lastTextRes?: number;         // internal: last applied resolution for dynamic crispness
  totalPrice: number;            // cached aggregate price
  _zoomLabel?: PIXI.Text;        // large centered label when zoomed far out
  _lastZoomPhase?: number;       // memo of last applied phase (0..1)
  _overlayDrag?: PIXI.Graphics;  // transparent drag surface when overlay visible
}

// Styling constants (tuned to approximate ComfyUI aesthetic while remaining generic)
// Slightly larger header for improved readability and to better host inline controls.
export const HEADER_HEIGHT = 32;
const BODY_RADIUS = 6;
const HEADER_RADIUS = 6;
// Colors now derived from CSS variables so light/dark themes stay in sync.
// We sample only when theme changes to avoid per-frame cost.
let BORDER_COLOR = 0x222a30;
let BORDER_COLOR_SELECTED = 0x33bbff;
let BODY_BG = 0x161c20;          // flat dark body background
let BODY_BG_COLLAPSED = 0x181e22;
let HEADER_TEXT_COLOR = 0xffffff;
let COUNT_TEXT_COLOR = 0xb5c7d1;
let PRICE_TEXT_COLOR = 0xd9f0ff;
let RESIZE_TRI_COLOR = 0x2c3942;
function hexFromCSS(varName:string, fallback:number){
  try { const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); if (!v) return fallback; if (/^#?[0-9a-fA-F]{3,8}$/.test(v)){ const hex = v.startsWith('#')? v.slice(1):v; return parseInt(hex.length===3? hex.split('').map(c=> c+c).join(''): hex.slice(0,6),16); } } catch {}
  return fallback;
}
export function applyGroupTheme(){
  // Map CSS vars to internal palette; provide fallbacks resembling existing dark theme.
  BORDER_COLOR = hexFromCSS('--panel-border', 0x222a30);
  BORDER_COLOR_SELECTED = hexFromCSS('--panel-accent', 0x33bbff);
  // Derive body backgrounds by darkening panel background slightly.
  const panelBg = hexFromCSS('--panel-bg', 0x101b24);
  const panelAlt = hexFromCSS('--panel-bg-alt', 0x0d1720);
  BODY_BG = panelBg;
  BODY_BG_COLLAPSED = panelAlt;
  HEADER_TEXT_COLOR = hexFromCSS('--panel-fg', 0xffffff);
  COUNT_TEXT_COLOR = hexFromCSS('--panel-fg-dim', 0xb5c7d1);
  PRICE_TEXT_COLOR = HEADER_TEXT_COLOR;
  RESIZE_TRI_COLOR = hexFromCSS('--menu-hover-bg', 0x2c3942);
}
// Initial sample (safe if executed before DOM ready; will be resampled on first theme ensure anyway)
try { applyGroupTheme(); } catch {}
import { registerThemeListener } from '../ui/theme';
registerThemeListener(()=> applyGroupTheme());
const FONT_FAMILY = 'Inter, system-ui, sans-serif';
// Vertical placement is computed per text based on its font size for precise centering.

// Layout constants for cards inside a group
const GRID_SIZE = 8; // match reduced global grid for consistent snapping when resizing groups
const CARD_W = 100, CARD_H = 140;
const PAD_X = 16;      // inner left/right
const PAD_Y = 12;      // inner top below header
const PAD_BOTTOM_EXTRA = 8; // extra bottom padding so cards don't touch frame
// Target: at zoom 2.69 screen gap ~8px -> world gap ≈ 8 / 2.69 ≈ 2.97 -> use 3
const GAP_X = 3;       // ultra-tight horizontal space (≈8px at scale 2.69)
const GAP_Y = 3;       // ultra-tight vertical space (≈8px at scale 2.69)
function snap(v:number){ return Math.round(v/GRID_SIZE)*GRID_SIZE; }

// Muted header palette; can be recolored later via context menu.
const PALETTE = [0x2d3e53,0x444444,0x224433,0x333355,0x553355,0x335555,0x4a284a,0x3c4a28];

export function createGroupVisual(id:number, x:number, y:number, w=320, h=280): GroupVisual {
  const gfx = new PIXI.Container(); gfx.x = x; gfx.y = y; gfx.eventMode='static'; gfx.cursor='default';
  // Render groups beneath their member cards; cards will be assigned zIndex >= (group zIndex + 1)
  gfx.zIndex = 40; // elevated but still below dynamically raised dragging cards
  const frame = new PIXI.Graphics(); frame.eventMode='static'; frame.cursor='default'; (frame as any).__groupBody = true;
  const header = new PIXI.Graphics(); header.eventMode='static'; header.cursor='move'; (header as any).__groupHeader = true;
  const label = new PIXI.Text({ text:`Group ${id}`, style:{ fill: HEADER_TEXT_COLOR, fontSize: 13, fontFamily: FONT_FAMILY, fontWeight: '500', lineHeight: 13 } });
  const count = new PIXI.Text({ text:'0', style:{ fill: COUNT_TEXT_COLOR, fontSize: 12, fontFamily: FONT_FAMILY, lineHeight: 12 } });
  const price = new PIXI.Text({ text:'$0.00', style:{ fill: PRICE_TEXT_COLOR, fontSize: 12, fontFamily: FONT_FAMILY, fontWeight:'500', lineHeight: 12 } });
  const resize = new PIXI.Graphics(); resize.eventMode='static'; resize.cursor='nwse-resize';
  const color = PALETTE[id % PALETTE.length];
  const gv: GroupVisual = { id, gfx, frame, header, label, count, price, resize, name:`Group ${id}`, color, w, h, collapsed:false, _expandedH:h, items:new Set(), order:[], totalPrice:0 };
  // Zoom-out overlay label (initially hidden)
  const zoomLabel = new PIXI.Text({ text: gv.name, style:{ fill: HEADER_TEXT_COLOR, fontSize: 96, fontFamily: FONT_FAMILY, fontWeight: '600', align:'center', lineHeight: 100 } });
  zoomLabel.visible = false; zoomLabel.alpha = 0; gv._zoomLabel = zoomLabel;
  // Dedicated transparent drag surface placed below text
  const overlayDrag = new PIXI.Graphics();
  overlayDrag.visible = false; overlayDrag.alpha = 0; (overlayDrag as any).eventMode = 'none'; gv._overlayDrag = overlayDrag;
  gfx.addChild(frame, header, label, count, price, resize, overlayDrag, zoomLabel);
  drawGroup(gv, false);
  return gv;
}

// Core renderer for group visuals.
export function drawGroup(gv: GroupVisual, selected: boolean) {
  const { frame, header, label, count, resize, w, h, collapsed } = gv;
  frame.clear(); header.clear(); resize.clear();
  const borderColor = selected ? BORDER_COLOR_SELECTED : BORDER_COLOR;

  // Body (hide card area when collapsed)
  const bodyH = collapsed ? HEADER_HEIGHT : h;
  // Body background (one rounded rect). ComfyUI style uses simple rectangles; we keep slight rounding.
  frame.roundRect(0,0,w,bodyH,BODY_RADIUS).fill({color: collapsed? BODY_BG_COLLAPSED : BODY_BG}).stroke({color: borderColor, width: selected? 2:1});

  // Header with rounded top corners and square bottom corners
  header.clear();
  header.moveTo(0, HEADER_HEIGHT)
    .lineTo(0, HEADER_RADIUS)
    .quadraticCurveTo(0,0, HEADER_RADIUS, 0)
    .lineTo(w-HEADER_RADIUS, 0)
    .quadraticCurveTo(w,0, w, HEADER_RADIUS)
    .lineTo(w, HEADER_HEIGHT)
    .closePath()
    .fill({color: gv.color})
    .stroke({color: borderColor, width: selected? 2:1});
  header.hitArea = new PIXI.Rectangle(0,0,w,HEADER_HEIGHT);

  // Label text (truncate if needed)
  label.text = gv.name + (collapsed ? ' ▸' : '');
  label.x = 8;
  truncateLabelIfNeeded(gv);
  positionHeaderText(label);

  // Price & count text (always show) - price rightmost, count just left of it
  const price = gv.price;
  price.text = `$${gv.totalPrice.toFixed(2)}`;
  price.x = w - price.width - 8; positionHeaderText(price);
  count.text = gv.items.size.toString();
  count.x = price.x - count.width - 6; positionHeaderText(count);

  // Legacy resize triangle removed (edge/corner resize active everywhere). Keep graphic hidden & non-interactive.
  resize.visible = false; resize.eventMode='none'; resize.hitArea = null as any;
}

function truncateLabelIfNeeded(gv: GroupVisual) {
  // Simple ellipsis if label + count overlap
  // Reserve space for count + price on right
  const maxLabelWidth = gv.w - 16 - (gv.count.width + 6 + gv.price.width) - 10; // padding and gap
  if (gv.label.width <= maxLabelWidth) return;
  const original = gv.name + (gv.collapsed? ' ▸':'');
  let txt = original;
  while (txt.length > 3 && gv.label.width > maxLabelWidth) {
    txt = txt.slice(0, -1);
    gv.label.text = txt + '…';
  }
}

function positionHeaderText(t: PIXI.Text){
  const size = (t.style as any)?.fontSize || t.height; // prefer declared font size
  // Center using font size rather than rendered height (avoids resolution scaling jitter)
  let y = (HEADER_HEIGHT - size)/2;
  // Optical adjustment: slightly raise heavier or larger fonts so visual centers align.
  const weight = (t.style as any)?.fontWeight;
  if (size >= 13) y -= 1;          // larger label font sits a tad low optically
  if (weight && weight !== 'normal' && weight !== '400') y -= 0.5; // semi/bold fonts
  // Price text ($...) appears optically low due to glyph shape; lift it a bit.
  if (typeof t.text === 'string' && t.text.startsWith('$')) y -= 2; // extra lift for price
  t.y = Math.round(y);
}

// Layout cards into a grid inside group body.
export function layoutGroup(gv: GroupVisual, sprites: CardSprite[], onMoved?: (s:CardSprite)=>void) {
  if (gv.collapsed) return;
  const items = gv.order.map(id=> sprites.find(s=> s.__id===id)).filter(Boolean) as CardSprite[];
  if (!items.length) return;
  const usableW = Math.max(1, gv.w - PAD_X*2);
  const cols = Math.max(1, Math.floor((usableW + GAP_X) / (CARD_W + GAP_X)));
  items.forEach((s,i)=> {
    const col = i % cols; const row = Math.floor(i / cols);
    const tx = gv.gfx.x + PAD_X + col * (CARD_W + GAP_X);
    const ty = gv.gfx.y + HEADER_HEIGHT + PAD_Y + row * (CARD_H + GAP_Y);
  // Do NOT snap internal card placements to the global 20px grid; we need sub-grid precision
  // so that tiny world gaps (e.g. 3) remain intact and scale predictably (≈8px at zoom 2.69).
  const nx = tx; const ny = ty;
  if (s.x!==nx || s.y!==ny) { s.x = nx; s.y = ny; onMoved && onMoved(s); }
    // Ensure grouped cards render above group frame/background.
  const desiredZ = gv.gfx.zIndex + 1;
  if (s.zIndex < desiredZ) { s.zIndex = desiredZ; (s as any).__baseZ = desiredZ; }
  });
  const rows = Math.ceil(items.length / cols);
  const neededH = HEADER_HEIGHT + PAD_Y + rows * CARD_H + (rows-1) * GAP_Y + PAD_Y + PAD_BOTTOM_EXTRA;
  if (neededH > gv.h) { gv.h = snap(neededH); gv._expandedH = gv.h; }
  drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
  positionZoomOverlay(gv); // maintain overlay position after layout growth
}

export function setGroupCollapsed(gv: GroupVisual, collapsed:boolean, sprites: CardSprite[]) {
  if (gv.collapsed === collapsed) return;
  gv.collapsed = collapsed;
  if (collapsed) {
    gv._expandedH = gv.h;
    gv.h = HEADER_HEIGHT; // collapse to header only
    // Hide children
    for (const id of gv.items) { const s = sprites.find(sp=> sp.__id===id); if (s) { s.visible = false; s.renderable = false; } }
  } else {
    gv.h = gv._expandedH || gv.h;
    for (const id of gv.items) { const s = sprites.find(sp=> sp.__id===id); if (s) { s.visible = true; s.renderable = true; } }
  }
  drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
}

export function autoPackGroup(gv: GroupVisual, sprites: CardSprite[], onMoved?: (s:CardSprite)=>void) {
  const items = gv.order.map(id=> sprites.find(s=> s.__id===id)).filter(Boolean) as CardSprite[];
  if (!items.length) return;
  const n = items.length;
  const idealCols = Math.max(1, Math.round(Math.sqrt(n * (CARD_H / CARD_W))));
  const cols = idealCols;
  const rows = Math.ceil(n / cols);
  const innerW = cols * CARD_W + (cols - 1) * GAP_X;
  const innerH = rows * CARD_H + (rows - 1) * GAP_Y;
  gv.w = snap(innerW + PAD_X*2);
  gv.h = snap(HEADER_HEIGHT + PAD_Y + innerH + PAD_Y + PAD_BOTTOM_EXTRA);
  gv._expandedH = gv.h;
  layoutGroup(gv, sprites, onMoved);
  drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
  positionZoomOverlay(gv);
}

export function insertionIndexForPoint(gv: GroupVisual, worldX:number, worldY:number): number {
  const innerX = worldX - gv.gfx.x - PAD_X;
  const innerY = worldY - gv.gfx.y - HEADER_HEIGHT - PAD_Y;
  if (innerX < 0 || innerY < 0) return 0;
  const usableW = Math.max(1, gv.w - PAD_X*2);
  const cols = Math.max(1, Math.floor((usableW + GAP_X) / (CARD_W + GAP_X)));
  const col = Math.max(0, Math.min(cols - 1, Math.floor(innerX / (CARD_W + GAP_X))));
  const row = Math.max(0, Math.floor(innerY / (CARD_H + GAP_Y)));
  const idx = row * cols + col;
  return Math.max(0, Math.min(gv.order.length, idx));
}

export function addCardToGroupOrdered(gv: GroupVisual, cardId:number, insertIndex:number) {
  if (gv.items.has(cardId)) return;
  gv.items.add(cardId);
  if (insertIndex >= 0 && insertIndex <= gv.order.length) gv.order.splice(insertIndex, 0, cardId); else gv.order.push(cardId);
}

export function removeCardFromGroup(gv: GroupVisual, cardId:number) {
  if (!gv.items.has(cardId)) return;
  gv.items.delete(cardId);
  const idx = gv.order.indexOf(cardId); if (idx >= 0) gv.order.splice(idx,1);
}

// ---- Dynamic Text Resolution (crisp zoom) ----
// Call this each frame (cheap; early exit unless threshold crossed)
export function updateGroupTextQuality(gv: GroupVisual, worldScale:number, dpr: number = globalThis.devicePixelRatio || 1) {
  // Desired effective resolution: base on scale * devicePixelRatio, clamped.
  const target = Math.min(4, Math.max(1, worldScale * dpr));
  const last = gv._lastTextRes || 0;
  // Only rebake if we crossed a ~30% change or an integer-ish boundary to avoid churn.
  if (Math.abs(target - last) < 0.3 && !(Math.floor(target) !== Math.floor(last))) return;
  gv._lastTextRes = target;
  // Apply to both text objects. Pixi v8 allows setting resolution then forcing update.
  const lbl:any = gv.label as any; const cnt:any = gv.count as any; const pr:any = gv.price as any;
  if (lbl.resolution !== undefined) { lbl.resolution = target; lbl.dirty = true; lbl.updateText && lbl.updateText(); }
  else if (lbl.texture?.baseTexture?.setResolution) lbl.texture.baseTexture.setResolution(target);
  if (cnt.resolution !== undefined) { cnt.resolution = target; cnt.dirty = true; cnt.updateText && cnt.updateText(); }
  else if (cnt.texture?.baseTexture?.setResolution) cnt.texture.baseTexture.setResolution(target);
  if (pr.resolution !== undefined) { pr.resolution = target; pr.dirty = true; pr.updateText && pr.updateText(); }
  else if (pr.texture?.baseTexture?.setResolution) pr.texture.baseTexture.setResolution(target);
  // Ensure mipmaps & filtering for text base textures (helps minified readability when zoomed out)
  [lbl, cnt, pr].forEach(t=> {
    try {
      const bt:any = t.texture?.baseTexture; if (bt?.style) {
        bt.style.mipmap = 'on';
        bt.style.scaleMode = 'linear';
        if (bt.style.anisotropicLevel !== undefined) bt.style.anisotropicLevel = 4;
      }
    } catch {}
  });
  // After rebake widths may shift; re-truncate label if necessary.
  truncateLabelIfNeeded(gv);
}

// ---- Metrics (price + count) ----
export function updateGroupMetrics(gv: GroupVisual, sprites: CardSprite[]) {
  let total = 0;
  for (const id of gv.items) {
    const sp = sprites.find(s=> s.__id===id);
    const card = sp?.__card;
    if (card) {
      // Scryfall style pricing: card.prices.usd (string or null)
      const usd = card.prices?.usd;
      if (usd) { const v = parseFloat(usd); if (!isNaN(v)) total += v; }
    }
  }
  gv.totalPrice = total;
}

// ---------------- Zoom-Out Presentation -----------------
// Fade cards + normal chrome out as user zooms far out; fade in large centered group label so the
// whole group becomes a readable info tile at macro scale.
// Thresholds (world scale): below HIGH start fade; at/below LOW overlay fully active.
// Hard-coded to "kick in sharply at zooms < 1" per request.
export let ZOOM_OVERLAY_HIGH = 0.8; // start just under 1
export let ZOOM_OVERLAY_LOW = 0.8;  // finish quickly
export let ZOOM_OVERLAY_CURVE = 2.0; // >1 sharper, =1 linear

// Developer override (e.g. via console) if future tuning desired; no persistence side effects.
export function setGroupOverlayThresholds(high:number, low:number, curve?:number){
  if (!isFinite(high) || !isFinite(low)) return;
  const MIN = 0.01, MAX = 3;
  high = Math.min(MAX, Math.max(MIN, high));
  low = Math.min(MAX, Math.max(MIN, low));
  if (low > high) [low, high] = [high, low];
  ZOOM_OVERLAY_HIGH = high; ZOOM_OVERLAY_LOW = low;
  if (curve !== undefined && isFinite(curve) && curve > 0) ZOOM_OVERLAY_CURVE = curve;
  try { const all: any[] = (window as any).__mtgGroups || []; all.forEach(gv=> gv && (gv._lastZoomPhase = undefined)); } catch {}
}

function positionZoomOverlay(gv: GroupVisual){
  if (!gv._zoomLabel) return;
  const zl = gv._zoomLabel;
  zl.text = `${gv.name}\n${gv.items.size} cards  $${gv.totalPrice.toFixed(2)}`;
  // Constrain width and adjust font size downward if necessary (simple heuristic)
  const pad = 16;
  const maxWidth = Math.max(60, gv.w - pad*2);
  const style: any = zl.style; style.wordWrap = true; style.wordWrapWidth = maxWidth;
  let size = 96; style.fontSize = size; (zl as any).dirty = true; (zl as any).updateText && (zl as any).updateText();
  while (zl.width > maxWidth && size > 18){ size -= 2; style.fontSize = size; (zl as any).dirty = true; (zl as any).updateText && (zl as any).updateText(); }
  zl.x = (gv.w - zl.width)/2;
  zl.y = (gv.h - zl.height)/2;
  // Make text non-interactive; a separate drag surface will receive input.
  (zl as any).eventMode = 'none';
  (zl as any).cursor = 'default';
}

export function updateGroupZoomPresentation(gv: GroupVisual, worldScale:number, sprites: CardSprite[]) {
  if (gv.collapsed) {
    if (gv._zoomLabel) { gv._zoomLabel.visible=false; gv._zoomLabel.alpha=0; }
    gv._lastZoomPhase = 0; return;
  }
  let phase = 0; // 0 cards visible, 1 overlay fully visible
  if (worldScale <= ZOOM_OVERLAY_HIGH) {
    if (worldScale <= ZOOM_OVERLAY_LOW) phase = 1; else {
      const span = ZOOM_OVERLAY_HIGH - ZOOM_OVERLAY_LOW; const lin = 1 - ((worldScale - ZOOM_OVERLAY_LOW)/span); phase = Math.pow(lin, ZOOM_OVERLAY_CURVE); // curve sharpens
    }
  }
  const prevPhase = gv._lastZoomPhase ?? 0;
  const lastScale:any = (gv as any).__lastOverlayScale ?? -1;
  const scaleChanged = Math.abs(worldScale - lastScale) > 1e-4;
  const minorPhase = Math.abs(phase - prevPhase) < 0.02;
  (gv as any).__lastOverlayScale = worldScale;
  gv._lastZoomPhase = phase;
  const overlay = gv._zoomLabel;
  if (overlay) {
    if (phase > 0 && !overlay.visible) { overlay.visible=true; positionZoomOverlay(gv); }
    overlay.alpha = phase;
    if (phase === 0) overlay.visible = false;
    else if (phase === 1) positionZoomOverlay(gv); // ensure centered after any dimension changes
  }
  // Maintain a dedicated transparent drag surface with an inset hitArea so edges remain clickable.
  const dragSurf = gv._overlayDrag as PIXI.Graphics | undefined;
  if (dragSurf) {
    if (phase > 0) {
      const EDGE_PX = 16; // must match main.ts EDGE_PX
      const scale = Math.max(0.0001, worldScale);
      const inset = Math.min(gv.w/2, Math.min(gv.h/2, EDGE_PX / scale));
      const iw = Math.max(0, gv.w - inset*2);
      const ih = Math.max(0, gv.h - inset*2);
      (dragSurf as any).eventMode = 'static';
      (dragSurf as any).cursor = 'move';
      dragSurf.visible = true;
      (dragSurf as any).hitArea = new PIXI.Rectangle(inset, inset, iw, ih);
    } else {
      dragSurf.visible = false;
      (dragSurf as any).eventMode = 'none';
      (dragSurf as any).hitArea = null as any;
    }
  }
  // If only minor phase change and no scale change, we can skip heavier per-card updates.
  if (minorPhase && !scaleChanged) return;
  // Adjust member card sprite visibility/alpha
  for (const id of gv.items) {
    const sp = sprites.find(s=> s.__id===id); if (!sp) continue;
  // Flag overlay activity for interaction layer so card drags are suppressed when overlay intended for group drag.
  const overlayActive = phase > 0; // any visible phase suppresses card interactivity
  (sp as any).__groupOverlayActive = overlayActive;
  // Toggle eventMode so sibling overlay can receive pointer events (cards are siblings, not children of group)
  const desiredMode = overlayActive ? 'none' : 'static';
  if ((sp as any).eventMode !== desiredMode) (sp as any).eventMode = desiredMode as any;
  if (overlayActive) { if (sp.cursor !== 'default') sp.cursor='default'; }
  else { if (sp.cursor !== 'pointer') sp.cursor='pointer'; }
    if (phase <= 0) {
      if (sp.alpha !== 1) sp.alpha=1; if (!sp.visible) sp.visible=true; if (!sp.renderable) sp.renderable=true;
    } else if (phase >= 1) {
      if (sp.alpha !== 0) sp.alpha=0; if (sp.visible) { sp.visible=false; sp.renderable=false; }
    } else {
      const a = 1 - phase; if (Math.abs(sp.alpha - a) > 0.05) sp.alpha = a; if (!sp.visible) sp.visible=true; if (!sp.renderable) sp.renderable=true;
    }
  }
  // Dim frame + header (keep subtle silhouette for spatial awareness)
  const dimAlpha = 1 - phase*0.6;
  gv.frame.alpha = dimAlpha; gv.header.alpha = dimAlpha;
}


