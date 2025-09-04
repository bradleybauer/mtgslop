import type * as PIXI from "pixi.js";
import type { Rect } from "../types/geometry";

export interface CameraOptions {
  world: PIXI.Container;
  minScale?: number;
  maxScale?: number;
  // Optional pan momentum tuning
  frictionTauMs?: number; // time constant for exponential velocity decay
  frictionTauActiveMs?: number; // stronger decay while mouse is down (dragging)
  velocitySmoothing?: number; // 0..1 blend factor for velocity averaging while dragging
  maxSpeedClamp?: number; // px/sec clamp for extreme flicks
}

export class Camera {
  world: PIXI.Container;
  minScale: number;
  maxScale: number;
  private anim?: {
    t: number;
    duration: number;
    from: { x: number; y: number; scale: number };
    to: { x: number; y: number; scale: number };
    cb?: () => void;
  };
  // Inertial pan state (screen-space, independent of zoom)
  private panActive = false;
  private lastPanTs = 0;
  private vx = 0; // px/sec
  private vy = 0; // px/sec
  // Configurable momentum params
  private frictionTauMs = 420; // exponential decay time constant (larger = longer glide)
  private frictionTauActiveMs = 140; // faster decay while mouse is down (significantly shorter glide)
  private velocitySmoothing = 0.22; // 0..1, how much to trust latest sample when dragging
  // External glide threshold now defaults to 0 to avoid abrupt halts; we still use a tiny
  // internal epsilon to eventually settle to exact zero to avoid infinite subpixel drift.
  private maxSpeedClamp = 4800; // px/sec, clamp extreme flicks
  private worldBounds?: Rect;
  private clampFrac = 0.75; // fraction of viewport kept within bounds (centered)
  constructor(opts: CameraOptions) {
    this.world = opts.world;
    this.minScale = opts.minScale ?? 0.05;
    this.maxScale = opts.maxScale ?? 13; // increased max zoom per request
    if (typeof opts.frictionTauMs === "number")
      this.frictionTauMs = Math.max(50, opts.frictionTauMs);
    if (typeof opts.frictionTauActiveMs === "number")
      this.frictionTauActiveMs = Math.max(30, opts.frictionTauActiveMs);
    if (typeof opts.velocitySmoothing === "number")
      this.velocitySmoothing = Math.min(
        0.9,
        Math.max(0.05, opts.velocitySmoothing),
      );
    if (typeof opts.maxSpeedClamp === "number")
      this.maxSpeedClamp = Math.max(100, opts.maxSpeedClamp);
  }
  setClampFraction(f: number) {
    if (!isFinite(f) || f <= 0 || f > 1) return;
    this.clampFrac = f;
    this.clampToBounds();
  }
  setWorldBounds(b: Rect | null) {
    this.worldBounds = b || undefined;
    // Dynamically allow zooming out enough to see the full bounds and a bit more (~10%)
    if (this.worldBounds) {
      const vw = (globalThis as any).innerWidth || 0;
      const vh = (globalThis as any).innerHeight || 0;
      if (vw > 0 && vh > 0) {
        const sFitW = vw / this.worldBounds.w;
        const sFitH = vh / this.worldBounds.h;
        const sMinSeeAll = Math.min(sFitW, sFitH) * 0.9; // 10% extra beyond edges
        if (isFinite(sMinSeeAll) && sMinSeeAll > 0)
          this.minScale = Math.min(this.minScale, sMinSeeAll);
      }
    }
    // Clamp immediately to new bounds
    this.clampToBounds();
  }
  private clampToBounds() {
    if (!this.worldBounds) return;
    const vw = (globalThis as any).innerWidth || 0;
    const vh = (globalThis as any).innerHeight || 0;
    if (!vw || !vh) return;
    const s = this.world.scale.x || 1;
    const b = this.worldBounds;
    // Axis-aware fit: if an axis fully fits, lock that axis to center; allow clamped panning on the other
    const viewWWorld = vw / s;
    const viewHWorld = vh / s;
    const centerPosX = vw / 2 - (b.x + b.w / 2) * s;
    const centerPosY = vh / 2 - (b.y + b.h / 2) * s;
    const fitX = viewWWorld >= b.w;
    const fitY = viewHWorld >= b.h;
    // Effective centered viewport region that must remain inside bounds
    const effVw = Math.max(1, vw * this.clampFrac);
    const effVh = Math.max(1, vh * this.clampFrac);
    const effWWorld = effVw / s;
    const effHWorld = effVh / s;
    // Allowed world center range
    const minWorldCenterX = b.x + effWWorld / 2;
    const maxWorldCenterX = b.x + b.w - effWWorld / 2;
    const minWorldCenterY = b.y + effHWorld / 2;
    const maxWorldCenterY = b.y + b.h - effHWorld / 2;
    // If effective viewport exceeds bounds, lock to bounds center to prevent jitter
    // X axis
    if (fitX || minWorldCenterX > maxWorldCenterX) {
      this.world.position.x = centerPosX;
    } else {
      const minPosX = vw / 2 - maxWorldCenterX * s;
      const maxPosX = vw / 2 - minWorldCenterX * s;
      if (this.world.position.x < minPosX) this.world.position.x = minPosX;
      else if (this.world.position.x > maxPosX) this.world.position.x = maxPosX;
    }
    // Y axis
    if (fitY || minWorldCenterY > maxWorldCenterY) {
      this.world.position.y = centerPosY;
    } else {
      const minPosY = vh / 2 - maxWorldCenterY * s;
      const maxPosY = vh / 2 - minWorldCenterY * s;
      if (this.world.position.y < minPosY) this.world.position.y = minPosY;
      else if (this.world.position.y > maxPosY) this.world.position.y = maxPosY;
    }
  }
  zoomAt(factor: number, center: PIXI.Point) {
    const prev = this.world.scale.x;
    let next = prev * factor;
    next = Math.min(this.maxScale, Math.max(this.minScale, next));
    factor = next / prev;
    const before = this.world.toLocal(center);
    this.world.scale.set(next);
    const after = this.world.toLocal(center);
    this.world.position.x += (after.x - before.x) * this.world.scale.x;
    this.world.position.y += (after.y - before.y) * this.world.scale.y;
    this.clampToBounds();
  }
  fitBounds(b: Rect | null, viewport: { w: number; h: number }, margin = 40) {
    if (!b) return;
    const vw = viewport.w - margin * 2;
    const vh = viewport.h - margin * 2;
    const sx = vw / b.w;
    const sy = vh / b.h;
    const s = Math.min(
      this.maxScale,
      Math.max(this.minScale, Math.min(sx, sy)),
    );
    this.world.scale.set(s);
    this.world.position.x = viewport.w / 2 - (b.x + b.w / 2) * s;
    this.world.position.y = viewport.h / 2 - (b.y + b.h / 2) * s;
    this.clampToBounds();
  }
  get scale() {
    return this.world.scale.x;
  }
  animateTo(
    target:
      | { x: number; y: number; scale?: number }
      | {
          bounds: Rect;
          viewport: { w: number; h: number };
          margin?: number;
        },
    duration = 250,
    cb?: () => void,
  ) {
    let tx = 0,
      ty = 0,
      ts = this.world.scale.x;
    if ("bounds" in target) {
      const { bounds, viewport, margin = 40 } = target as any;
      const vw = viewport.w - margin * 2;
      const vh = viewport.h - margin * 2;
      const sx = vw / bounds.w;
      const sy = vh / bounds.h;
      ts = Math.min(this.maxScale, Math.max(this.minScale, Math.min(sx, sy)));
      tx = viewport.w / 2 - (bounds.x + bounds.w / 2) * ts;
      ty = viewport.h / 2 - (bounds.y + bounds.h / 2) * ts;
    } else {
      tx = target.x;
      ty = target.y;
      if (target.scale) ts = target.scale;
    }
    this.anim = {
      t: 0,
      duration,
      from: {
        x: this.world.position.x,
        y: this.world.position.y,
        scale: this.world.scale.x,
      },
      to: { x: tx, y: ty, scale: ts },
      cb,
    };
    // Cancel any ongoing inertial motion when starting an explicit animation
    this.vx = 0;
    this.vy = 0;
    this.panActive = false;
  }
  // External pan API used by interaction layer
  startPan(nowMs?: number) {
    this.panActive = true;
    this.lastPanTs = nowMs ?? performance.now();
    this.vx = 0;
    this.vy = 0;
    /* cancel camera animation */ this.anim = undefined;
  }
  panBy(dx: number, dy: number, nowMs?: number) {
    // Move world in screen-space
    this.world.position.x += dx;
    this.world.position.y += dy;
    // Update velocity estimate during active drag
    const now = nowMs ?? performance.now();
    if (this.panActive) {
      const dt = Math.max(1, now - this.lastPanTs); // ms, avoid divide by zero
      const instVx = (dx / dt) * 1000; // px/sec
      const instVy = (dy / dt) * 1000;
      const a = this.velocitySmoothing;
      this.vx = this.clampSpeed(instVx * a + this.vx * (1 - a));
      this.vy = this.clampSpeed(instVy * a + this.vy * (1 - a));
      this.lastPanTs = now;
    }
  }
  endPan() {
    // Stop active sampling; keep current velocity for inertial glide without abrupt cutoff.
    this.panActive = false;
  }
  // Immediately halt inertial movement without changing panActive state
  stopMomentum() {
    this.vx = 0;
    this.vy = 0;
  }
  private clampSpeed(v: number) {
    const m = this.maxSpeedClamp;
    return v > m ? m : v < -m ? -m : v;
  }
  update(dtMs: number) {
    // Ongoing camera animation
    if (this.anim) {
      const a = this.anim;
      a.t += dtMs;
      const p = Math.min(1, a.t / a.duration);
      const ease = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
      this.world.position.x = a.from.x + (a.to.x - a.from.x) * ease;
      this.world.position.y = a.from.y + (a.to.y - a.from.y) * ease;
      const sc = a.from.scale + (a.to.scale - a.from.scale) * ease;
      this.world.scale.set(sc);
      this.clampToBounds();
      if (p >= 1) {
        const cb = a.cb;
        this.anim = undefined;
        cb && cb();
      }
    }
    const speed = Math.hypot(this.vx, this.vy);
    // Inertial glide when not actively panning and no animation target for position.
    // Allow gliding at any non-zero speed. Decay below will naturally bring it to rest.
    if (!this.panActive && !this.anim && speed > 0) {
      const dtSec = dtMs / 1000;
      this.world.position.x += this.vx * dtSec;
      this.world.position.y += this.vy * dtSec;
    }
    // Always decay stored velocity each frame (so holding still while pressed bleeds speed)
    if (this.vx !== 0 || this.vy !== 0) {
      const tau = this.panActive
        ? this.frictionTauActiveMs
        : this.frictionTauMs;
      const decay = Math.exp(-dtMs / tau);
      this.vx *= decay;
      this.vy *= decay;
      // Tiny epsilon settle to fully stop after decay becomes imperceptible
      if (Math.hypot(this.vx, this.vy) < 0.02) {
        this.vx = 0;
        this.vy = 0;
      }
    }
    // Enforce bounds after movement each tick
    this.clampToBounds();
  }

  // Public helpers for UI logic
  getSpeed(): number {
    return Math.hypot(this.vx, this.vy);
  }
  isPanning(): boolean {
    return this.panActive;
  }
  isAnimating(): boolean {
    return !!this.anim;
  }
}
