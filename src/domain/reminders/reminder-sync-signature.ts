import type { Habit, RepeatSchedule } from "@/types/habit";
import { parseReminderTimes } from "@/domain/reminders/reminder-time";

function repeatScheduleSignature(schedule: RepeatSchedule): readonly unknown[] {
  switch (schedule.type) {
    case "daily":
      return ["daily"];
    case "weekdays":
      return ["weekdays", [...schedule.days].sort((a, b) => a - b)];
    case "monthly":
      return ["monthly", [...schedule.dates].sort((a, b) => a - b)];
    case "interval":
      return [
        "interval",
        schedule.every,
        schedule.fromCompletion === true,
      ];
  }
}

/**
 * Describes only state that can change the set or content of scheduled local
 * notifications. Unrelated habit edits must not trigger native rescheduling.
 */
export function buildReminderSyncSignature(
  habitsList: readonly Habit[],
  notificationsEnabled: boolean,
): string {
  if (!notificationsEnabled) return "disabled";

  const reminderHabits = habitsList
    .filter(
      (habit) =>
        !habit.isArchived &&
        habit.reminderEnabled &&
        parseReminderTimes(habit.reminderTime).length > 0,
    )
    .sort((left, right) => left.id - right.id)
    .map((habit) => [
      habit.id,
      habit.name,
      [...parseReminderTimes(habit.reminderTime)].sort(),
      habit.startDate,
      repeatScheduleSignature(habit.repeatSchedule),
      (habit.scheduleHistory ?? []).map((entry) => [
        entry.effectiveFrom,
        entry.startDate,
        repeatScheduleSignature(entry.repeatSchedule),
      ]),
    ]);

  return JSON.stringify(reminderHabits);
}
