// Generic Min–Max Heap with lazy deletion via alive set.
// - push(value, priority): O(log n)
// - popMin/popMax: O(log n)
// - size/isEmpty: O(1)
// - forEachAlive: iterate current live values

type HeapNode<T> = { id: number; priority: number; seq: number; value: T };

class BinHeap<N> {
  private a: N[] = [];
  constructor(private cmp: (x: N, y: N) => number) {}
  size() {
    return this.a.length;
  }
  push(v: N) {
    const a = this.a;
    a.push(v);
    this.up(a.length - 1);
  }
  pop(): N | undefined {
    const a = this.a;
    const n = a.length;
    if (!n) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (n > 1) {
      a[0] = last;
      this.down(0);
    }
    return top;
  }
  private up(i: number) {
    const a = this.a;
    const v = a[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      const pv = a[p];
      if (this.cmp(v, pv) >= 0) break;
      a[i] = pv;
      i = p;
    }
    a[i] = v;
  }
  private down(i: number) {
    const a = this.a;
    const n = a.length;
    const v = a[i];
    while (true) {
      let l = i * 2 + 1;
      if (l >= n) break;
      let r = l + 1;
      let c = l;
      if (r < n && this.cmp(a[r], a[l]) < 0) c = r;
      if (this.cmp(a[c], v) >= 0) break;
      a[i] = a[c];
      i = c;
    }
    a[i] = v;
  }
}

export class MinMaxHeap<T> {
  private min: BinHeap<HeapNode<T>>;
  private max: BinHeap<HeapNode<T>>;
  private alive = new Set<number>();
  private items = new Map<number, HeapNode<T>>();
  private nextId = 1;
  private seq = 1;
  constructor() {
    // Lower numeric priority is better (min side). FIFO on ties via seq.
    this.min = new BinHeap<HeapNode<T>>((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.seq - b.seq;
    });
    // Max side: higher numeric priority first; for equal priority prefer newest (LIFO) to drop latest when using popMax for overflow.
    this.max = new BinHeap<HeapNode<T>>((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.seq - a.seq; // newer first on ties
    });
  }
  size(): number {
    return this.alive.size;
  }
  isEmpty(): boolean {
    return this.alive.size === 0;
  }
  push(value: T, priority: number) {
    const node: HeapNode<T> = {
      id: this.nextId++,
      priority: Number(priority) || 0,
      seq: this.seq++,
      value,
    };
    this.alive.add(node.id);
    this.items.set(node.id, node);
    this.min.push(node);
    this.max.push(node);
  }
  private popFrom(h: BinHeap<HeapNode<T>>): T | undefined {
    while (true) {
      const n = h.pop();
      if (!n) return undefined;
      if (this.alive.has(n.id)) {
        this.alive.delete(n.id);
        this.items.delete(n.id);
        return n.value;
      }
      // Stale entry, skip
    }
  }
  popMin(): T | undefined {
    return this.popFrom(this.min);
  }
  popMax(): T | undefined {
    return this.popFrom(this.max);
  }
  forEachAlive(fn: (v: T) => void) {
    this.items.forEach((n) => fn(n.value));
  }
}
