import type {
  ArchivePeriod,
  DayRecord,
  Habit,
  ScheduleHistoryEntry,
} from "@/types/habit";
import { areRepeatSchedulesEqual } from "@/types/habit";
import { calculateStreakStats } from "@/domain/habits/streak";

export type CachedStreakStats = ReturnType<typeof calculateStreakStats>;

interface StreakCacheEntry {
  habit: Habit;
  records: readonly DayRecord[];
  evaluationDate: string;
  stats: CachedStreakStats;
}

export const MAX_STREAK_CACHE_ENTRIES = 64;
const streakCache = new Map<string, StreakCacheEntry>();

function archiveHistoriesEqual(
  left: readonly ArchivePeriod[],
  right: readonly ArchivePeriod[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      entry.archivedAt === other.archivedAt &&
      entry.restoredAt === other.restoredAt &&
      entry.archivedDate === other.archivedDate &&
      entry.restoredDate === other.restoredDate
    );
  });
}

function scheduleHistoriesEqual(
  left: readonly ScheduleHistoryEntry[] | undefined,
  right: readonly ScheduleHistoryEntry[] | undefined,
): boolean {
  if (left === right) return true;
  const leftEntries = left ?? [];
  const rightEntries = right ?? [];
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every((entry, index) => {
    const other = rightEntries[index];
    return (
      entry.effectiveFrom === other.effectiveFrom &&
      entry.startDate === other.startDate &&
      areRepeatSchedulesEqual(entry.repeatSchedule, other.repeatSchedule)
    );
  });
}

function recordsHaveSameStreakInputs(
  left: readonly DayRecord[],
  right: readonly DayRecord[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((record, index) => {
    const other = right[index];
    return (
      record.habitId === other.habitId &&
      record.date === other.date &&
      record.status === other.status
    );
  });
}

function entryMatches(
  entry: StreakCacheEntry,
  habit: Habit,
  records: readonly DayRecord[],
  evaluationDate: string,
): boolean {
  return (
    entry.evaluationDate === evaluationDate &&
    entry.habit.id === habit.id &&
    entry.habit.startDate === habit.startDate &&
    areRepeatSchedulesEqual(entry.habit.repeatSchedule, habit.repeatSchedule) &&
    archiveHistoriesEqual(entry.habit.archiveHistory, habit.archiveHistory) &&
    scheduleHistoriesEqual(
      entry.habit.scheduleHistory,
      habit.scheduleHistory,
    ) &&
    recordsHaveSameStreakInputs(entry.records, records)
  );
}

function cacheKey(habitId: number, evaluationDate: string): string {
  return `${habitId}:${evaluationDate}`;
}

/** Pure render-safe lookup. A miss never calculates or mutates cache state. */
export function peekStreakStats(
  habit: Habit,
  records: readonly DayRecord[],
  evaluationDate: string,
): CachedStreakStats | null {
  const entry = streakCache.get(cacheKey(habit.id, evaluationDate));
  return entry && entryMatches(entry, habit, records, evaluationDate)
    ? entry.stats
    : null;
}

/** Calculates and stores one exact domain revision outside React render. */
export function prepareStreakStats(
  habit: Habit,
  records: readonly DayRecord[],
  evaluationDate: string,
): { stats: CachedStreakStats; cacheHit: boolean } {
  const key = cacheKey(habit.id, evaluationDate);
  const existing = streakCache.get(key);
  if (existing && entryMatches(existing, habit, records, evaluationDate)) {
    streakCache.delete(key);
    streakCache.set(key, existing);
    return { stats: existing.stats, cacheHit: true };
  }

  const stats = calculateStreakStats(
    [...records],
    habit.repeatSchedule,
    habit.startDate,
    habit.archiveHistory,
    habit.scheduleHistory,
    evaluationDate,
  );
  rememberStreakStats(habit, records, evaluationDate, stats);
  return { stats, cacheHit: false };
}

export function rememberStreakStats(
  habit: Habit,
  records: readonly DayRecord[],
  evaluationDate: string,
  stats: CachedStreakStats,
): void {
  const key = cacheKey(habit.id, evaluationDate);
  streakCache.delete(key);
  streakCache.set(key, { habit, records, evaluationDate, stats });
  while (streakCache.size > MAX_STREAK_CACHE_ENTRIES) {
    const oldestKey = streakCache.keys().next().value;
    if (oldestKey == null) break;
    streakCache.delete(oldestKey);
  }
}

export function resetStreakCacheForAudit(): void {
  streakCache.clear();
}

export function getStreakCacheSizeForAudit(): number {
  return streakCache.size;
}
