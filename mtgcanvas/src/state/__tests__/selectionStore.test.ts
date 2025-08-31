import { describe, it, expect } from 'vitest';
import { createSelectionStore } from '../selectionStore';

describe('SelectionStore', () => {
  it('toggles and clears selections', () => {
    const s = createSelectionStore();
    s.toggleCard(1);
    s.toggleCard(2);
    expect(new Set(s.getCards())).toEqual(new Set([1, 2]));
    s.toggleCard(1);
    expect(new Set(s.getCards())).toEqual(new Set([2]));
    s.clear();
    expect(s.isEmpty).toBe(true);
  });

  it('selectOnly operations are exclusive', () => {
    const s = createSelectionStore();
    s.toggleCard(1);
    s.toggleGroup(10);
    s.selectOnlyCard(2);
    expect(new Set(s.getCards())).toEqual(new Set([2]));
    expect(new Set(s.getGroups())).toEqual(new Set());
    s.selectOnlyGroup(20);
    expect(new Set(s.getCards())).toEqual(new Set());
    expect(new Set(s.getGroups())).toEqual(new Set([20]));
  });
});
