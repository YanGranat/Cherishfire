export type HabitDetailPresentationState =
  | "loading"
  | "error"
  | "missing"
  | "data";

/**
 * A cached habit is not a complete detail screen until its day-record history
 * has resolved. This keeps false zero statistics and an empty calendar out of
 * every visible intermediate frame.
 */
export function resolveHabitDetailPresentationState(input: {
  hasHabit: boolean;
  isContentReady: boolean;
  hasError: boolean;
}): HabitDetailPresentationState {
  if (input.hasError) return "error";
  if (!input.isContentReady) return "loading";
  return input.hasHabit ? "data" : "missing";
}
