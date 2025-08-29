import type { CardSprite } from "./cardNode";
import * as PIXI from "pixi.js";

/**
 * Simple view-based culling. Expand later with spatial index integration.
 */
export class CullingSystem {
  constructor(
    private world: PIXI.Container,
    private getCards: () => CardSprite[],
  ) {}
  update() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 200; // slack to reduce popping
    const scale = this.world.scale.x;
    const inv = 1 / scale;
    const left = -this.world.position.x * inv - margin;
    const top = -this.world.position.y * inv - margin;
    const right = left + vw * inv + margin * 2;
    const bottom = top + vh * inv + margin * 2;
    const now = performance.now();
    for (const s of this.getCards()) {
      const vis =
        s.x + 100 >= left && s.x <= right && s.y + 140 >= top && s.y <= bottom;
      if (vis !== s.visible) {
        s.visible = vis;
        s.renderable = vis;
        const anyS: any = s as any;
        if (!vis) anyS.__hiddenAt = now;
        else if (anyS.__hiddenAt) anyS.__hiddenAt = undefined;
      }
    }
  }
}
