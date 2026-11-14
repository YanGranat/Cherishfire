import {
  calculatePeriodProgress,
  isCompletedStatus,
  type PeriodProgress,
} from "@/domain/statistics/period-progress";
import type { DayRecord, DayStatus, Habit } from "@/types/habit";
import type { StatisticsPeriod } from "@/types/settings";
import { isDateInArchiveHistory } from "@/domain/habits/archive-periods";
import { isCivilDateKey } from "@/domain/dates/civil-date";
import {
  createScheduleDateFacts,
  createScheduleDateFactsFromDayNumber,
  createHabitScheduleMatcher,
  getEarliestScheduleStartDate,
} from "@/domain/habits/schedule";

export interface StatisticsSourceSnapshot {
  allHabits: readonly Habit[];
  allRecords: readonly DayRecord[];
  showArchivedHabitsInStatistics: boolean;
  todayStr: string;
}

export interface StatisticsPeriodRange {
  startDay: number;
  endDay: number;
  startDate: string;
  endDate: string;
}

export interface StatisticsBarDataPoint {
  label: string;
  value: number;
  isFuture: boolean;
  isToday: boolean;
}

export interface StatisticsHeatmapCell {
  date: string;
  score: number;
  scheduledCount: number;
  completedCount: number;
  archivedScheduledCount: number;
  archivedCompletedCount: number;
  uncoveredRedCount: number;
}

export interface StatisticsHabitBreakdownRow {
  habitId: number;
  name: string;
  completionRate: number;
  currentStreak: number;
}

export interface StatisticsPeriodStats {
  periodProgress: string;
  progressCounts: Omit<PeriodProgress, "percentageLabel">;
  perfectDays: { count: number; total: number };
  barChartData: StatisticsBarDataPoint[];
  heatmapData: StatisticsHeatmapCell[];
  habitBreakdown: StatisticsHabitBreakdownRow[];
  isEmpty: boolean;
  emptyReason: "no-habits" | "no-scheduled" | null;
}

export interface StatisticsSourceIndex {
  source: StatisticsSourceSnapshot;
  visibleHabits: readonly Habit[];
  earliestDateByHabit: ReadonlyMap<number, string>;
  recordsByHabit: ReadonlyMap<number, readonly DayRecord[]>;
  statusByHabitDate: ReadonlyMap<number, ReadonlyMap<string, DayStatus>>;
  getScheduleMatcher: (
    habit: Habit,
  ) => ReturnType<typeof createHabitScheduleMatcher>;
}

export type StatisticsStreakResolver = (
  habit: Habit,
  records: readonly DayRecord[],
  evaluationDate: string,
) => number;

export const EMPTY_STATISTICS_PERIOD_STATS: StatisticsPeriodStats = {
  periodProgress: "0",
  progressCounts: { completed: 0, planned: 0, occurrences: 0 },
  perfectDays: { count: 0, total: 0 },
  barChartData: [],
  heatmapData: [],
  habitBreakdown: [],
  isEmpty: true,
  emptyReason: "no-habits",
};

export function createStatisticsSourceIndex(
  source: StatisticsSourceSnapshot,
): StatisticsSourceIndex {
  const visibleHabits = source.showArchivedHabitsInStatistics
    ? source.allHabits
    : source.allHabits.filter((habit) => !habit.isArchived);
  const recordsByHabit = new Map<number, DayRecord[]>();
  const statusByHabitDate = new Map<number, Map<string, DayStatus>>();

  for (const record of source.allRecords) {
    const habitRecords = recordsByHabit.get(record.habitId);
    if (habitRecords) habitRecords.push(record);
    else recordsByHabit.set(record.habitId, [record]);

    const statuses = statusByHabitDate.get(record.habitId);
    if (statuses) statuses.set(record.date, record.status);
    else {
      statusByHabitDate.set(
        record.habitId,
        new Map([[record.date, record.status]]),
      );
    }
  }

  const earliestDateByHabit = new Map<number, string>();
  for (const habit of visibleHabits) {
    earliestDateByHabit.set(
      habit.id,
      getEarliestScheduleStartDate(habit.startDate, habit.scheduleHistory),
    );
  }

  // Matchers are deterministic derived indexes. Creating them lazily avoids
  // sorting completion records for habits that are outside every visited
  // period, while still reusing them across week/month/year calculations.
  const scheduleMatcherByHabit = new Map<
    number,
    ReturnType<typeof createHabitScheduleMatcher>
  >();
  const getScheduleMatcher = (habit: Habit) => {
    const existing = scheduleMatcherByHabit.get(habit.id);
    if (existing) return existing;
    const matcher = createHabitScheduleMatcher(
      habit.repeatSchedule,
      habit.startDate,
      recordsByHabit.get(habit.id) ?? [],
      habit.scheduleHistory,
    );
    scheduleMatcherByHabit.set(habit.id, matcher);
    return matcher;
  };

  return {
    source,
    visibleHabits,
    earliestDateByHabit,
    recordsByHabit,
    statusByHabitDate,
    getScheduleMatcher,
  };
}

function formatCivilDate(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError("Statistics period year is outside ISO date range");
  }
  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function shiftCivilMonth(
  year: number,
  month: number,
  offset: number,
): { year: number; month: number } {
  const absoluteMonth = year * 12 + month - 1 + offset;
  const shiftedYear = Math.floor(absoluteMonth / 12);
  const shiftedMonth = absoluteMonth - shiftedYear * 12 + 1;
  return { year: shiftedYear, month: shiftedMonth };
}

const MIN_STATISTICS_CIVIL_DAY =
  createScheduleDateFacts("0001-01-01").civilDayNumber;
const MAX_STATISTICS_CIVIL_DAY =
  createScheduleDateFacts("9999-12-31").civilDayNumber;

export function getStatisticsPeriodRange(
  period: StatisticsPeriod,
  periodOffset: number,
  todayStr: string,
): StatisticsPeriodRange | null {
  if (!Number.isSafeInteger(periodOffset) || !isCivilDateKey(todayStr)) {
    return null;
  }
  const today = createScheduleDateFacts(todayStr);
  const year = Number(todayStr.slice(0, 4));
  const month = Number(todayStr.slice(5, 7));
  let rawRange: { startDay: number; endDay: number };

  switch (period) {
    case "week": {
      const baseDay = today.civilDayNumber + periodOffset * 7;
      if (!Number.isSafeInteger(baseDay)) return null;
      // Avoid asking Date to materialize an extreme but still safe integer.
      // A civil week cannot intersect the supported range when its reference
      // day is more than six days beyond either boundary.
      if (
        baseDay + 6 < MIN_STATISTICS_CIVIL_DAY ||
        baseDay - 6 > MAX_STATISTICS_CIVIL_DAY
      ) {
        return null;
      }
      const base = createScheduleDateFactsFromDayNumber(baseDay);
      const startDay = baseDay - (base.isoWeekday - 1);
      rawRange = {
        startDay,
        endDay: startDay + 6,
      };
      break;
    }
    case "month": {
      const shifted = shiftCivilMonth(year, month, periodOffset);
      if (shifted.year < 1 || shifted.year > 9999) return null;
      rawRange = {
        startDay: createScheduleDateFacts(
          formatCivilDate(shifted.year, shifted.month, 1),
        ).civilDayNumber,
        endDay: createScheduleDateFacts(
          formatCivilDate(
            shifted.year,
            shifted.month,
            daysInMonth(shifted.year, shifted.month),
          ),
        ).civilDayNumber,
      };
      break;
    }
    case "year": {
      const shiftedYear = year + periodOffset;
      if (shiftedYear < 1 || shiftedYear > 9999) return null;
      rawRange = {
        startDay: createScheduleDateFacts(
          formatCivilDate(shiftedYear, 1, 1),
        ).civilDayNumber,
        endDay: createScheduleDateFacts(
          formatCivilDate(shiftedYear, 12, 31),
        ).civilDayNumber,
      };
      break;
    }
  }

  const startDay = Math.max(rawRange.startDay, MIN_STATISTICS_CIVIL_DAY);
  const endDay = Math.min(rawRange.endDay, MAX_STATISTICS_CIVIL_DAY);
  if (startDay > endDay) return null;
  return {
    startDay,
    endDay,
    startDate: createScheduleDateFactsFromDayNumber(startDay).date,
    endDate: createScheduleDateFactsFromDayNumber(endDay).date,
  };
}

interface HabitPeriodEvaluation {
  habit: Habit;
  records: readonly DayRecord[];
  statuses: ReadonlyMap<string, DayStatus> | undefined;
  earliestDate: string;
  isScheduled: ReturnType<typeof createHabitScheduleMatcher>;
  occurrenceCount: number;
  scheduledNonFuture: number;
  completedNonFuture: number;
}

/**
 * Stable domain calculation for one period. It has no React, store, SQLite or
 * global-cache dependency. The application layer supplies only a deterministic
 * streak resolver, allowing that expensive rule to share its bounded cache.
 */
export function calculateStatisticsPeriod(
  index: StatisticsSourceIndex,
  period: StatisticsPeriod,
  periodOffset: number,
  resolveCurrentStreak: StatisticsStreakResolver,
): StatisticsPeriodStats {
  const { source, visibleHabits } = index;
  const range = getStatisticsPeriodRange(
    period,
    periodOffset,
    source.todayStr,
  );
  if (range == null) {
    throw new RangeError(
      "Statistics period is outside the supported civil date range",
    );
  }
  if (visibleHabits.length === 0) return EMPTY_STATISTICS_PERIOD_STATS;
  const { startDay, endDay } = range;
  const periodDates = [];
  for (let day = startDay; day <= endDay; day += 1) {
    const scheduleFacts = createScheduleDateFactsFromDayNumber(day);
    periodDates.push({ date: scheduleFacts.date, scheduleFacts });
  }
  const nonFutureDateCount = periodDates.reduce(
    (count, entry) => count + (entry.date <= source.todayStr ? 1 : 0),
    0,
  );
  const periodEndDate = createScheduleDateFactsFromDayNumber(endDay).date;
  const evaluations: HabitPeriodEvaluation[] = visibleHabits
    .filter(
      (habit) =>
        (index.earliestDateByHabit.get(habit.id) ?? habit.startDate) <=
        periodEndDate,
    )
    .map((habit) => ({
      habit,
      records: index.recordsByHabit.get(habit.id) ?? [],
      statuses: index.statusByHabitDate.get(habit.id),
      earliestDate:
        index.earliestDateByHabit.get(habit.id) ?? habit.startDate,
      isScheduled: index.getScheduleMatcher(habit),
      occurrenceCount: 0,
      scheduledNonFuture: 0,
      completedNonFuture: 0,
    }));

  const scheduledStatuses: (DayStatus | undefined)[] = [];
  const barChartData: StatisticsBarDataPoint[] = [];
  const heatmapData: StatisticsHeatmapCell[] = [];
  let perfectCount = 0;

  // One habit/date pass supplies every aggregate. Counters stay on each
  // prepared evaluation to avoid duplicate work and allocation.
  for (const { date: dateStr, scheduleFacts } of periodDates) {
    let scheduled = 0;
    let completed = 0;
    let archivedScheduled = 0;
    let archivedCompleted = 0;
    let effectiveHabitCount = 0;
    let maximumCount = 0;
    let redEventCount = 0;
    let greenPoints = 0;
    const isPast = dateStr < source.todayStr;
    const isNonFuture = dateStr <= source.todayStr;

    for (const evaluation of evaluations) {
      if (dateStr < evaluation.earliestDate) continue;
      if (isDateInArchiveHistory(dateStr, evaluation.habit.archiveHistory)) {
        continue;
      }
      if (!evaluation.isScheduled(dateStr, scheduleFacts)) continue;

      evaluation.occurrenceCount += 1;
      const status = evaluation.statuses?.get(dateStr);
      scheduledStatuses.push(status);
      if (status === "skipped") continue;

      scheduled += 1;
      effectiveHabitCount += 1;
      const isCompleted = isCompletedStatus(status);
      if (isCompleted) completed += 1;
      if (evaluation.habit.isArchived) {
        archivedScheduled += 1;
        if (isCompleted) archivedCompleted += 1;
      }
      if (isNonFuture) {
        evaluation.scheduledNonFuture += 1;
        if (isCompleted) evaluation.completedNonFuture += 1;
      }

      if (status === "maximum") {
        maximumCount += 1;
        greenPoints += 3;
        continue;
      }
      if (status === "done") {
        greenPoints += 2;
        continue;
      }
      if (status === "minimum") {
        greenPoints += 1;
        continue;
      }
      if (status === "failure" || (status == null && isPast)) {
        redEventCount += 1;
      }
    }

    if (isNonFuture && scheduled > 0 && completed === scheduled) {
      perfectCount += 1;
    }
    barChartData.push({
      label: dateStr,
      value: scheduled > 0 ? Math.round((completed / scheduled) * 100) : 0,
      isFuture: dateStr > source.todayStr,
      isToday: dateStr === source.todayStr,
    });

    // Each maximum neutralizes one red event. A maximum used that way counts
    // like a regular completion (+2 instead of +3).
    const coveredRedEvents = Math.min(maximumCount, redEventCount);
    const uncoveredRedEvents = redEventCount - coveredRedEvents;
    if (coveredRedEvents > 0) greenPoints -= coveredRedEvents;

    heatmapData.push({
      date: dateStr,
      score:
        effectiveHabitCount <= 0
          ? 0
          : uncoveredRedEvents > 0
            ? -4 * (uncoveredRedEvents / effectiveHabitCount)
            : (greenPoints / effectiveHabitCount) * (2 / 3),
      scheduledCount: scheduled,
      completedCount: completed,
      archivedScheduledCount: archivedScheduled,
      archivedCompletedCount: archivedCompleted,
      uncoveredRedCount: uncoveredRedEvents,
    });
  }

  const progress = calculatePeriodProgress(scheduledStatuses);
  const streakEvaluationDate =
    periodEndDate < source.todayStr ? periodEndDate : source.todayStr;
  const habitBreakdown = evaluations
    .filter((evaluation) => evaluation.occurrenceCount > 0)
    .map((evaluation) => ({
      habitId: evaluation.habit.id,
      name: evaluation.habit.name,
      completionRate:
        evaluation.scheduledNonFuture > 0
          ? Math.round(
              (evaluation.completedNonFuture /
                evaluation.scheduledNonFuture) *
                100,
            )
          : 0,
      currentStreak: resolveCurrentStreak(
        evaluation.habit,
        evaluation.records,
        streakEvaluationDate,
      ),
    }))
    .sort((left, right) => right.completionRate - left.completionRate);

  return {
    periodProgress: progress.percentageLabel,
    progressCounts: {
      completed: progress.completed,
      planned: progress.planned,
      occurrences: progress.occurrences,
    },
    perfectDays: { count: perfectCount, total: nonFutureDateCount },
    barChartData,
    heatmapData,
    habitBreakdown,
    isEmpty: scheduledStatuses.length === 0,
    emptyReason: scheduledStatuses.length === 0 ? "no-scheduled" : null,
  };
}
