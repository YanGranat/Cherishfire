import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { format } from "date-fns/format";
import { createCurrentLocalDateStore } from "@/utils/current-local-date-store";
function getCurrentLocalDate(): string {
  return format(new Date(), "yyyy-MM-dd");
}
function millisecondsUntilNextLocalDay(): number {
  const now = new Date();
  const nextDay = new Date(now);
  nextDay.setDate(now.getDate() + 1);
  nextDay.setHours(0, 0, 1, 0);
  return Math.max(1000, nextDay.getTime() - now.getTime());
}
const currentLocalDateStore = createCurrentLocalDateStore({
  readLocalDate: getCurrentLocalDate,
  millisecondsUntilNextLocalDay,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  subscribeToAppActive: (onActive) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") onActive();
    });
    return () => subscription.remove();
  },
});
export function getCurrentLocalDateSnapshot(): string {
  return currentLocalDateStore.getSnapshot();
}
export function subscribeToCurrentLocalDate(listener: () => void): () => void {
  return currentLocalDateStore.subscribe(listener);
}
/** Keeps the app's idea of "today" aligned with the device's local calendar. */
export function useCurrentLocalDate(): string {
  return useSyncExternalStore(
    subscribeToCurrentLocalDate,
    currentLocalDateStore.getSnapshot,
    currentLocalDateStore.getSnapshot,
  );
}
