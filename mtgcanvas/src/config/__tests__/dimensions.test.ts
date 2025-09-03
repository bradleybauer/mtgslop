import { describe, expect, it } from "vitest";
import {
  GRID_SIZE,
  CARD_W,
  CARD_H,
  GAP_X,
  GAP_Y,
  SPACING_X,
  SPACING_Y,
} from "../dimensions";

describe("dimensions", () => {
  it("matches legacy values and relationships", () => {
    expect(GRID_SIZE).toBe(8);
    expect(CARD_W).toBe(100);
    expect(CARD_H).toBe(140);
    expect(GAP_X).toBe(4);
    expect(GAP_Y).toBe(4);
    expect(SPACING_X).toBe(CARD_W + GAP_X);
    expect(SPACING_Y).toBe(CARD_H + GAP_Y);
    // grid alignment invariants
    expect((CARD_W + GAP_X) % GRID_SIZE).toBe(0);
    expect((CARD_H + GAP_Y) % GRID_SIZE).toBe(0);
  });
});
