import { describe, it, expect } from 'vitest';
import { KeyedMinHeap } from '../keyedMinHeap';

type Item = { key: string; priority: number; enqAt: number };

describe('KeyedMinHeap', () => {
  it('pops items in priority then FIFO order', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    h.push({ key: 'a', priority: 5, enqAt: t0 });
    h.push({ key: 'b', priority: 1, enqAt: t0 + 1 });
    h.push({ key: 'c', priority: 1, enqAt: t0 + 2 });

    expect(h.popMin()!.key).toBe('b');
    expect(h.popMin()!.key).toBe('c');
    expect(h.popMin()!.key).toBe('a');
    expect(h.popMin()).toBeUndefined();
  });

  it('updates priority in place', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    h.push({ key: 'x', priority: 10, enqAt: t0 });
    h.push({ key: 'y', priority: 20, enqAt: t0 + 1 });
    h.updatePriority('y', 0);
    expect(h.popMin()!.key).toBe('y');
    expect(h.popMin()!.key).toBe('x');
  });

  it('removes arbitrary keys', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    h.push({ key: 'a', priority: 3, enqAt: t0 });
    h.push({ key: 'b', priority: 2, enqAt: t0 + 1 });
    h.push({ key: 'c', priority: 1, enqAt: t0 + 2 });
    const r = h.remove('b');
    expect(r!.key).toBe('b');
    expect(h.popMin()!.key).toBe('c');
    expect(h.popMin()!.key).toBe('a');
  });

  it('has/get/size behave as expected', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    expect(h.size()).toBe(0);
    expect(h.has('x')).toBe(false);
    h.push({ key: 'x', priority: 2, enqAt: t0 });
    h.push({ key: 'y', priority: 3, enqAt: t0 + 1 });
    h.push({ key: 'z', priority: 1, enqAt: t0 + 2 });
    expect(h.size()).toBe(3);
    expect(h.has('x')).toBe(true);
    expect(h.get('y')!.key).toBe('y');
    expect(h.popMin()!.key).toBe('z');
    expect(h.size()).toBe(2);
  });

  it('updatePriority returns false for missing keys and is a no-op when unchanged', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    h.push({ key: 'a', priority: 5, enqAt: t0 });
    h.push({ key: 'b', priority: 6, enqAt: t0 + 1 });
    expect(h.updatePriority('missing', 1)).toBe(false);
    // unchanged
    expect(h.updatePriority('a', 5)).toBe(true);
    // order should still be a then b
    expect(h.popMin()!.key).toBe('a');
    expect(h.popMin()!.key).toBe('b');
  });

  it('tie-breaks strictly by enqAt (earlier first) for equal priorities', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    h.push({ key: 'e1', priority: 2, enqAt: t0 });
    h.push({ key: 'e2', priority: 2, enqAt: t0 + 1000 });
    h.push({ key: 'e3', priority: 2, enqAt: t0 + 2000 });
    expect(h.popMin()!.key).toBe('e1');
    expect(h.popMin()!.key).toBe('e2');
    expect(h.popMin()!.key).toBe('e3');
  });

  it('remove missing returns undefined and preserves heap validity', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    h.push({ key: 'a', priority: 3, enqAt: t0 });
    h.push({ key: 'b', priority: 1, enqAt: t0 + 1 });
    h.push({ key: 'c', priority: 2, enqAt: t0 + 2 });
    expect(h.remove('nope')).toBeUndefined();
    // Should still pop b, c, a
    expect(h.popMin()!.key).toBe('b');
    expect(h.popMin()!.key).toBe('c');
    expect(h.popMin()!.key).toBe('a');
  });

  it('can reinsert a key after removal', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    h.push({ key: 'a', priority: 5, enqAt: t0 });
    h.push({ key: 'b', priority: 1, enqAt: t0 + 1 });
    h.remove('b');
    h.push({ key: 'b', priority: 0, enqAt: t0 + 2 });
    expect(h.popMin()!.key).toBe('b');
    expect(h.popMin()!.key).toBe('a');
  });

  it('multiple priority updates move items across the heap', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    const t0 = performance.now();
    h.push({ key: 'a', priority: 10, enqAt: t0 });
    h.push({ key: 'b', priority: 20, enqAt: t0 + 1 });
    h.push({ key: 'c', priority: 30, enqAt: t0 + 2 });
    // Make c highest priority
    h.updatePriority('c', -1);
    expect(h.popMin()!.key).toBe('c');
    // Now lower b below a
    h.updatePriority('b', 0);
    expect(h.popMin()!.key).toBe('b');
    expect(h.popMin()!.key).toBe('a');
  });

  it('popMin on empty heap returns undefined and does not throw', () => {
    const h = new KeyedMinHeap<Item>((i) => i.key);
    expect(h.popMin()).toBeUndefined();
    expect(h.size()).toBe(0);
  });
});
