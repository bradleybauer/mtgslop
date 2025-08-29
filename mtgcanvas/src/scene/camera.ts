import * as PIXI from 'pixi.js';

export interface CameraOptions {
  world: PIXI.Container;
  minScale?: number; maxScale?: number;
  // Optional pan momentum tuning
  frictionTauMs?: number;        // time constant for exponential velocity decay
  frictionTauActiveMs?: number;  // stronger decay while mouse is down (dragging)
  velocitySmoothing?: number;    // 0..1 blend factor for velocity averaging while dragging
  minSpeedToGlide?: number;      // px/sec threshold to start/continue glide
  maxSpeedClamp?: number;        // px/sec clamp for extreme flicks
}

export class Camera {
  world: PIXI.Container;
  minScale: number; maxScale: number;
  private anim?: { t:number; duration:number; from:{x:number,y:number,scale:number}; to:{x:number,y:number,scale:number}; cb?:()=>void };
  // Inertial pan state (screen-space, independent of zoom)
  private panActive = false;
  private lastPanTs = 0;
  private vx = 0; // px/sec
  private vy = 0; // px/sec
  // Configurable momentum params
  private frictionTauMs = 420;     // exponential decay time constant (larger = longer glide)
  private frictionTauActiveMs = 140; // faster decay while mouse is down (significantly shorter glide)
  private velocitySmoothing = 0.22; // 0..1, how much to trust latest sample when dragging
  private minSpeedToGlide = 22;    // px/sec, below this we stop
  private maxSpeedClamp = 4800;    // px/sec, clamp extreme flicks
  constructor(opts: CameraOptions) {
    this.world = opts.world;
  this.minScale = opts.minScale ?? 0.05;
  this.maxScale = opts.maxScale ?? 13; // increased max zoom per request
  if (typeof opts.frictionTauMs === 'number') this.frictionTauMs = Math.max(50, opts.frictionTauMs);
  if (typeof opts.frictionTauActiveMs === 'number') this.frictionTauActiveMs = Math.max(30, opts.frictionTauActiveMs);
  if (typeof opts.velocitySmoothing === 'number') this.velocitySmoothing = Math.min(0.9, Math.max(0.05, opts.velocitySmoothing));
  if (typeof opts.minSpeedToGlide === 'number') this.minSpeedToGlide = Math.max(0, opts.minSpeedToGlide);
  if (typeof opts.maxSpeedClamp === 'number') this.maxSpeedClamp = Math.max(100, opts.maxSpeedClamp);
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
    // Cancel any ongoing inertial motion when starting an explicit animation
    this.vx = 0; this.vy = 0; this.panActive = false;
  }
  // External pan API used by interaction layer
  startPan(nowMs?:number){ this.panActive = true; this.lastPanTs = nowMs ?? performance.now(); this.vx = 0; this.vy = 0; /* cancel camera animation */ this.anim = undefined; }
  panBy(dx:number, dy:number, nowMs?:number){
    // Move world in screen-space
    this.world.position.x += dx; this.world.position.y += dy;
    // Update velocity estimate during active drag
    const now = nowMs ?? performance.now();
    if (this.panActive) {
      const dt = Math.max(1, now - this.lastPanTs); // ms, avoid divide by zero
      const instVx = (dx / dt) * 1000; // px/sec
      const instVy = (dy / dt) * 1000;
      const a = this.velocitySmoothing;
      this.vx = this.clampSpeed(instVx*a + this.vx*(1-a));
      this.vy = this.clampSpeed(instVy*a + this.vy*(1-a));
      this.lastPanTs = now;
    }
  }
  endPan(){ this.panActive = false; /* if below threshold, drop to zero */ if (Math.hypot(this.vx, this.vy) < this.minSpeedToGlide) { this.vx=0; this.vy=0; } }
  // Immediately halt inertial movement without changing panActive state
  stopMomentum(){ this.vx = 0; this.vy = 0; }
  private clampSpeed(v:number){ const m=this.maxSpeedClamp; return v>m? m : v<-m? -m : v; }
  update(dtMs:number) {
    // Ongoing camera animation
    if (this.anim) { const a=this.anim; a.t += dtMs; const p=Math.min(1, a.t/a.duration); const ease = p<0.5? 2*p*p : -1 + (4 - 2*p)*p; this.world.position.x = a.from.x + (a.to.x - a.from.x)*ease; this.world.position.y = a.from.y + (a.to.y - a.from.y)*ease; const sc = a.from.scale + (a.to.scale - a.from.scale)*ease; this.world.scale.set(sc); if (p>=1) { const cb=a.cb; this.anim=undefined; cb && cb(); } }
    const speed = Math.hypot(this.vx, this.vy);
    // Inertial glide when not actively panning and no animation target for position
    if (!this.panActive && !this.anim && speed >= this.minSpeedToGlide) {
      const dtSec = dtMs / 1000;
      this.world.position.x += this.vx * dtSec;
      this.world.position.y += this.vy * dtSec;
    }
    // Always decay stored velocity each frame (so holding still while pressed bleeds speed)
    if (this.vx !== 0 || this.vy !== 0) {
      const tau = this.panActive ? this.frictionTauActiveMs : this.frictionTauMs;
      const decay = Math.exp(-dtMs / tau);
      this.vx *= decay; this.vy *= decay;
      if (Math.hypot(this.vx, this.vy) < this.minSpeedToGlide) { this.vx=0; this.vy=0; }
    }
  }
}
