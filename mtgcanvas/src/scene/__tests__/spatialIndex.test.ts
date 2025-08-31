import { describe, it, expect } from 'vitest';
import { SpatialIndex } from '../SpatialIndex';

describe('SpatialIndex', () => {
  it('supports insert, search, count, clear and nearest', () => {
    const idx = new SpatialIndex();
    idx.insert({ id: 1, minX: 0, minY: 0, maxX: 10, maxY: 10 });
    idx.insert({ id: 2, minX: 100, minY: 100, maxX: 110, maxY: 110 });
    expect(idx.count()).toBe(2);
    const hits = idx.search(5, 5, 6, 6);
    expect(hits.some(h => h.id === 1)).toBe(true);
    const n = idx.nearest(102, 102, 20);
    expect(n && n.id).toBe(2);
    idx.clear();
    expect(idx.count()).toBe(0);
  });
});
