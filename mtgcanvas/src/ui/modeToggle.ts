import { UIState } from "../state/uiState";

export function installModeToggle() {
  window.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      UIState.toggleMode();
      console.log("[ui] mode=", UIState.state.mode);
    }
  });
}
