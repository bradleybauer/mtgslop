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
  search(minX: number, minY: number, maxX: number, maxY: number) {
    return this.tree.search({ minX, minY, maxX, maxY });
  }
}
