export interface SelectionState {
  cardIds: Set<number>;
  groupIds: Set<number>;
}

class SelectionStoreImpl {
  state: SelectionState = { cardIds: new Set(), groupIds: new Set() };
  listeners: Set<() => void> = new Set();

  replace(next: SelectionState) {
    this.state = next;
    this.emit();
  }
  clear() {
    this.state.cardIds.clear();
    this.state.groupIds.clear();
    this.emit();
  }
  toggleCard(id: number) {
    if (this.state.cardIds.has(id)) this.state.cardIds.delete(id);
    else this.state.cardIds.add(id);
    this.emit();
  }
  toggleGroup(id: number) {
    if (this.state.groupIds.has(id)) this.state.groupIds.delete(id);
    else this.state.groupIds.add(id);
    this.emit();
  }
  selectOnlyCard(id: number) {
    this.state.cardIds.clear();
    this.state.groupIds.clear();
    this.state.cardIds.add(id);
    this.emit();
  }
  selectOnlyGroup(id: number) {
    this.state.cardIds.clear();
    this.state.groupIds.clear();
    this.state.groupIds.add(id);
    this.emit();
  }
  get isEmpty() {
    return this.state.cardIds.size === 0 && this.state.groupIds.size === 0;
  }
  getCards() {
    return [...this.state.cardIds];
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

export const SelectionStore = new SelectionStoreImpl();
