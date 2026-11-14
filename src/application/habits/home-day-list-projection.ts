import type { DayRecord, DayStatus, Habit } from "@/types/habit";

export type HabitCheckboxState = DayStatus | "unmarked" | "unmarkedPast";
export type HabitListSection = "active" | "completed";

/** Immutable Home row model for one calendar date. */
export interface HabitListItemViewModel {
  habit: Habit;
  section: HabitListSection;
  stableKey: string;
  checkboxState: HabitCheckboxState;
  currentStreak: number;
  completedAt: number | null;
}

export interface DayListSnapshot {
  activeItems: HabitListItemViewModel[];
  completedItems: HabitListItemViewModel[];
  statusByHabitId: Map<number, DayStatus>;
}

function itemMatches(
  item: HabitListItemViewModel | undefined,
  next: HabitListItemViewModel,
): boolean {
  return (
    item?.habit === next.habit &&
    item.section === next.section &&
    item.stableKey === next.stableKey &&
    item.checkboxState === next.checkboxState &&
    item.currentStreak === next.currentStreak &&
    item.completedAt === next.completedAt
  );
}

/**
 * Advances an already prepared Home date after one day-record mutation.
 * Other rows keep their object identity, while the changed habit is moved,
 * removed, or updated without rebuilding schedules and streaks for the whole
 * application history.
 */
export function projectDayListSnapshotHabitMutation(params: {
  snapshot: DayListSnapshot;
  scheduledHabitIds: readonly number[];
  habit: Habit;
  record: DayRecord | null;
  isPast: boolean;
  currentStreak: number;
}): DayListSnapshot {
  const {
    snapshot,
    scheduledHabitIds,
    habit,
    record,
    isPast,
    currentStreak,
  } = params;
  const habitId = habit.id;
  const scheduled = scheduledHabitIds.includes(habitId);
  const previous =
    snapshot.activeItems.find((item) => item.habit.id === habitId) ??
    snapshot.completedItems.find((item) => item.habit.id === habitId);

  let nextItem: HabitListItemViewModel | null = null;
  if (scheduled) {
    nextItem = record
      ? {
          habit,
          section: "completed",
          stableKey: `completed:${habitId}`,
          checkboxState: record.status,
          currentStreak,
          completedAt: record.createdAt,
        }
      : {
          habit,
          section: "active",
          stableKey: `active:${habitId}`,
          checkboxState: isPast ? "unmarkedPast" : "unmarked",
          currentStreak,
          completedAt: null,
        };
    if (itemMatches(previous, nextItem)) nextItem = previous ?? nextItem;
  }

  const activeById = new Map(
    snapshot.activeItems
      .filter((item) => item.habit.id !== habitId)
      .map((item) => [item.habit.id, item] as const),
  );
  if (nextItem?.section === "active") activeById.set(habitId, nextItem);
  const activeItems = scheduledHabitIds.flatMap((candidateId) => {
    const item = activeById.get(candidateId);
    return item ? [item] : [];
  });

  const completedItems = snapshot.completedItems.filter(
    (item) => item.habit.id !== habitId,
  );
  if (nextItem?.section === "completed") completedItems.push(nextItem);
  completedItems.sort((left, right) => {
    const leftCompletedAt = left.completedAt ?? Number.MAX_SAFE_INTEGER;
    const rightCompletedAt = right.completedAt ?? Number.MAX_SAFE_INTEGER;
    return (
      leftCompletedAt - rightCompletedAt || left.habit.id - right.habit.id
    );
  });

  const previousStatus = snapshot.statusByHabitId.get(habitId);
  const nextStatus = scheduled && record ? record.status : undefined;
  let statusByHabitId = snapshot.statusByHabitId;
  if (previousStatus !== nextStatus) {
    statusByHabitId = new Map(snapshot.statusByHabitId);
    if (nextStatus == null) statusByHabitId.delete(habitId);
    else statusByHabitId.set(habitId, nextStatus);
  }

  const activeUnchanged =
    activeItems.length === snapshot.activeItems.length &&
    activeItems.every((item, index) => item === snapshot.activeItems[index]);
  const completedUnchanged =
    completedItems.length === snapshot.completedItems.length &&
    completedItems.every(
      (item, index) => item === snapshot.completedItems[index],
    );
  if (
    activeUnchanged &&
    completedUnchanged &&
    statusByHabitId === snapshot.statusByHabitId
  ) {
    return snapshot;
  }
  return { activeItems, completedItems, statusByHabitId };
}
