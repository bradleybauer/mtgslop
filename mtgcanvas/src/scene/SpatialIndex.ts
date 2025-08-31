import RBush from "rbush";

export interface SpatialItem {
  id: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class SpatialIndex {
  private tree = new RBush<SpatialItem>();

  insert(item: SpatialItem) {
    this.tree.insert(item);
  }
  // Efficiently load many items at once
  bulkLoad(items: SpatialItem[]) {
    if (!items || !items.length) return;
    this.tree.load(items);
  }
  remove(id: number) {
    this.tree.remove(
      { id, minX: 0, minY: 0, maxX: 0, maxY: 0 } as SpatialItem,
      (a, b) => a.id === b.id,
    );
  }
  update(item: SpatialItem) {
    this.remove(item.id);
    this.insert(item);
  }
  // Update many items efficiently in one pass
  bulkUpdate(items: SpatialItem[]) {
    if (!items || !items.length) return;
    // Remove previous entries by id (custom equals compares ids)
    for (const it of items) this.remove(it.id);
    // Then bulk load the new bounds
    this.bulkLoad(items);
  }
  search(minX: number, minY: number, maxX: number, maxY: number) {
    return this.tree.search({ minX, minY, maxX, maxY });
  }
  count() {
    return (this.tree as any).all().length as number;
  }
  clear() {
    this.tree.clear();
  }
  // Nearest item center to a point, optionally within a radius
  nearest(x: number, y: number, radius = Infinity): SpatialItem | null {
    const r = Math.max(1, Number.isFinite(radius) ? radius : 1e9);
    const hits = this.search(x - r, y - r, x + r, y + r);
    if (!hits.length) return null;
    let best: SpatialItem | null = null;
    let bestD = Infinity;
    for (const h of hits) {
      const cx = (h.minX + h.maxX) / 2;
      const cy = (h.minY + h.maxY) / 2;
      const d = (cx - x) * (cx - x) + (cy - y) * (cy - y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }
}
