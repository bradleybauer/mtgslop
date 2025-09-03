import type { CardSprite } from "../scene/cardNode";

export interface SelectionState {
  cards: Set<CardSprite>;
  groupIds: Set<number>;
}

export interface ISelectionStore {
  readonly state: SelectionState;
  replace(next: SelectionState): void;
  clear(): void;
  toggleCard(card: CardSprite): void;
  toggleGroup(id: number): void;
  selectOnlyCard(card: CardSprite): void;
  selectOnlyGroup(id: number): void;
  readonly isEmpty: boolean;
  getCards(): CardSprite[];
  getGroups(): number[];
  on(cb: () => void): () => void;
}

class SelectionStoreImpl implements ISelectionStore {
  state: SelectionState = { cards: new Set(), groupIds: new Set() };
  listeners: Set<() => void> = new Set();

  replace(next: SelectionState) {
    this.state = next;
    this.emit();
  }
  clear() {
    this.state.cards.clear();
    this.state.groupIds.clear();
    this.emit();
  }
  toggleCard(card: CardSprite) {
    if (this.state.cards.has(card)) this.state.cards.delete(card);
    else this.state.cards.add(card);
    this.emit();
  }
  toggleGroup(id: number) {
    if (this.state.groupIds.has(id)) this.state.groupIds.delete(id);
    else this.state.groupIds.add(id);
    this.emit();
  }
  selectOnlyCard(card: CardSprite) {
    this.state.cards.clear();
    this.state.groupIds.clear();
    this.state.cards.add(card);
    this.emit();
  }
  selectOnlyGroup(id: number) {
    this.state.cards.clear();
    this.state.groupIds.clear();
    this.state.groupIds.add(id);
    this.emit();
  }
  get isEmpty() {
    return this.state.cards.size === 0 && this.state.groupIds.size === 0;
  }
  getCards() {
    return [...this.state.cards];
  }
  getGroups() {
    return [...this.state.groupIds];
  }
  on(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit() {
    for (const l of this.listeners) l();
  }
}

export function createSelectionStore(
  initial?: Partial<SelectionState>,
): ISelectionStore {
  const s = new SelectionStoreImpl();
  if (initial) {
    s.state.cards = (initial as any).cards ?? s.state.cards;
    s.state.groupIds = initial.groupIds ?? s.state.groupIds;
  }
  return s;
}

export const SelectionStore: ISelectionStore = new SelectionStoreImpl();
