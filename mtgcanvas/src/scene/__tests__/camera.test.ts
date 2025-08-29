import { describe, expect, it } from "vitest";
import * as PIXI from "pixi.js";
import { Camera } from "../camera";

describe("Camera", () => {
  it("zooms around center without throwing", () => {
    const world = new PIXI.Container();
    const cam = new Camera({ world });
    const before = {
      x: world.position.x,
      y: world.position.y,
      s: world.scale.x,
    };
    cam.zoomAt(1.2, new PIXI.Point(100, 100));
    // scale should stay within bounds and not be NaN
    expect(world.scale.x).toBeGreaterThan(0);
    // ensure changed or same but valid
    expect(Number.isFinite(world.position.x)).toBe(true);
    expect(Number.isFinite(world.position.y)).toBe(true);
    // calling update should not throw (inertial step)
    cam.update(16);
    expect(world.scale.x).toBeGreaterThan(0);
    // revert by zooming out
    cam.zoomAt(1 / 1.2, new PIXI.Point(100, 100));
    expect(Number.isFinite(world.scale.x)).toBe(true);
    // ensure previous state roughly recoverable bounds
    expect(world.scale.x).toBeGreaterThan(0);
    expect(Math.abs(world.scale.x - before.s)).toBeLessThan(1);
  });
});
