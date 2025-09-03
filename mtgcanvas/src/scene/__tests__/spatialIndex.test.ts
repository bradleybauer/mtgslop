import { describe, it, expect } from "vitest";
import { SpatialIndex } from "../SpatialIndex";
import type { CardSprite } from "../../scene/cardNode";

describe("SpatialIndex", () => {
  it("supports insert, search, count, clear and nearest", () => {
    const idx = new SpatialIndex();
    const s1 = { __id: 1 } as unknown as CardSprite;
    const s2 = { __id: 2 } as unknown as CardSprite;
    idx.insert({ sprite: s1, minX: 0, minY: 0, maxX: 10, maxY: 10 });
    idx.insert({ sprite: s2, minX: 100, minY: 100, maxX: 110, maxY: 110 });
    expect(idx.count()).toBe(2);
    const hits = idx.search(5, 5, 6, 6);
    expect(hits.some((h) => h.sprite === s1)).toBe(true);
    const n = idx.nearest(102, 102, 20);
    expect(n && n.sprite === s2).toBe(true);
    idx.clear();
    expect(idx.count()).toBe(0);
  });
});
