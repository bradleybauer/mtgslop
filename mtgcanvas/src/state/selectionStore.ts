export interface SelectionState {
  cardIds: Set<number>;
  groupIds: Set<number>;
}

class SelectionStoreImpl {
  state: SelectionState = { cardIds: new Set(), groupIds: new Set() };
  listeners: Set<()=>void> = new Set();

  replace(next: SelectionState) { this.state = next; this.emit(); }
  clear() { this.state.cardIds.clear(); this.state.groupIds.clear(); this.emit(); }
  toggleCard(id:number) { if (this.state.cardIds.has(id)) this.state.cardIds.delete(id); else this.state.cardIds.add(id); this.emit(); }
  on(cb:()=>void) { this.listeners.add(cb); return ()=>this.listeners.delete(cb); }
  emit() { for (const l of this.listeners) l(); }
}

export const SelectionStore = new SelectionStoreImpl();
