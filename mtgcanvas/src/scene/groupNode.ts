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
}

// Styling constants (tuned to approximate ComfyUI aesthetic while remaining generic)
export const HEADER_HEIGHT = 24;
const BODY_RADIUS = 6;
const HEADER_RADIUS = 6;
const BORDER_COLOR = 0x222a30;
const BORDER_COLOR_SELECTED = 0x33bbff;
const BODY_BG = 0x161c20;          // flat dark body background
const BODY_BG_COLLAPSED = 0x181e22;
const HEADER_TEXT_COLOR = 0xffffff;
const COUNT_TEXT_COLOR = 0xb5c7d1;
const PRICE_TEXT_COLOR = 0xd9f0ff;
const FONT_FAMILY = 'Inter, system-ui, sans-serif';
// Vertical placement is computed per text based on its font size for precise centering.

// Layout constants for cards inside a group
const GRID_SIZE = 20;
const CARD_W = 100, CARD_H = 140;
const PAD_X = 16;      // inner left/right
const PAD_Y = 12;      // inner top below header
const PAD_BOTTOM_EXTRA = 8; // extra bottom padding so cards don't touch frame
const GAP_X = 20;      // horizontal space between cards
const GAP_Y = 20;      // vertical space between cards
function snap(v:number){ return Math.round(v/GRID_SIZE)*GRID_SIZE; }

// Muted header palette; can be recolored later via context menu.
const PALETTE = [0x2d3e53,0x444444,0x224433,0x333355,0x553355,0x335555,0x4a284a,0x3c4a28];

export function createGroupVisual(id:number, x:number, y:number, w=320, h=280): GroupVisual {
  const gfx = new PIXI.Container(); gfx.x = x; gfx.y = y; gfx.eventMode='static'; gfx.cursor='default'; gfx.zIndex = 1;
  const frame = new PIXI.Graphics(); frame.eventMode='static'; frame.cursor='default'; (frame as any).__groupBody = true;
  const header = new PIXI.Graphics(); header.eventMode='static'; header.cursor='move'; (header as any).__groupHeader = true;
  const label = new PIXI.Text({ text:`Group ${id}`, style:{ fill: HEADER_TEXT_COLOR, fontSize: 13, fontFamily: FONT_FAMILY, fontWeight: '500', lineHeight: 13 } });
  const count = new PIXI.Text({ text:'0', style:{ fill: COUNT_TEXT_COLOR, fontSize: 12, fontFamily: FONT_FAMILY, lineHeight: 12 } });
  const price = new PIXI.Text({ text:'$0.00', style:{ fill: PRICE_TEXT_COLOR, fontSize: 12, fontFamily: FONT_FAMILY, fontWeight:'500', lineHeight: 12 } });
  const resize = new PIXI.Graphics(); resize.eventMode='static'; resize.cursor='nwse-resize';
  const color = PALETTE[id % PALETTE.length];
  const gv: GroupVisual = { id, gfx, frame, header, label, count, price, resize, name:`Group ${id}`, color, w, h, collapsed:false, _expandedH:h, items:new Set(), order:[], totalPrice:0 };
  gfx.addChild(frame, header, label, count, price, resize);
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

  // Resize affordance only when expanded
  resize.visible = !collapsed;
  if (!collapsed) {
    const sz = 14;
    resize.clear();
    // triangle bottom-right
    resize.moveTo(w, h)
      .lineTo(w-sz, h)
      .lineTo(w, h-sz)
      .closePath()
      .fill({color: 0x2c3942});
    resize.stroke({color: borderColor, width:1});
    resize.x = 0; resize.y = 0; // absolute inside group
    resize.hitArea = new PIXI.Rectangle(w - sz, h - sz, sz, sz);
  }
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
    const nx = snap(tx); const ny = snap(ty);
    if (s.x!==nx || s.y!==ny) { s.x = nx; s.y = ny; onMoved && onMoved(s); }
  });
  const rows = Math.ceil(items.length / cols);
  const neededH = HEADER_HEIGHT + PAD_Y + rows * CARD_H + (rows-1) * GAP_Y + PAD_Y + PAD_BOTTOM_EXTRA;
  if (neededH > gv.h) { gv.h = snap(neededH); gv._expandedH = gv.h; }
  drawGroup(gv, SelectionStore.state.groupIds.has(gv.id));
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

