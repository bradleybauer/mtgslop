import { describe, it, expect } from "vitest";
import { createSelectionStore } from "../selectionStore";

function fakeSprite(id: number) {
  return { __id: id } as any;
}

describe("SelectionStore", () => {
  it("toggles and clears selections", () => {
    const s = createSelectionStore();
    const a = fakeSprite(1);
    const b = fakeSprite(2);
    s.toggleCard(a);
    s.toggleCard(b);
    expect(new Set(s.getCards())).toEqual(new Set([a, b]));
    s.toggleCard(a);
    expect(new Set(s.getCards())).toEqual(new Set([b]));
    s.clear();
    expect(s.isEmpty).toBe(true);
  });

  it("selectOnly operations are exclusive", () => {
    const s = createSelectionStore();
    const a = fakeSprite(1);
    const b = fakeSprite(2);
    s.toggleCard(a);
    s.toggleGroup(10);
    s.selectOnlyCard(b);
    expect(new Set(s.getCards())).toEqual(new Set([b]));
    expect(new Set(s.getGroups())).toEqual(new Set());
    s.selectOnlyGroup(20);
    expect(new Set(s.getCards())).toEqual(new Set());
    expect(new Set(s.getGroups())).toEqual(new Set([20]));
  });
});
