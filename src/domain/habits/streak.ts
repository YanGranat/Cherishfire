// Pure habit-domain streak calculation. No cache, UI, or persistence state.
import { format } from "date-fns/format";
import type {
  ArchivePeriod,
  DayRecord,
  DayStatus,
  RepeatSchedule,
  ScheduleHistoryEntry,
} from "@/types/habit";
import {
  createHabitScheduleMatcher,
  createScheduleDateFacts,
  createScheduleDateFactsFromDayNumber,
  getEarliestScheduleStartDate,
} from "@/domain/habits/schedule";
import { isDateInArchiveHistory } from "@/domain/habits/archive-periods";

interface StreakStats {
  current: number;
  best: number;
  total: number;
}

// Statuses that count as "completed" for streaks and totals
const COMPLETED_STATUSES = new Set<DayStatus>([
  "done",
  "minimum",
  "maximum",
]);

/** Counts only the current active segment, stopping at its first break. */
export function calculateCurrentStreak(
  records: DayRecord[],
  schedule: RepeatSchedule,
  startDate: string,
  archiveHistory: ArchivePeriod[],
  scheduleHistory?: ScheduleHistoryEntry[],
  evaluationDate = format(new Date(), "yyyy-MM-dd"),
): number {
  const statuses = new Map(records.map((record) => [record.date, record.status]));
  const isScheduled = createHabitScheduleMatcher(schedule, startDate, records, scheduleHistory);
  const firstDay = createScheduleDateFacts(getEarliestScheduleStartDate(startDate, scheduleHistory)).civilDayNumber;
  const lastDay = createScheduleDateFacts(evaluationDate).civilDayNumber;
  let current = 0;
  for (let day = lastDay; day >= firstDay; day -= 1) {
    const facts = createScheduleDateFactsFromDayNumber(day);
    if (isDateInArchiveHistory(facts.date, archiveHistory)) break;
    if (!isScheduled(facts.date, facts)) continue;
    const status = statuses.get(facts.date);
    if (status && COMPLETED_STATUSES.has(status)) current += 1;
    else if (status === "skipped" || (day === lastDay && status == null)) continue;
    else break;
  }
  return current;
}

// Calculates current streak, best streak, and total completions.
// Current streak rules:
// - Current streak: count consecutive completed days backward from today where
//   status is done/min/max. Skipped days do not break the streak, but also do not
//   increase it. Stop on failure, unmarked past day, or before startDate.
//   Days where habit is not scheduled are skipped (do not break or contribute).
// - Archive periods end the current streak without counting as a failure.
//   A restored habit starts a new streak; best keeps the strongest active segment.
// - Best streak: maximum streak ever achieved inside one active segment.
// - Total: count of all done/min/max records.
export function calculateStreakStats(
  records: DayRecord[],
  schedule: RepeatSchedule,
  startDate: string,
  archiveHistory: ArchivePeriod[],
  scheduleHistory?: ScheduleHistoryEntry[],
  evaluationDate = format(new Date(), "yyyy-MM-dd")
): StreakStats {
  // Build a map of date -> status for quick lookup
  const statusMap = new Map<string, DayStatus>();
  let total = 0;
  for (const r of records) {
    statusMap.set(r.date, r.status);
    if (
      !isDateInArchiveHistory(r.date, archiveHistory) &&
      COMPLETED_STATUSES.has(r.status)
    ) {
      total += 1;
    }
  }

  const todayStr = evaluationDate;
  const firstDay = createScheduleDateFacts(getEarliestScheduleStartDate(startDate, scheduleHistory)).civilDayNumber;
  const lastDay = createScheduleDateFacts(evaluationDate).civilDayNumber;
  const isScheduled = createHabitScheduleMatcher(
    schedule,
    startDate,
    records,
    scheduleHistory
  );
  let best = 0;
  let tempStreak = 0;

  // A single chronological pass calculates both best and current streak.
  // Civil days advance independently of midnight timezone transitions.
  for (let day = firstDay; day <= lastDay; day += 1) {
    const facts = createScheduleDateFactsFromDayNumber(day);
    const dateStr = facts.date;
    if (isDateInArchiveHistory(dateStr, archiveHistory)) {
      // Do not glue streaks from two active periods across an archive pause.
      tempStreak = 0;
      continue;
    }
    if (!isScheduled(dateStr, facts)) {
      continue;
    }

    const status = statusMap.get(dateStr);

    if (status && COMPLETED_STATUSES.has(status)) {
      tempStreak++;
      if (tempStreak > best) best = tempStreak;
    } else if (status === "skipped") {
      continue;
    } else if (dateStr === todayStr && status == null) {
      // Today is still actionable and does not break the existing streak.
      continue;
    } else {
      tempStreak = 0;
    }

  }

  const current = tempStreak;
  if (current > best) best = current;

  return { current, best, total };
}
