import { describe, expect, it } from "vitest";
import { snap } from "../snap";

describe("snap", () => {
  it("snaps to nearest GRID_SIZE multiple (default=8)", () => {
    expect(snap(0)).toBe(0);
    expect(snap(3)).toBe(0);
    expect(snap(4)).toBe(8); // midpoint rounds up with Math.round
    expect(snap(7)).toBe(8);
    expect(snap(12)).toBe(16);
    expect(snap(16)).toBe(16);
  });

  it("supports custom grid size", () => {
    expect(snap(13, 5)).toBe(15);
    expect(snap(12, 5)).toBe(10);
  });

  it("returns input for invalid values", () => {
    expect(snap(NaN)).toBe(NaN);
    expect(snap(10, NaN)).toBe(10);
    expect(snap(10, -1)).toBe(10);
    expect(snap(10, 0)).toBe(10);
  });
});
