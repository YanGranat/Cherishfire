import { AppState } from "react-native";
import type { ReminderWorkSchedulingPort } from "@/application/reminders/reminder-ports";
import { runAfterUiSettles } from "@/utils/ui-scheduling";

export const reactNativeReminderWorkScheduling: ReminderWorkSchedulingPort = {
  scheduleAfterUiSettles: runAfterUiSettles,
  isAppActive() {
    return (
      AppState.currentState !== "background" &&
      AppState.currentState !== "inactive"
    );
  },
  yieldToUi() {
    if (
      AppState.currentState === "background" ||
      AppState.currentState === "inactive"
    ) {
      return new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    return new Promise((resolve) => {
      let settled = false;
      let postFrameTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (postFrameTimer != null) clearTimeout(postFrameTimer);
        clearTimeout(fallbackTimer);
        resolve();
      };
      const fallbackTimer = setTimeout(finish, 50);
      requestAnimationFrame(() => {
        // Leave the frame callback turn before continuing native reminder
        // mutations so React Native can commit the frame that requested it.
        postFrameTimer = setTimeout(finish, 0);
      });
    });
  },
};
