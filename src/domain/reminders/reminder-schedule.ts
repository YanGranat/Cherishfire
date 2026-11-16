import { addDays } from "date-fns/addDays";
import { format } from "date-fns/format";
import { startOfDay } from "date-fns/startOfDay";
import { createHabitScheduleMatcher } from "@/domain/habits/schedule";
import { parseReminderTimes } from "@/domain/reminders/reminder-time";
import type { DayStatus, Habit } from "@/types/habit";

export const REMINDER_LOOKAHEAD_DAYS = 30;
export const REMINDER_MAX_PER_HABIT = 64;

const RECORDED_STATUSES = new Set<DayStatus>([
  "done",
  "minimum",
  "maximum",
  "skipped",
  "failure",
]);

export interface ReminderScheduleRecord {
  readonly date: string;
  readonly status: DayStatus;
}

export function isReminderRecordedStatus(
  status: string,
): status is DayStatus {
  return RECORDED_STATUSES.has(status as DayStatus);
}

export function canScheduleHabitReminders(habit: Habit | null | undefined): habit is Habit {
  return (
    habit != null &&
    !habit.isArchived &&
    habit.reminderEnabled &&
    parseReminderTimes(habit.reminderTime).length > 0
  );
}

function parseReminderTime(
  time: string,
): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) return null;
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

export function buildUpcomingReminderDates(
  habit: Habit,
  habitRecords: readonly ReminderScheduleRecord[] = [],
  now: Date,
): Date[] {
  if (habit.isArchived || !habit.reminderEnabled) return [];
  const times = parseReminderTimes(habit.reminderTime)
    .map((value) => parseReminderTime(value))
    .filter(
      (value): value is { hour: number; minute: number } => value != null,
    );
  if (times.length === 0) return [];

  const today = startOfDay(now);
  const dates: Date[] = [];
  // Any explicit mark means the user has already handled this habit for the
  // date. Completion-led interval scheduling still sees every record here and
  // independently filters to done/minimum/maximum inside the habit matcher.
  const handledDates = new Set(habitRecords.map((record) => record.date));
  const isScheduled = createHabitScheduleMatcher(
    habit.repeatSchedule,
    habit.startDate,
    habitRecords,
    habit.scheduleHistory,
  );

  for (let offset = 0; offset <= REMINDER_LOOKAHEAD_DAYS; offset += 1) {
    const day = addDays(today, offset);
    const isoDate = format(day, "yyyy-MM-dd");
    if (handledDates.has(isoDate)) continue;
    if (!isScheduled(isoDate)) continue;

    // Plan by actual trigger time, independently of the editor's row order.
    // Local times in a daylight-saving gap can normalize into a later hour.
    const dayDates = times
      .map((time) => {
        const triggerDate = new Date(day);
        triggerDate.setHours(time.hour, time.minute, 0, 0);
        return triggerDate;
      })
      .filter((date) => date.getTime() > now.getTime())
      .sort((left, right) => left.getTime() - right.getTime());
    for (const triggerDate of dayDates) {
      if (dates[dates.length - 1]?.getTime() === triggerDate.getTime()) continue;
      dates.push(triggerDate);
      if (dates.length >= REMINDER_MAX_PER_HABIT) return dates;
    }
  }

  return dates;
}
