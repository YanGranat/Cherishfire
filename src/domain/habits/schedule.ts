import type {
  DayRecord,
  DayStatus,
  RepeatSchedule,
  ScheduleHistoryEntry,
} from "@/types/habit";

// Convert JS getDay (0=Sun) to ISO weekday (1=Mon..7=Sun)
function toIsoWeekday(jsDay: number): number {
  return jsDay === 0 ? 7 : jsDay;
}

const COMPLETION_STATUSES = new Set<DayStatus>([
  "done",
  "minimum",
  "maximum",
]);
type ScheduleRecord = Pick<DayRecord, "date" | "status">;

/**
 * Calendar facts that can be shared by every habit evaluated for one date.
 * The date identity is part of the value so a stale/mismatched optimization
 * can never change schedule semantics.
 */
export interface ScheduleDateFacts {
  date: string;
  isoWeekday: number;
  dayOfMonth: number;
  civilDayNumber: number;
}

export type HabitScheduleMatcher = (
  targetDate: string,
  dateFacts?: Readonly<ScheduleDateFacts>,
) => boolean;

export interface ScheduleRecordPartition<T extends ScheduleRecord> {
  kept: T[];
  removed: T[];
}

function getNextDueCivilDay(date: string, days: number): number {
  return createScheduleDateFacts(date).civilDayNumber + days;
}

export function createScheduleDateFactsFromDayNumber(day: number): ScheduleDateFacts {
  const date = new Date(day * 86_400_000);
  return {
    date: date.toISOString().slice(0, 10),
    civilDayNumber: day,
    isoWeekday: toIsoWeekday(((day + 4) % 7 + 7) % 7),
    dayOfMonth: date.getUTCDate(),
  };
}

/**
 * Builds timezone-independent facts for a local ISO calendar date. Statistics
 * creates this once per date instead of parsing the same date once per habit.
 */
export function createScheduleDateFacts(targetDate: string): ScheduleDateFacts {
  const year = Number(targetDate.slice(0, 4));
  const month = Number(targetDate.slice(5, 7));
  const dayOfMonth = Number(targetDate.slice(8, 10));
  let midnight = Date.UTC(year, month - 1, dayOfMonth);
  if (year >= 0 && year < 100) {
    const exactYear = new Date(midnight);
    exactYear.setUTCFullYear(year, month - 1, dayOfMonth);
    midnight = exactYear.getTime();
  }
  const civilDayNumber = Math.floor(midnight / 86_400_000);
  const jsWeekday = ((civilDayNumber + 4) % 7 + 7) % 7;

  return {
    date: targetDate,
    isoWeekday: toIsoWeekday(jsWeekday),
    dayOfMonth,
    civilDayNumber,
  };
}

function findLastCompletionDateBefore(
  records: ScheduleRecord[] | undefined,
  targetDate: string,
  versionStartDate: string
): string | null {
  if (!records || records.length === 0) return null;
  let latest: string | null = null;
  for (const record of records) {
    if (!COMPLETION_STATUSES.has(record.status)) continue;
    if (record.date < versionStartDate || record.date >= targetDate) continue;
    if (latest == null || record.date > latest) {
      latest = record.date;
    }
  }
  return latest;
}

function findLastSortedDateBefore(
  sortedDates: readonly string[],
  targetDate: string,
  minimumDate: string
): string | null {
  let low = 0;
  let high = sortedDates.length - 1;
  let matchIndex = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (sortedDates[middle] < targetDate) {
      matchIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (matchIndex < 0) return null;
  const match = sortedDates[matchIndex];
  return match >= minimumDate ? match : null;
}

function resolveScheduleVersion(
  schedule: RepeatSchedule,
  startDate: string,
  targetDate: string,
  scheduleHistory?: readonly ScheduleHistoryEntry[]
): {
  schedule: RepeatSchedule;
  startDate: string;
  versionStartDate: string;
} {
  let resolvedVersion: ScheduleHistoryEntry | undefined;
  if (scheduleHistory) {
    for (let index = scheduleHistory.length - 1; index >= 0; index -= 1) {
      const entry = scheduleHistory[index];
      if (entry.effectiveFrom <= targetDate) {
        resolvedVersion = entry;
        break;
      }
    }
  }
  const effectiveSchedule = resolvedVersion?.repeatSchedule ?? schedule;
  const effectiveStartDate = resolvedVersion?.startDate ?? startDate;
  const versionStartDate =
    resolvedVersion?.effectiveFrom &&
    resolvedVersion.effectiveFrom > effectiveStartDate
      ? resolvedVersion.effectiveFrom
      : effectiveStartDate;
  return {
    schedule: effectiveSchedule,
    startDate: effectiveStartDate,
    versionStartDate,
  };
}

export function isCompletionLedIntervalScheduleForDate(
  schedule: RepeatSchedule,
  startDate: string,
  targetDate: string,
  scheduleHistory?: readonly ScheduleHistoryEntry[],
): boolean {
  const resolved = resolveScheduleVersion(
    schedule,
    startDate,
    targetDate,
    scheduleHistory,
  );
  return (
    resolved.schedule.type === "interval" &&
    resolved.schedule.fromCompletion === true
  );
}

function matchesResolvedSchedule(
  effectiveSchedule: RepeatSchedule,
  effectiveStartDate: string,
  versionStartDate: string,
  targetDate: string,
  lastCompletionDate: string | null,
  dateFacts?: Readonly<ScheduleDateFacts>,
  effectiveStartCivilDay?: number,
): boolean {
  if (targetDate < effectiveStartDate) return false;
  const matchingDateFacts =
    dateFacts?.date === targetDate ? dateFacts : undefined;

  switch (effectiveSchedule.type) {
    case "daily":
      return true;
    case "weekdays":
      return effectiveSchedule.days.includes(
        (matchingDateFacts ?? createScheduleDateFacts(targetDate)).isoWeekday,
      );
    case "monthly":
      return effectiveSchedule.dates.includes(
        (matchingDateFacts ?? createScheduleDateFacts(targetDate)).dayOfMonth,
      );
    case "interval": {
      if (effectiveSchedule.fromCompletion === true) {
        if (!lastCompletionDate) return targetDate >= versionStartDate;
        const nextDueCivilDay = getNextDueCivilDay(
          lastCompletionDate,
          effectiveSchedule.every
        );
        return (matchingDateFacts ?? createScheduleDateFacts(targetDate)).civilDayNumber >= nextDueCivilDay;
      }
      const diff = matchingDateFacts
        ? matchingDateFacts.civilDayNumber -
          (effectiveStartCivilDay ??
            createScheduleDateFacts(effectiveStartDate).civilDayNumber)
        : createScheduleDateFacts(targetDate).civilDayNumber -
          createScheduleDateFacts(effectiveStartDate).civilDayNumber;
      return diff >= 0 && diff % effectiveSchedule.every === 0;
    }
    default:
      return false;
  }
}

/**
 * Prepares one reusable matcher for calendar/statistics loops. Completion-led
 * intervals use binary search instead of rescanning every historical record
 * for every date.
 */
export function createHabitScheduleMatcher(
  schedule: RepeatSchedule,
  startDate: string,
  records?: readonly ScheduleRecord[],
  scheduleHistory?: readonly ScheduleHistoryEntry[]
): HabitScheduleMatcher {
  const needsCompletionDates =
    (schedule.type === "interval" && schedule.fromCompletion === true) ||
    (scheduleHistory?.some(
      (entry) =>
        entry.repeatSchedule.type === "interval" &&
        entry.repeatSchedule.fromCompletion === true
    ) ?? false);
  const completionDates = needsCompletionDates
    ? (records ?? [])
        .filter((record) => COMPLETION_STATUSES.has(record.status))
        .map((record) => record.date)
        .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    : [];
  const nextDueDayCache = new Map<string, number>();
  const startCivilDayCache = new Map<string, number>();

  return (targetDate: string, dateFacts?: Readonly<ScheduleDateFacts>) => {
    const resolved = resolveScheduleVersion(
      schedule,
      startDate,
      targetDate,
      scheduleHistory
    );
    const lastCompletionDate =
      resolved.schedule.type === "interval" &&
      resolved.schedule.fromCompletion === true
        ? findLastSortedDateBefore(
            completionDates,
            targetDate,
            resolved.versionStartDate
          )
        : null;
    if (
      resolved.schedule.type === "interval" &&
      resolved.schedule.fromCompletion === true
    ) {
      if (!lastCompletionDate) {
        return targetDate >= resolved.versionStartDate;
      }
      const cacheKey = `${lastCompletionDate}|${resolved.schedule.every}`;
      let nextDueCivilDay = nextDueDayCache.get(cacheKey);
      if (nextDueCivilDay == null) {
        nextDueCivilDay = getNextDueCivilDay(
          lastCompletionDate,
          resolved.schedule.every
        );
        nextDueDayCache.set(cacheKey, nextDueCivilDay);
      }
      const facts = dateFacts?.date === targetDate ? dateFacts : createScheduleDateFacts(targetDate);
      return facts.civilDayNumber >= nextDueCivilDay;
    }
    let effectiveStartCivilDay: number | undefined;
    if (
      resolved.schedule.type === "interval" &&
      resolved.schedule.fromCompletion !== true &&
      dateFacts?.date === targetDate
    ) {
      effectiveStartCivilDay = startCivilDayCache.get(resolved.startDate);
      if (effectiveStartCivilDay == null) {
        effectiveStartCivilDay = createScheduleDateFacts(
          resolved.startDate,
        ).civilDayNumber;
        startCivilDayCache.set(resolved.startDate, effectiveStartCivilDay);
      }
    }
    return matchesResolvedSchedule(
      resolved.schedule,
      resolved.startDate,
      resolved.versionStartDate,
      targetDate,
      lastCompletionDate,
      dateFacts,
      effectiveStartCivilDay,
    );
  };
}

// Determines if a habit is scheduled for a given date.
// Returns false if targetDate is before startDate.
export function isHabitScheduledForDate(
  schedule: RepeatSchedule,
  startDate: string,
  targetDate: string,
  records?: ScheduleRecord[],
  scheduleHistory?: ScheduleHistoryEntry[]
): boolean {
  const resolved = resolveScheduleVersion(
    schedule,
    startDate,
    targetDate,
    scheduleHistory
  );
  const lastCompletionDate =
    resolved.schedule.type === "interval" &&
    resolved.schedule.fromCompletion === true
      ? findLastCompletionDateBefore(
          records,
          targetDate,
          resolved.versionStartDate
        )
      : null;
  return matchesResolvedSchedule(
    resolved.schedule,
    resolved.startDate,
    resolved.versionStartDate,
    targetDate,
    lastCompletionDate
  );
}

// Reconcile persisted marks with a newly active schedule version.
// Records before the boundary can be preserved for an ordinary repeat edit;
// a start-date edit passes false and revalidates the complete timeline.
export function partitionRecordsForScheduleVersion<T extends ScheduleRecord>(
  records: T[],
  schedule: RepeatSchedule,
  startDate: string,
  effectiveFrom: string,
  preserveBeforeEffectiveFrom: boolean
): ScheduleRecordPartition<T> {
  const versionHistory: ScheduleHistoryEntry[] = [
    { effectiveFrom, startDate, repeatSchedule: schedule },
  ];
  const kept: T[] = [];
  const removed: T[] = [];

  for (const record of [...records].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )) {
    if (preserveBeforeEffectiveFrom && record.date < effectiveFrom) {
      kept.push(record);
      continue;
    }

    if (
      isHabitScheduledForDate(
        schedule,
        startDate,
        record.date,
        kept,
        versionHistory
      )
    ) {
      kept.push(record);
    } else {
      removed.push(record);
    }
  }

  return { kept, removed };
}

export function getEarliestScheduleStartDate(
  startDate: string,
  scheduleHistory?: ScheduleHistoryEntry[]
): string {
  if (!scheduleHistory || scheduleHistory.length === 0) return startDate;
  return scheduleHistory.reduce(
    (earliest, entry) => (entry.startDate < earliest ? entry.startDate : earliest),
    startDate
  );
}
