export type UIMode = "canvas" | "table";

interface UIState {
  mode: UIMode;
}

class UIStateStore {
  state: UIState = { mode: "canvas" };
  listeners = new Set<() => void>();
  setMode(mode: UIMode) {
    if (this.state.mode !== mode) {
      this.state.mode = mode;
      this.emit();
    }
  }
  toggleMode() {
    this.setMode(this.state.mode === "canvas" ? "table" : "canvas");
  }
  on(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit() {
    this.listeners.forEach((l) => l());
  }
}

export const UIState = new UIStateStore();
