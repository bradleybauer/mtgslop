import * as PIXI from 'pixi.js';

export interface CameraOptions {
  world: PIXI.Container;
  minScale?: number; maxScale?: number;
}

export class Camera {
  world: PIXI.Container;
  minScale: number; maxScale: number;
  private anim?: { t:number; duration:number; from:{x:number,y:number,scale:number}; to:{x:number,y:number,scale:number}; cb?:()=>void };
  constructor(opts: CameraOptions) {
    this.world = opts.world;
  this.minScale = opts.minScale ?? 0.05;
  this.maxScale = opts.maxScale ?? 10; // increased max zoom
  }
  zoomAt(factor:number, center: PIXI.Point) {
    const prev = this.world.scale.x;
    let next = prev * factor; next = Math.min(this.maxScale, Math.max(this.minScale, next));
    factor = next / prev;
    const before = this.world.toLocal(center);
    this.world.scale.set(next);
    const after = this.world.toLocal(center);
    this.world.position.x += (after.x - before.x) * this.world.scale.x;
    this.world.position.y += (after.y - before.y) * this.world.scale.y;
  }
  fitBounds(b:{x:number,y:number,w:number,h:number}|null, viewport:{w:number,h:number}, margin=40) {
    if (!b) return;
    const vw = viewport.w - margin*2; const vh = viewport.h - margin*2;
    const sx = vw / b.w; const sy = vh / b.h; const s = Math.min(this.maxScale, Math.max(this.minScale, Math.min(sx, sy)));
    this.world.scale.set(s);
    this.world.position.x = (viewport.w/2) - (b.x + b.w/2)*s;
    this.world.position.y = (viewport.h/2) - (b.y + b.h/2)*s;
  }
  get scale() { return this.world.scale.x; }
  animateTo(target: {x:number,y:number,scale?:number} | {bounds:{x:number,y:number,w:number,h:number}; viewport:{w:number,h:number}; margin?:number}, duration=250, cb?:()=>void) {
    let tx=0, ty=0, ts=this.world.scale.x;
    if ('bounds' in target) {
      const {bounds, viewport, margin=40} = target as any;
      const vw = viewport.w - margin*2; const vh = viewport.h - margin*2;
      const sx = vw / bounds.w; const sy = vh / bounds.h; ts = Math.min(this.maxScale, Math.max(this.minScale, Math.min(sx, sy)));
      tx = (viewport.w/2) - (bounds.x + bounds.w/2)*ts;
      ty = (viewport.h/2) - (bounds.y + bounds.h/2)*ts;
    } else { tx = target.x; ty = target.y; if (target.scale) ts = target.scale; }
    this.anim = { t:0, duration, from:{x:this.world.position.x,y:this.world.position.y,scale:this.world.scale.x}, to:{x:tx,y:ty,scale:ts}, cb };
  }
  update(dtMs:number) {
    if (!this.anim) return; const a=this.anim; a.t += dtMs; const p=Math.min(1, a.t/a.duration); const ease = p<0.5? 2*p*p : -1 + (4 - 2*p)*p; this.world.position.x = a.from.x + (a.to.x - a.from.x)*ease; this.world.position.y = a.from.y + (a.to.y - a.from.y)*ease; const sc = a.from.scale + (a.to.scale - a.from.scale)*ease; this.world.scale.set(sc); if (p>=1) { const cb=a.cb; this.anim=undefined; cb && cb(); }
  }
}
