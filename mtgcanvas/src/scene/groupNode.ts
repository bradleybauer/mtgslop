import * as PIXI from 'pixi.js';
import { SelectionStore } from '../state/selectionStore';
import type { CardSprite } from './cardNode';

export interface GroupVisual { id:number; gfx: PIXI.Graphics; items: Set<number>; w:number; h:number; handle: PIXI.Graphics; header: PIXI.Graphics; label: PIXI.Text; name: string; }

const HEADER_H = 28;
const GRID_SIZE = 20;
const CARD_W = 100, CARD_H = 140; const PAD = GRID_SIZE; const GAP_X = GRID_SIZE; const GAP_Y = GRID_SIZE;
function snap(v:number) { return Math.round(v/GRID_SIZE)*GRID_SIZE; }

export function createGroupVisual(id:number,x:number,y:number,w=300,h=300): GroupVisual {
  const gfx = new PIXI.Graphics(); gfx.x=x; gfx.y=y; gfx.zIndex=1; gfx.eventMode='static';
  const header = new PIXI.Graphics(); header.eventMode='static'; header.cursor='move';
  const handle = new PIXI.Graphics(); handle.eventMode='static'; handle.cursor='nwse-resize';
  const label = new PIXI.Text({ text: `Group ${id}`, style:{ fill:0xffffff, fontSize:14 }});
  label.eventMode='none';
  const gv: GroupVisual = { id, gfx, items:new Set(), w, h, handle, header, label, name:`Group ${id}` };
  drawGroup(gv,false);
  gfx.addChild(handle); gfx.addChild(header); gfx.addChild(label);
  return gv;
}

export function drawGroup(gv: GroupVisual, selected:boolean) {
  const {gfx,w,h,handle,header,label} = gv;
  gfx.clear();
  gfx.roundRect(0,0,w,h,12).stroke({color: selected?0x33bbff:0x555555,width:selected?4:2}).fill({color:0x222222, alpha:0.25});
  handle.clear(); handle.rect(0,0,14,14).fill({color:0xffffff}).stroke({color:selected?0x33bbff:0x555555,width:1}); handle.x=w-14; handle.y=h-14;
  header.clear(); header.rect(0,0,w,HEADER_H).fill({color:selected?0x226688:0x333333}).stroke({color:selected?0x33bbff:0x555555,width:1}); header.hitArea = new PIXI.Rectangle(0,0,w,HEADER_H);
  label.text = gv.name; label.x=8; label.y=6;
}

export function layoutGroup(gv: GroupVisual, sprites: CardSprite[]) {
  const items = [...gv.items].map(id=> sprites.find(s=> s.__id===id)).filter(Boolean) as CardSprite[];
  if (!items.length) return;
  const usableW = Math.max(1, gv.w - PAD*2);
  const cols = Math.max(1, Math.floor((usableW + GAP_X) / (CARD_W + GAP_X)));
  items.forEach((s,i)=> {
    const col=i%cols; const row=Math.floor(i/cols);
    const tx = gv.gfx.x + PAD + col*(CARD_W+GAP_X);
    const ty = gv.gfx.y + HEADER_H + PAD + row*(CARD_H+GAP_Y);
    s.x = snap(tx); s.y = snap(ty);
  });
  const rows = Math.ceil(items.length/cols); const neededH = HEADER_H + PAD*2 + rows*CARD_H + (rows-1)*GAP_Y; if (neededH>gv.h) { gv.h = neededH; drawGroup(gv, SelectionStore.state.groupIds.has(gv.id)); }
}

export const HEADER_HEIGHT = HEADER_H;
