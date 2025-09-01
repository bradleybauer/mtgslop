// Generic keyed min-heap with in-place priority updates.
// Assumes items have 'priority' (number) and 'enqAt' (number) fields used for ordering.

export interface HasPriorityTime {
  priority: number;
  enqAt: number;
  // Consumers can include additional fields; key is derived via keyOf()
}

export class KeyedMinHeap<T extends HasPriorityTime> {
  private arr: T[] = [];
  private pos = new Map<string, number>(); // key -> index
  constructor(private keyOf: (item: T) => string) {}
  size() { return this.arr.length; }
  has(key: string) { return this.pos.has(key); }
  get(key: string): T | undefined {
    const i = this.pos.get(key);
    return i === undefined ? undefined : this.arr[i];
  }
  push(item: T) {
    const key = this.keyOf(item);
    const idx = this.arr.length;
    this.arr.push(item);
    this.pos.set(key, idx);
    this.siftUp(idx);
  }
  popMin(): T | undefined {
    if (!this.arr.length) return undefined;
    const min = this.arr[0];
    const last = this.arr.pop()!;
    this.pos.delete(this.keyOf(min));
    if (this.arr.length) {
      this.arr[0] = last;
      this.pos.set(this.keyOf(last), 0);
      this.siftDown(0);
    }
    return min;
  }
  updatePriority(key: string, newPrio: number): boolean {
    const i = this.pos.get(key);
    if (i === undefined) return false;
    const n = this.arr[i];
    if (n.priority === newPrio) return true;
    const old = n.priority;
    n.priority = newPrio;
    if (newPrio < old) this.siftUp(i);
    else this.siftDown(i);
    return true;
  }
  remove(key: string): T | undefined {
    const i = this.pos.get(key);
    if (i === undefined) return undefined;
    const rem = this.arr[i];
    const last = this.arr.pop()!;
    this.pos.delete(key);
    if (i < this.arr.length) {
      this.arr[i] = last;
      this.pos.set(this.keyOf(last), i);
      this.fix(i);
    }
    return rem;
  }
  private less(aIdx: number, bIdx: number) {
    const A = this.arr[aIdx], B = this.arr[bIdx];
    if (A.priority !== B.priority) return A.priority < B.priority;
    return A.enqAt <= B.enqAt;
  }
  private swap(a: number, b: number) {
    const va = this.arr[a], vb = this.arr[b];
    this.arr[a] = vb; this.arr[b] = va;
    this.pos.set(this.keyOf(va), b);
    this.pos.set(this.keyOf(vb), a);
  }
  private siftUp(i: number) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  private siftDown(i: number) {
    const n = this.arr.length;
    while (true) {
      let m = i;
      const l = (i << 1) + 1, r = l + 1;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
  private fix(i: number) {
    if (i > 0 && this.less(i, (i - 1) >> 1)) this.siftUp(i);
    else this.siftDown(i);
  }
}
