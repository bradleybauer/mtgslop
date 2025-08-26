import * as PIXI from 'pixi.js';
import type { CardSprite } from '../scene/cardNode';
import { SelectionStore } from '../state/selectionStore';

interface MarqueeState { start: PIXI.Point; rect: PIXI.Graphics; additive: boolean; }
type QueryFn = (rect:{x:number,y:number,w:number,h:number})=>CardSprite[];

export class MarqueeSystem {
  private state: MarqueeState | null = null;
  constructor(private world: PIXI.Container, private stage: PIXI.Container, private getSprites: ()=>CardSprite[], private query?: QueryFn) {}
  start(globalPoint: PIXI.PointData, additive:boolean) {
    const ws = this.world.toLocal(globalPoint);
    const rect = new PIXI.Graphics();
    this.world.addChild(rect);
  (rect as any).__lastRect = {x:ws.x,y:ws.y,w:0,h:0};
  this.state = { start: new PIXI.Point(ws.x, ws.y), rect, additive };
  }
  update(globalPoint: PIXI.PointData) {
    if (!this.state) return; const cur = this.world.toLocal(globalPoint);
    const x1=this.state.start.x,y1=this.state.start.y,x2=cur.x,y2=cur.y; const rx=Math.min(x1,x2), ry=Math.min(y1,y2), rw=Math.abs(x2-x1), rh=Math.abs(y2-y1);
    const g = this.state.rect; g.clear(); g.rect(rx,ry,rw,rh).fill({color:0x0088ff, alpha:0.08}).stroke({color:0x00aaff,width:1,alpha:0.9}); (g as any).__lastRect = {x:rx,y:ry,w:rw,h:rh};
  }
  finish() {
  if (!this.state) return; const g = this.state.rect; const additive = this.state.additive; const data = (g as any).__lastRect; g.destroy(); this.state=null; if (!data) return; let candidates: CardSprite[];
    if (this.query) { candidates = this.query({x:data.x,y:data.y,w:data.w,h:data.h}); }
    else { const sprites = this.getSprites(); candidates = sprites.filter(s=> (s.x+100)>=data.x && s.x <= data.x+data.w && (s.y+140)>=data.y && s.y <= data.y+data.h); }
    const selected = candidates.map(s=> s.__id);
    if (additive) { const next=new Set(SelectionStore.getCards()); selected.forEach(id=> next.add(id)); SelectionStore.replace({ cardIds: next, groupIds: new Set(SelectionStore.getGroups()) }); } else { SelectionStore.replace({ cardIds: new Set(selected), groupIds: new Set() }); }
  }
  isActive() { return !!this.state; }
}
