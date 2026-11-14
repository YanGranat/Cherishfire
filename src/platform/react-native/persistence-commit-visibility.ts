import { AppState } from "react-native";
import type { PersistenceCommitVisibilityPort } from "@/application/persistence/deferred-commit-scheduler";
import { waitForUiPaint } from "@/utils/ui-scheduling";

export const reactNativePersistenceCommitVisibility: PersistenceCommitVisibilityPort = {
  isAppActive() {
    // `null` is possible while React Native initializes. Preserve the normal
    // foreground paint path unless the platform explicitly reports otherwise.
    return (
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive"
    );
  },
  waitForUiPaint,
  subscribeToAppState(listener) {
    const subscription = AppState.addEventListener("change", (state) => {
      listener(state === "active");
    });
    return () => subscription.remove();
  },
  scheduleFallback(listener, delayMs) {
    const handle = setTimeout(listener, delayMs);
    return () => clearTimeout(handle);
  },
};
