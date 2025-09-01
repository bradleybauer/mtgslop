import { describe, it, expect } from "vitest";
import { MinMaxHeap } from "../minMaxHeap";

function drainMin<T>(h: MinMaxHeap<T>): T[] {
  const out: T[] = [];
  while (!h.isEmpty()) {
    const v = h.popMin();
    if (v !== undefined) out.push(v as T);
  }
  return out;
}

function drainMax<T>(h: MinMaxHeap<T>): T[] {
  const out: T[] = [];
  while (!h.isEmpty()) {
    const v = h.popMax();
    if (v !== undefined) out.push(v as T);
  }
  return out;
}

describe("MinMaxHeap basics", () => {
  it("push/popMin orders by ascending priority", () => {
    const h = new MinMaxHeap<number>();
    h.push(1, 10);
    h.push(2, -5);
    h.push(3, 0);
    h.push(4, -5);
    expect(h.size()).toBe(4);
    // lower numeric priority first; -5, -5, 0, 10
    expect(h.popMin()).toBe(2);
    expect(h.popMin()).toBe(4);
    expect(h.popMin()).toBe(3);
    expect(h.popMin()).toBe(1);
    expect(h.isEmpty()).toBe(true);
  });

  it("popMax returns highest numeric priority first", () => {
    const h = new MinMaxHeap<string>();
    h.push("a", 1);
    h.push("b", 10);
    h.push("c", -3);
    expect(h.popMax()).toBe("b");
    expect(h.popMax()).toBe("a");
    expect(h.popMax()).toBe("c");
    expect(h.popMax()).toBeUndefined();
  });

  it("stability for equal priorities (FIFO by insertion)", () => {
    const h = new MinMaxHeap<string>();
    h.push("x1", 5);
    h.push("x2", 5);
    h.push("x3", 5);
    expect(h.popMin()).toBe("x1");
    expect(h.popMin()).toBe("x2");
    expect(h.popMin()).toBe("x3");
    h.push("y1", 0);
    h.push("y2", 0);
    h.push("y3", 0);
    expect(h.popMax()).toBe("y3");
    expect(h.popMax()).toBe("y2");
    expect(h.popMax()).toBe("y1");
  });
});

describe("MinMaxHeap integration patterns", () => {
  it("mixed popMin/popMax interleaving maintains invariants", () => {
    const h = new MinMaxHeap<number>();
    for (let i = 0; i < 10; i++) h.push(i, i - 5); // priorities -5..4; best are values 0,1,2...
    // pop best three
    expect(h.popMin()).toBe(0); // prio -5
    expect(h.popMin()).toBe(1); // -4
    expect(h.popMin()).toBe(2); // -3
    // push some new ones
    h.push(100, -10);
    h.push(200, 99);
    // pop worst one
    expect(h.popMax()).toBe(200);
    // then best
    expect(h.popMin()).toBe(100);
    // remaining size sanity: 10 start, -3 (popMin thrice), +2 pushes, -1 popMax, -1 popMin => 7
    expect(h.size()).toBe(7);
  });

  it("forEachAlive sees only live values", () => {
    const h = new MinMaxHeap<number>();
    h.push(1, 10);
    h.push(2, 0);
    h.push(3, -1);
    h.popMin(); // removes 3
    h.popMax(); // removes 1
    const seen: number[] = [];
    h.forEachAlive((v) => seen.push(v));
    expect(seen.sort((a, b) => a - b)).toEqual([2]);
  });

  it("handles many inserts and drains in order", () => {
    const h = new MinMaxHeap<number>();
    const N = 1000;
    const vals: Array<{ v: number; p: number }> = [];
    for (let i = 0; i < N; i++) {
      const p = (Math.sin(i) * 100) | 0;
      vals.push({ v: i, p });
      h.push(i, p);
    }
    // Asc drain should be sorted by priority then FIFO
    const ascHeap = new MinMaxHeap<number>();
    for (const { v, p } of vals) ascHeap.push(v, p);
    const asc = drainMin(ascHeap);
    // Rebuild for desc drain
    const h2 = new MinMaxHeap<number>();
    for (const { v, p } of vals) h2.push(v, p);
    const desc = drainMax(h2);
    expect(asc.length).toBe(N);
    expect(desc.length).toBe(N);
    // Sanity: extremes
    const minP = Math.min(...vals.map((x) => x.p));
    const maxP = Math.max(...vals.map((x) => x.p));
    const minIdx = vals.findIndex((x) => x.p === minP);
    // With LIFO tie-break for max ties, expect the last inserted among max priority
    const maxIdx =
      vals.length - 1 - [...vals].reverse().findIndex((x) => x.p === maxP);
    const h3 = new MinMaxHeap<number>();
    for (const { v, p } of vals) h3.push(v, p);
    expect(h3.popMin()).toBe(vals[minIdx].v);
    expect(h3.popMax()).toBe(vals[maxIdx].v);
  });
});
