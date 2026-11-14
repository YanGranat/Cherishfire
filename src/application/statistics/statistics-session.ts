import {
  calculateStatisticsPeriod,
  createStatisticsSourceIndex,
  type StatisticsPeriodStats,
  type StatisticsSourceIndex,
  type StatisticsSourceSnapshot,
} from "@/domain/statistics/statistics-period";
import {
  getOrCreateStatisticsCacheValue,
  getStatisticsCacheKey,
} from "@/application/statistics/statistics-cache";
import type { StatisticsPeriod } from "@/types/settings";
import { prepareStreakStats } from "@/application/statistics/streak-cache";
export type {
  StatisticsBarDataPoint,
  StatisticsHabitBreakdownRow,
  StatisticsHeatmapCell,
  StatisticsPeriodStats,
  StatisticsSourceSnapshot,
} from "@/domain/statistics/statistics-period";
export { EMPTY_STATISTICS_PERIOD_STATS } from "@/domain/statistics/statistics-period";
export interface StatisticsPeriodResult {
  stats: StatisticsPeriodStats;
  cacheHit: boolean;
  sourceSessionCreated: boolean;
  visibleHabitCount: number;
}
export interface StatisticsPeriodTarget {
  period: StatisticsPeriod;
  periodOffset: number;
}
export const CURRENT_STATISTICS_PERIOD_TARGETS: readonly StatisticsPeriodTarget[] =
  [
    { period: "week", periodOffset: 0 },
    { period: "month", periodOffset: 0 },
    { period: "year", periodOffset: 0 },
  ];
interface StatisticsSession {
  source: StatisticsSourceSnapshot;
  index: StatisticsSourceIndex;
  periodCache: Map<string, StatisticsPeriodStats>;
}
// A completed stale preparation may retain its own immutable source revision,
// but it cannot evict the active revision immediately or grow without bound.
export const MAX_STATISTICS_SOURCE_SESSIONS = 3;
let sourceSessions: StatisticsSession[] = [];
let sourceIndexBuildCount = 0;
let periodCalculationCount = 0;
export function getStatisticsResourceCounts() {
  return {
    sourceCount: sourceSessions.length,
    periodCount: sourceSessions.reduce(
      (count, session) => count + session.periodCache.size,
      0,
    ),
    indexBuildCount: sourceIndexBuildCount,
    calculationCount: periodCalculationCount,
  };
}
export function areStatisticsSourcesEqual(
  left: StatisticsSourceSnapshot,
  right: StatisticsSourceSnapshot,
): boolean {
  return (
    left.allHabits === right.allHabits &&
    left.allRecords === right.allRecords &&
    left.showArchivedHabitsInStatistics ===
      right.showArchivedHabitsInStatistics &&
    left.todayStr === right.todayStr
  );
}
function createStatisticsSession(
  source: StatisticsSourceSnapshot,
): StatisticsSession {
  sourceIndexBuildCount += 1;
  const build = () => createStatisticsSourceIndex(source);
  return {
    source,
    index: build(),
    periodCache: new Map(),
  };
}
function getStatisticsSession(source: StatisticsSourceSnapshot): {
  session: StatisticsSession;
  created: boolean;
} {
  const existingIndex = sourceSessions.findIndex((candidate) =>
    areStatisticsSourcesEqual(candidate.source, source),
  );
  if (existingIndex >= 0) {
    const [session] = sourceSessions.splice(existingIndex, 1);
    sourceSessions.push(session);
    return { session, created: false };
  }
  const session = createStatisticsSession(source);
  sourceSessions.push(session);
  while (sourceSessions.length > MAX_STATISTICS_SOURCE_SESSIONS) {
    sourceSessions.shift();
  }
  return { session, created: true };
}
function findStatisticsSession(
  source: StatisticsSourceSnapshot,
): StatisticsSession | null {
  return (
    sourceSessions.find((candidate) =>
      areStatisticsSourcesEqual(candidate.source, source),
    ) ?? null
  );
}
export function getStatisticsPeriod(
  source: StatisticsSourceSnapshot,
  period: StatisticsPeriod,
  periodOffset: number,
): StatisticsPeriodResult {
  const { session, created } = getStatisticsSession(source);
  const resolveCachedPeriod = () =>
    getOrCreateStatisticsCacheValue(
      session.periodCache,
      period,
      periodOffset,
      () => {
        periodCalculationCount += 1;
        const calculate = () =>
          calculateStatisticsPeriod(
            session.index,
            period,
            periodOffset,
            (habit, records, evaluationDate) =>
              prepareStreakStats(habit, records, evaluationDate).stats.current,
          );
        return calculate();
      },
    );
  const cached = resolveCachedPeriod();
  return {
    stats: cached.value,
    cacheHit: cached.cacheHit,
    sourceSessionCreated: created,
    visibleHabitCount: session.index.visibleHabits.length,
  };
}
/**
 * Pure O(1) lookup used by render and press handlers. It does not create a
 * source index, calculate a period or mutate either LRU.
 */
export function peekPreparedStatisticsPeriod(
  source: StatisticsSourceSnapshot,
  period: StatisticsPeriod,
  periodOffset: number,
): StatisticsPeriodResult | null {
  const session = findStatisticsSession(source);
  if (!session) return null;
  const stats = session.periodCache.get(
    getStatisticsCacheKey(period, periodOffset),
  );
  if (!stats) return null;
  return {
    stats,
    cacheHit: true,
    sourceSessionCreated: false,
    visibleHabitCount: session.index.visibleHabits.length,
  };
}
export function prewarmStatisticsPeriods(
  source: StatisticsSourceSnapshot,
  targets: readonly StatisticsPeriodTarget[],
): StatisticsPeriodResult[] {
  return targets.map((target) =>
    getStatisticsPeriod(source, target.period, target.periodOffset),
  );
}
export function resetStatisticsSessionCacheForAudit(): void {
  sourceSessions = [];
  sourceIndexBuildCount = 0;
  periodCalculationCount = 0;
}
export function getStatisticsSourceSessionCountForAudit(): number {
  return sourceSessions.length;
}
export function getStatisticsSourceIndexBuildCountForAudit(): number {
  return sourceIndexBuildCount;
}
export function getStatisticsPeriodCalculationCountForAudit(): number {
  return periodCalculationCount;
}
