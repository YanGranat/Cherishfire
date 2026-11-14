import assert, { AssertionError } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eachDayOfInterval, format, parseISO } from "date-fns";
import {
  expectedStatisticsEquivalenceHashes,
  statisticsEquivalenceFixtures,
} from "./fixtures/statistics-equivalence-fixtures";
import {
  loadStatisticsHookForAudit,
  validateStatisticsHookAuditTransform,
  type StatisticsHookAuditSourceOptions,
} from "./fixtures/load-statistics-hook-for-audit";
import {
  findAuditElements,
  loadBarChartForAudit,
  loadHabitBreakdownForAudit,
  loadStatisticsScreenForAudit,
  shallowPropsEqual,
  validateBarChartAuditTransform,
  validateHabitBreakdownAuditTransform,
  validateStatisticsScreenAuditTransform,
  type AuditElement,
} from "./fixtures/load-statistics-render-for-audit";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import { calculatePeriodProgress } from "../src/domain/statistics/period-progress";
import {
  getOrCreateStatisticsCacheValue,
  getStatisticsCacheKey,
  MAX_STATISTICS_CACHE_ENTRIES,
} from "../src/application/statistics/statistics-cache";
import {
  CURRENT_STATISTICS_PERIOD_TARGETS,
  getStatisticsPeriodCalculationCountForAudit,
  getStatisticsSourceSessionCountForAudit,
  getStatisticsSourceIndexBuildCountForAudit,
  getStatisticsPeriod,
  MAX_STATISTICS_SOURCE_SESSIONS,
  peekPreparedStatisticsPeriod,
  prewarmStatisticsPeriods,
  resetStatisticsSessionCacheForAudit,
  type StatisticsSourceSnapshot,
} from "../src/application/statistics/statistics-session";
import {
  canNavigateStatisticsBackward,
  canNavigateStatisticsForward,
  getStatisticsNavigationTarget,
  isLatestStatisticsPreparation,
  normalizeStatisticsTargetForBase,
} from "../src/application/statistics/statistics-preparation";
import { isHabitScheduledForDate } from "../src/domain/habits/schedule";
import {
  calculateStatisticsPeriod,
  createStatisticsSourceIndex,
  getStatisticsPeriodRange,
} from "../src/domain/statistics/statistics-period";
import { getPeriodLabel } from "../src/utils/date";
import {
  peekStreakStats,
  resetStreakCacheForAudit,
} from "../src/application/statistics/streak-cache";
import type {
  DayRecord,
  DayStatus,
  Habit,
  RepeatSchedule,
  ScheduleHistoryEntry,
} from "../src/types/habit";
type StatusByDate = Readonly<Record<string, DayStatus | undefined>>;
function scheduledStatusesForPeriod(
  schedule: RepeatSchedule,
  habitStartDate: string,
  periodStartDate: string,
  periodEndDate: string,
  statusByDate: StatusByDate = {},
  scheduleHistory?: ScheduleHistoryEntry[],
): (DayStatus | undefined)[] {
  const records = Object.entries(statusByDate).flatMap(([date, status]) =>
    status ? [{ date, status }] : [],
  );
  return eachDayOfInterval({
    start: parseISO(periodStartDate),
    end: parseISO(periodEndDate),
  }).flatMap((date) => {
    const dateStr = format(date, "yyyy-MM-dd");
    return isHabitScheduledForDate(
      schedule,
      habitStartDate,
      dateStr,
      records,
      scheduleHistory,
    )
      ? [statusByDate[dateStr]]
      : [];
  });
}
const daily: RepeatSchedule = { type: "daily" };
const mondayWeek = calculatePeriodProgress(
  scheduledStatusesForPeriod(daily, "2026-07-20", "2026-07-20", "2026-07-26", {
    "2026-07-20": "done",
  }),
);
assert.deepEqual(mondayWeek, {
  completed: 1,
  planned: 7,
  occurrences: 7,
  percentageLabel: "14",
});
const tuesdayStart = calculatePeriodProgress(
  scheduledStatusesForPeriod(daily, "2026-07-21", "2026-07-20", "2026-07-26", {
    "2026-07-21": "done",
  }),
);
assert.equal(tuesdayStart.planned, 6, "Tuesday start must leave six week days");
assert.equal(tuesdayStart.percentageLabel, "17");
const skippedAndFailed = calculatePeriodProgress(
  scheduledStatusesForPeriod(daily, "2026-07-20", "2026-07-20", "2026-07-26", {
    "2026-07-20": "done",
    "2026-07-21": "skipped",
    "2026-07-22": "failure",
  }),
);
assert.equal(skippedAndFailed.planned, 6, "skip must cancel one obligation");
assert.equal(
  skippedAndFailed.completed,
  1,
  "failure must not count as completed",
);
assert.equal(skippedAndFailed.percentageLabel, "17");
for (const [start, end, expectedDays] of [
  ["2024-02-01", "2024-02-29", 29],
  ["2026-02-01", "2026-02-28", 28],
  ["2026-04-01", "2026-04-30", 30],
  ["2026-07-01", "2026-07-31", 31],
] as const) {
  const progress = calculatePeriodProgress(
    scheduledStatusesForPeriod(daily, start, start, end),
  );
  assert.equal(progress.planned, expectedDays, `${start}..${end}`);
}
const partialMonth = calculatePeriodProgress(
  scheduledStatusesForPeriod(daily, "2026-07-10", "2026-07-01", "2026-07-31"),
);
assert.equal(
  partialMonth.planned,
  22,
  "month must begin at the habit start date",
);
const missingDayOfMonth = calculatePeriodProgress(
  scheduledStatusesForPeriod(
    { type: "monthly", dates: [15, 31] },
    "2026-04-01",
    "2026-04-01",
    "2026-04-30",
  ),
);
assert.equal(
  missingDayOfMonth.planned,
  1,
  "a nonexistent day 31 must not become an April obligation",
);
const leapYearStatuses = scheduledStatusesForPeriod(
  daily,
  "2024-01-01",
  "2024-01-01",
  "2024-12-31",
  { "2024-01-01": "maximum" },
);
const leapYear = calculatePeriodProgress(leapYearStatuses);
assert.equal(leapYear.planned, 366);
assert.equal(leapYear.percentageLabel, "<1");
const commonYearStatuses = scheduledStatusesForPeriod(
  daily,
  "2026-01-01",
  "2026-01-01",
  "2026-12-31",
);
assert.equal(calculatePeriodProgress(commonYearStatuses).planned, 365);
const nearlyComplete = calculatePeriodProgress([
  ...Array<DayStatus>(364).fill("done"),
  undefined,
]);
assert.equal(
  nearlyComplete.percentageLabel,
  "99",
  "rounding must not show 100% before the period is complete",
);
assert.equal(
  calculatePeriodProgress(Array<DayStatus>(365).fill("done")).percentageLabel,
  "100",
);
const allSkipped = calculatePeriodProgress(Array<DayStatus>(7).fill("skipped"));
assert.deepEqual(allSkipped, {
  completed: 0,
  planned: 0,
  occurrences: 7,
  percentageLabel: "—",
});
const statisticsCache = new Map<
  string,
  {
    marker: string;
  }
>();
let calculationCount = 0;
const calculate = (marker: string) => {
  calculationCount += 1;
  return { marker };
};
const weekFirst = getOrCreateStatisticsCacheValue(
  statisticsCache,
  "week",
  0,
  () => calculate("week"),
);
const monthFirst = getOrCreateStatisticsCacheValue(
  statisticsCache,
  "month",
  0,
  () => calculate("month"),
);
const weekAgain = getOrCreateStatisticsCacheValue(
  statisticsCache,
  "week",
  0,
  () => calculate("unexpected"),
);
assert.equal(weekFirst.cacheHit, false);
assert.equal(monthFirst.cacheHit, false);
assert.equal(weekAgain.cacheHit, true);
assert.equal(weekAgain.value, weekFirst.value);
assert.equal(calculationCount, 2, "a visited period must not be recalculated");
assert.notEqual(
  getStatisticsCacheKey("week", 0),
  getStatisticsCacheKey("month", 0),
  "periods must never share a cache entry",
);
for (let offset = 1; offset <= MAX_STATISTICS_CACHE_ENTRIES + 2; offset += 1) {
  getOrCreateStatisticsCacheValue(statisticsCache, "year", -offset, () => ({
    marker: `year-${offset}`,
  }));
}
assert.equal(
  statisticsCache.size,
  MAX_STATISTICS_CACHE_ENTRIES,
  "statistics cache must remain bounded",
);
const lruCache = new Map<
  string,
  {
    marker: string;
  }
>();
for (let offset = 0; offset < MAX_STATISTICS_CACHE_ENTRIES; offset += 1) {
  getOrCreateStatisticsCacheValue(lruCache, "year", -offset, () => ({
    marker: `year-${offset}`,
  }));
}
getOrCreateStatisticsCacheValue(lruCache, "year", 0, () => ({
  marker: "unexpected",
}));
getOrCreateStatisticsCacheValue(
  lruCache,
  "year",
  -MAX_STATISTICS_CACHE_ENTRIES,
  () => ({ marker: "new-year" }),
);
assert.equal(
  lruCache.has(getStatisticsCacheKey("year", 0)),
  true,
  "a recently revisited current period must survive the next eviction",
);
assert.equal(
  lruCache.has(getStatisticsCacheKey("year", -1)),
  false,
  "the least recently viewed period must be evicted",
);
function createStatisticsHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 1,
    name: "Daily",
    description: null,
    descriptionVisible: true,
    repeatSchedule: { type: "daily" },
    scheduleHistory: [
      {
        effectiveFrom: "2026-08-24",
        startDate: "2026-08-24",
        repeatSchedule: { type: "daily" },
      },
    ],
    startDate: "2026-08-24",
    reminderEnabled: false,
    reminderTime: null,
    displayOrder: 0,
    isArchived: false,
    archivedAt: null,
    archiveHistory: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
function createStatisticsRecord(overrides: Partial<DayRecord> = {}): DayRecord {
  return {
    id: 1,
    habitId: 1,
    date: "2026-08-29",
    status: "done",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
function createStatisticsSource(
  overrides: Partial<StatisticsSourceSnapshot> = {},
): StatisticsSourceSnapshot {
  return {
    allHabits: [createStatisticsHabit()],
    allRecords: [createStatisticsRecord()],
    showArchivedHabitsInStatistics: true,
    todayStr: "2026-08-29",
    ...overrides,
  };
}
const activityDate = "2026-08-25";
const activityHabits = Array.from({ length: 3 }, (_, index) =>
  createStatisticsHabit({ id: index + 1, name: `Activity ${index + 1}` }),
);
const archivedActivityHabit = createStatisticsHabit({
  id: 4,
  name: "Archived activity",
  isArchived: true,
  archivedAt: 1,
  archiveHistory: [
    {
      archivedAt: 1,
      archivedDate: "2026-09-01",
      restoredAt: null,
    },
  ],
});
const activityRecords = activityHabits.map((habit) =>
  createStatisticsRecord({
    id: habit.id,
    habitId: habit.id,
    date: activityDate,
  }),
);
for (const archiveIncluded of [false, true]) {
  const activitySource = createStatisticsSource({
    allHabits: [...activityHabits, archivedActivityHabit],
    allRecords: activityRecords,
    showArchivedHabitsInStatistics: archiveIncluded,
    todayStr: "2026-09-05",
  });
  for (const [period, offset] of [
    ["week", -1],
    ["month", -1],
    ["year", 0],
  ] as const) {
    const result = getStatisticsPeriod(activitySource, period, offset);
    const day = result.stats.heatmapData.find(
      (cell) => cell.date === activityDate,
    )!;
    assert.deepEqual(day, {
      date: activityDate,
      score: archiveIncluded ? -1 : 4 / 3,
      scheduledCount: archiveIncluded ? 4 : 3,
      completedCount: 3,
      archivedScheduledCount: archiveIncluded ? 1 : 0,
      archivedCompletedCount: 0,
      uncoveredRedCount: archiveIncluded ? 1 : 0,
    });
    assert.equal(result.stats.perfectDays.count, archiveIncluded ? 0 : 1);
    assert.equal(
      result.stats.barChartData.find((point) => point.label === activityDate)
        ?.value,
      archiveIncluded ? 75 : 100,
    );
    const cached = getStatisticsPeriod(activitySource, period, offset);
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.stats, result.stats);
  }
}
for (const archivedStatus of [
  "done",
  "minimum",
  "maximum",
  "skipped",
  "failure",
  undefined,
] as const) {
  const source = createStatisticsSource({
    allHabits: [...activityHabits, archivedActivityHabit],
    allRecords:
      archivedStatus == null
        ? activityRecords
        : [
            ...activityRecords,
            createStatisticsRecord({
              id: 4,
              habitId: 4,
              date: activityDate,
              status: archivedStatus,
            }),
          ],
    todayStr: "2026-09-05",
  });
  const stats = getStatisticsPeriod(source, "week", -1).stats;
  const day = stats.heatmapData[1];
  const successful =
    archivedStatus === "done" ||
    archivedStatus === "minimum" ||
    archivedStatus === "maximum";
  assert.equal(
    day.archivedScheduledCount,
    archivedStatus === "skipped" ? 0 : 1,
  );
  assert.equal(day.archivedCompletedCount, successful ? 1 : 0);
  assert.equal(day.scheduledCount, archivedStatus === "skipped" ? 3 : 4);
  assert.equal(day.completedCount, successful ? 4 : 3);
  assert.equal(
    day.uncoveredRedCount,
    successful || archivedStatus === "skipped" ? 0 : 1,
  );
  assert.equal(day.score > 0, successful || archivedStatus === "skipped");
}
const neutralizedSource = createStatisticsSource({
  allHabits: [activityHabits[0], archivedActivityHabit],
  allRecords: [
    createStatisticsRecord({
      habitId: 1,
      date: activityDate,
      status: "maximum",
    }),
  ],
  todayStr: "2026-09-05",
});
const neutralized = getStatisticsPeriod(neutralizedSource, "week", -1).stats
  .heatmapData[1];
assert.equal(neutralized.uncoveredRedCount, 0);
assert.equal(neutralized.score, 2 / 3);
assert.equal(neutralized.archivedScheduledCount, 1);
assert.equal(neutralized.archivedCompletedCount, 0);
const pausedSource = createStatisticsSource({
  allHabits: [
    createStatisticsHabit({
      ...archivedActivityHabit,
      archiveHistory: [
        {
          archivedAt: 1,
          archivedDate: "2026-08-24",
          restoredAt: 2,
          restoredDate: "2026-08-27",
        },
      ],
    }),
  ],
  allRecords: [],
  todayStr: "2026-08-25",
});
const pausedWeek = getStatisticsPeriod(pausedSource, "week", 0).stats;
assert.equal(pausedWeek.heatmapData[1].scheduledCount, 0);
assert.equal(pausedWeek.heatmapData[1].score, 0);
assert.equal(pausedWeek.heatmapData[3].scheduledCount, 1);
assert.equal(pausedWeek.heatmapData[3].uncoveredRedCount, 0);
assert.equal(pausedWeek.heatmapData[3].score, 0);
const skippedSource = createStatisticsSource({
  allRecords: eachDayOfInterval({
    start: parseISO("2026-08-24"),
    end: parseISO("2026-08-30"),
  }).map((day, index) =>
    createStatisticsRecord({
      id: index + 1,
      date: format(day, "yyyy-MM-dd"),
      status: "skipped",
    }),
  ),
  todayStr: "2026-08-30",
});
const skippedStats = getStatisticsPeriod(skippedSource, "week", 0).stats;
assert.equal(skippedStats.periodProgress, "—");
assert.equal(skippedStats.progressCounts.planned, 0);
assert.equal(skippedStats.progressCounts.occurrences, 7);
const fractionalSource = createStatisticsSource({
  allHabits: [
    createStatisticsHabit({ startDate: "2026-01-01", scheduleHistory: [] }),
  ],
});
const fractionalStats = getStatisticsPeriod(fractionalSource, "year", 0).stats;
assert.equal(fractionalStats.periodProgress, "<1");
assert.equal(fractionalStats.progressCounts.completed, 1);
assert.equal(fractionalStats.progressCounts.planned, 365);
for (const fixture of statisticsEquivalenceFixtures) {
  resetStatisticsSessionCacheForAudit();
  resetStreakCacheForAudit();
  for (const target of fixture.targets) {
    const stats = getStatisticsPeriod(
      fixture.source,
      target.period,
      target.periodOffset,
    ).stats;
    const key = `${fixture.name}:${target.period}:${target.periodOffset}`;
    const semanticProjection = {
      ...Object.fromEntries(
        Object.entries(stats).filter(([key]) => key !== "progressCounts"),
      ),
      heatmapData: stats.heatmapData.map(({ date, score }) => ({
        date,
        score,
      })),
    };
    assert.equal(
      createHash("sha256")
        .update(JSON.stringify(semanticProjection))
        .digest("hex"),
      expectedStatisticsEquivalenceHashes.get(key),
      `${key} must remain bit-for-bit equivalent to the frozen statistics fixtures`,
    );
  }
  assert.equal(
    getStatisticsSourceIndexBuildCountForAudit(),
    1,
    `${fixture.name} must build record/schedule indexes once for all six targets`,
  );
  assert.equal(
    getStatisticsPeriodCalculationCountForAudit(),
    fixture.targets.length,
    `${fixture.name} must calculate each cold target exactly once`,
  );
  for (const target of fixture.targets) {
    assert.equal(
      getStatisticsPeriod(fixture.source, target.period, target.periodOffset)
        .cacheHit,
      true,
      `${fixture.name}:${target.period}:${target.periodOffset} must reuse its period model`,
    );
  }
  assert.equal(
    getStatisticsPeriodCalculationCountForAudit(),
    fixture.targets.length,
    `${fixture.name} cache hits must not repeat domain calculations`,
  );
}
resetStatisticsSessionCacheForAudit();
resetStreakCacheForAudit();
const sharedSource = createStatisticsSource();
const rapidSourceReplacement = createStatisticsSource({
  allRecords: [createStatisticsRecord({ status: "failure" })],
});
const abandonedWeek = {
  revision: 1,
  source: sharedSource,
  target: { period: "week" as const, periodOffset: 0 },
};
const rapidPeriodCandidates = [
  abandonedWeek,
  {
    revision: 2,
    source: sharedSource,
    target: { period: "month" as const, periodOffset: 0 },
  },
  {
    revision: 3,
    source: sharedSource,
    target: { period: "year" as const, periodOffset: 0 },
  },
];
assert.deepEqual(
  rapidPeriodCandidates.map((candidate) =>
    isLatestStatisticsPreparation({
      candidate,
      latestRevision: 3,
      latestSource: sharedSource,
      latestTarget: rapidPeriodCandidates[2].target,
    }),
  ),
  [false, false, true],
  "rapid week → month → year may publish only the final complete target",
);
assert.equal(
  isLatestStatisticsPreparation({
    candidate: abandonedWeek,
    latestRevision: 3,
    latestSource: sharedSource,
    latestTarget: { period: "year", periodOffset: 0 },
  }),
  false,
  "rapid week → month → year must reject the completed week calculation",
);
assert.equal(
  isLatestStatisticsPreparation({
    candidate: abandonedWeek,
    latestRevision: 1,
    latestSource: rapidSourceReplacement,
    latestTarget: abandonedWeek.target,
  }),
  false,
  "an old source revision must never publish after records change",
);
const rapidOffsetCandidates = [0, -1, -2].map((periodOffset, index) => ({
  revision: 4 + index,
  source: rapidSourceReplacement,
  target: { period: "month" as const, periodOffset },
}));
assert.deepEqual(
  rapidOffsetCandidates.map((candidate) =>
    isLatestStatisticsPreparation({
      candidate,
      latestRevision: 6,
      latestSource: rapidSourceReplacement,
      latestTarget: rapidOffsetCandidates[2].target,
    }),
  ),
  [false, false, true],
  "rapid current → previous → previous navigation may publish only the final offset",
);
const requestedCurrentWeek = { period: "week" as const, periodOffset: 0 };
const requestedPreviousWeek = getStatisticsNavigationTarget(
  requestedCurrentWeek,
  "prev",
  "2026-11-13",
);
const requestedTwoWeeksAgo = getStatisticsNavigationTarget(
  requestedPreviousWeek,
  "prev",
  "2026-11-13",
);
assert.deepEqual(
  [requestedPreviousWeek.periodOffset, requestedTwoWeeksAgo.periodOffset],
  [-1, -2],
  "rapid previous taps must derive each action target from the latest requested offset",
);
assert.equal(
  canNavigateStatisticsForward(requestedPreviousWeek, "2026-11-13"),
  true,
  "a cold previous request must immediately enable return to the current period",
);
assert.deepEqual(
  getStatisticsNavigationTarget(requestedPreviousWeek, "next", "2026-11-13"),
  requestedCurrentWeek,
  "cold current → previous → current must preserve the final requested intent",
);
const supersededSourceCandidate = {
  revision: 7,
  source: sharedSource,
  target: { period: "month" as const, periodOffset: -2 },
};
const currentSourceCandidate = {
  revision: 8,
  source: rapidSourceReplacement,
  target: supersededSourceCandidate.target,
};
assert.deepEqual(
  [supersededSourceCandidate, currentSourceCandidate].map((candidate) =>
    isLatestStatisticsPreparation({
      candidate,
      latestRevision: 8,
      latestSource: rapidSourceReplacement,
      latestTarget: currentSourceCandidate.target,
    }),
  ),
  [false, true],
  "a source invalidation during rapid navigation must reject every old-source result",
);
assert.equal(
  isLatestStatisticsPreparation({
    candidate: abandonedWeek,
    latestRevision: 1,
    latestSource: sharedSource,
    latestTarget: abandonedWeek.target,
  }),
  true,
  "the exact latest source and target revision must remain publishable",
);
const rapidReturnToWeek = {
  revision: 3,
  source: sharedSource,
  target: { period: "week" as const, periodOffset: 0 },
};
assert.deepEqual(
  [abandonedWeek, rapidReturnToWeek].map((candidate) =>
    isLatestStatisticsPreparation({
      candidate,
      latestRevision: rapidReturnToWeek.revision,
      latestSource: sharedSource,
      latestTarget: rapidReturnToWeek.target,
    }),
  ),
  [false, true],
  "rapid week → month → week must reject the old week and publish only the latest week revision",
);
assert.equal(
  peekPreparedStatisticsPeriod(sharedSource, "week", 0),
  null,
  "render-safe lookup must never calculate a missing source or period",
);
const currentPrewarm = prewarmStatisticsPeriods(
  sharedSource,
  CURRENT_STATISTICS_PERIOD_TARGETS,
);
assert.ok(
  peekStreakStats(
    { ...sharedSource.allHabits[0], name: "Detail copy" },
    sharedSource.allRecords.map((record) => ({ ...record })),
    sharedSource.todayStr,
  ),
  "current Statistics prewarm must prepare the exact streak domain model reused by Habit detail",
);
assert.deepEqual(
  currentPrewarm.map((result) => result.cacheHit),
  [false, false, false],
  "Home must calculate each current period exactly once for a fresh source",
);
assert.equal(
  getStatisticsSourceIndexBuildCountForAudit(),
  1,
  "week/month/year must share one deterministic source index",
);
assert.equal(
  getStatisticsPeriodCalculationCountForAudit(),
  CURRENT_STATISTICS_PERIOD_TARGETS.length,
  "each current period must have one cold calculation",
);
for (const [index, target] of CURRENT_STATISTICS_PERIOD_TARGETS.entries()) {
  const prepared = peekPreparedStatisticsPeriod(
    sharedSource,
    target.period,
    target.periodOffset,
  );
  assert.ok(
    prepared,
    `${target.period} must be available to a pure cache peek`,
  );
  assert.equal(
    prepared.stats,
    currentPrewarm[index].stats,
    "a render-safe peek must return the exact prepared presentation model",
  );
  const reused = getStatisticsPeriod(
    sharedSource,
    target.period,
    target.periodOffset,
  );
  assert.equal(
    reused.cacheHit,
    true,
    `${target.period} must reuse Home prewarm`,
  );
  assert.equal(
    reused.stats,
    currentPrewarm[index].stats,
    `${target.period} must return the exact cached presentation model`,
  );
}
const neighbourPrewarm = prewarmStatisticsPeriods(sharedSource, [
  { period: "week", periodOffset: -1 },
]);
assert.equal(neighbourPrewarm[0].cacheHit, false);
assert.equal(
  getStatisticsPeriod(sharedSource, "week", -1).cacheHit,
  true,
  "an idle offset-1 neighbour must be reused by the next navigation",
);
const renamedHabits = [
  { ...sharedSource.allHabits[0], name: "Renamed", updatedAt: 2 },
];
const afterHabitChange = getStatisticsPeriod(
  { ...sharedSource, allHabits: renamedHabits },
  "week",
  0,
);
assert.equal(afterHabitChange.cacheHit, false);
assert.equal(afterHabitChange.stats.habitBreakdown[0]?.name, "Renamed");
assert.equal(
  getStatisticsPeriod({ ...sharedSource, allHabits: renamedHabits }, "week", 0)
    .cacheHit,
  true,
  "a stable replacement habit reference must be reusable",
);
const failedRecords = [createStatisticsRecord({ status: "failure" })];
const afterRecordChange = getStatisticsPeriod(
  { ...sharedSource, allRecords: failedRecords },
  "week",
  0,
);
assert.equal(afterRecordChange.cacheHit, false);
assert.equal(afterRecordChange.stats.periodProgress, "0");
const archivedHabits = [
  createStatisticsHabit({ isArchived: true, archivedAt: 2 }),
];
const includedArchive = getStatisticsPeriod(
  {
    ...sharedSource,
    allHabits: archivedHabits,
    showArchivedHabitsInStatistics: true,
  },
  "week",
  0,
);
assert.equal(includedArchive.cacheHit, false);
assert.equal(includedArchive.stats.emptyReason, null);
const excludedArchive = getStatisticsPeriod(
  {
    ...sharedSource,
    allHabits: archivedHabits,
    showArchivedHabitsInStatistics: false,
  },
  "week",
  0,
);
assert.equal(excludedArchive.cacheHit, false);
assert.equal(excludedArchive.stats.emptyReason, "no-habits");
const nextDay = getStatisticsPeriod(
  { ...sharedSource, todayStr: "2026-08-30" },
  "week",
  0,
);
assert.equal(nextDay.cacheHit, false);
assert.equal(
  nextDay.stats.barChartData.find((point) => point.isToday)?.label,
  "2026-08-30",
  "a local-day change must rebuild both period boundaries and today markers",
);
resetStatisticsSessionCacheForAudit();
for (
  let revision = 0;
  revision < MAX_STATISTICS_SOURCE_SESSIONS + 2;
  revision += 1
) {
  getStatisticsPeriod(
    createStatisticsSource({
      allRecords: [createStatisticsRecord({ updatedAt: revision + 1 })],
    }),
    "week",
    0,
  );
}
assert.equal(
  getStatisticsSourceSessionCountForAudit(),
  MAX_STATISTICS_SOURCE_SESSIONS,
  "completed stale prewarms must remain isolated inside a bounded source LRU",
);
function runInitialColdLifecycle(
  source: StatisticsHookAuditSourceOptions = {},
): void {
  const harness = loadStatisticsHookForAudit(source);
  try {
    assert.equal(harness.current().retainedScene, null);
    assert.equal(harness.current().isLoading, true);
    assert.equal(harness.calculationCalls.length, 0);
    harness.focus();
    harness.flushAll();
    assert.equal(
      harness.calculationCalls.length,
      0,
      "an initial cold focus must publish loading before calculation",
    );
    assert.equal(harness.deferredTaskCount, 1);
    harness.flushDeferred();
    assert.equal(harness.current().sceneActive, true);
    assert.equal(harness.current().isLoading, false);
    assert.equal(harness.calculationCalls.length, 1);
  } finally {
    harness.unmount();
  }
}
function runCivilDatePresentationLifecycle(
  source: StatisticsHookAuditSourceOptions = {},
): void {
  const harness = loadStatisticsHookForAudit({
    ...source,
    initiallyPrepared: true,
  });
  try {
    harness.focus();
    harness.flushAll();
    assert.equal(harness.current().periodBaseCivilDate, "2026-11-13");
    assert.equal(harness.current().retainedScene?.todayStr, "2026-11-13");
    harness.blur();
    harness.flushAll();
    harness.setDate("2026-11-14");
    harness.flushAll();
    assert.equal(
      harness.current().periodBaseCivilDate,
      "2026-11-13",
      "a masked retained request must keep its own civil-date label basis",
    );
    assert.equal(
      harness.current().retainedScene?.todayStr,
      "2026-11-13",
      "a masked retained heatmap must keep the same civil-date basis as its data",
    );
    harness.focus();
    harness.flushAll();
    assert.equal(
      harness.current().periodBaseCivilDate,
      "2026-11-14",
      "the promoted request and period label must share one civil-date basis",
    );
    assert.equal(
      harness.current().retainedScene?.todayStr,
      "2026-11-14",
      "the promoted heatmap and request must share one civil-date basis",
    );
    assert.match(
      harness.current().retainedScene?.stats.marker ?? "",
      /2026-11-14/,
    );
  } finally {
    harness.unmount();
  }
}
function runCivilBoundaryLifecycle(
  source: StatisticsHookAuditSourceOptions = {},
): void {
  const initialBoundaryTarget = (hookSource: string) =>
    replaceExactlyOnce(
      hookSource,
      `  const requestedTargetRef = useRef<StatisticsTarget>({
    period: "week",
    periodOffset: 0,
  });`,
      `  const requestedTargetRef = useRef<StatisticsTarget>({
    period: "year",
    periodOffset: -2025,
  });`,
    );
  const harness = loadStatisticsHookForAudit({
    ...source,
    transform:
      source.transform == null
        ? initialBoundaryTarget
        : (hookSource) =>
            source.transform?.(initialBoundaryTarget(hookSource)) ?? hookSource,
  });
  try {
    harness.focus();
    harness.flushAll();
    harness.flushDeferred();
    assert.equal(harness.current().period, "year");
    assert.equal(harness.current().periodOffset, -2025);
    assert.deepEqual(
      [
        harness.current().periodRange.startDate,
        harness.current().periodRange.endDate,
      ],
      ["0001-01-01", "0001-12-31"],
    );
    assert.equal(harness.current().canNavigatePrevious, false);
    harness.setDate("2025-11-13");
    harness.flushAll();
    assert.equal(
      harness.current().periodOffset,
      -2024,
      "a source-date change must keep the requested year inside the public range",
    );
    assert.equal(
      harness.current().sceneActive,
      true,
      "the normalized source target must publish a ready presentation",
    );
    assert.equal(harness.current().periodRange.startDate, "0001-01-01");
    const staleNext = harness.current().resolveNavigationTarget("next");
    harness.setDate("2024-11-13");
    harness.flushAll();
    assert.equal(harness.current().periodOffset, -2023);
    harness.current().navigatePeriod("next", staleNext);
    harness.flushAll();
    assert.equal(
      harness.current().periodOffset,
      -2023,
      "a target resolved for an older source date must not bypass current admission",
    );
    const rapidNext = harness.current().resolveNavigationTarget("next");
    harness.current().navigatePeriod("next", rapidNext);
    const rapidPrevious = harness.current().resolveNavigationTarget("prev");
    harness.current().navigatePeriod("prev", rapidPrevious);
    harness.flushAll();
    assert.equal(
      harness.current().periodOffset,
      -2023,
      "rapid next and previous input must resolve from the latest admitted target",
    );
  } finally {
    harness.unmount();
  }
}
function runRetainedFocusLifecycle(
  source: StatisticsHookAuditSourceOptions = {},
): void {
  const harness = loadStatisticsHookForAudit({
    ...source,
    initiallyPrepared: true,
  });
  try {
    harness.focus();
    harness.flushAll();
    const initialStats = harness.current().retainedScene?.stats;
    const initialRevision =
      harness.current().retainedScene?.presentationRevision;
    assert.ok(initialStats);
    assert.equal(harness.calculationCalls.length, 0);
    harness.blur();
    harness.flushAll();
    assert.equal(
      harness.current().sceneActive,
      false,
      "blur must mask the retained scene before a later source mutation",
    );
    assert.equal(harness.current().isLoading, true);
    harness.focus();
    harness.flushAll();
    assert.equal(harness.current().sceneActive, true);
    assert.equal(harness.current().retainedScene?.stats, initialStats);
    assert.equal(
      harness.current().retainedScene?.presentationRevision,
      initialRevision,
      "an unchanged Back must reveal the same scene revision",
    );
    assert.equal(
      harness.calculationCalls.length,
      0,
      "an unchanged Back must not calculate or remount content",
    );
    harness.blur();
    harness.flushAll();
    harness.replaceRecords("records-hidden");
    harness.flushAll();
    assert.equal(
      harness.calculationCalls.length,
      0,
      "a hidden source change must not start statistics work",
    );
    assert.equal(harness.current().retainedScene?.stats, initialStats);
    assert.equal(harness.current().sceneActive, false);
    harness.focus();
    harness.flushAll();
    assert.equal(
      harness.calculationCalls.length,
      1,
      "a changed Back with a retained scene must calculate immediately",
    );
    assert.equal(harness.deferredTaskCount, 0);
    assert.match(
      harness.current().retainedScene?.stats.marker ?? "",
      /records-hidden/,
    );
    assert.equal(harness.current().sceneActive, true);
  } finally {
    harness.unmount();
  }
}
function runVisibleSourceLifecycle(
  source: StatisticsHookAuditSourceOptions = {},
): void {
  const harness = loadStatisticsHookForAudit({
    ...source,
    initiallyPrepared: true,
  });
  try {
    harness.focus();
    harness.flushAll();
    const initialStats = harness.current().retainedScene?.stats;
    harness.replaceRecords("records-visible");
    harness.flushRenderAndLayout();
    assert.equal(
      harness.current().sceneActive,
      false,
      "a visible source mismatch must commit its mask before calculation",
    );
    assert.equal(harness.current().retainedScene?.stats, initialStats);
    assert.equal(harness.calculationCalls.length, 0);
    harness.flushAll();
    assert.equal(harness.current().sceneActive, true);
    assert.match(
      harness.current().retainedScene?.stats.marker ?? "",
      /records-visible/,
    );
    assert.equal(harness.deferredTaskCount, 0);
  } finally {
    harness.unmount();
  }
}
function runRapidSourceLifecycle(): void {
  const harness = loadStatisticsHookForAudit({ initiallyPrepared: true });
  try {
    harness.focus();
    harness.flushAll();
    harness.replaceRecords("records-b");
    harness.replaceRecords("records-c");
    harness.flushAll();
    assert.equal(harness.calculationCalls.length, 1);
    assert.match(harness.calculationCalls[0], /records-c/);
    assert.match(
      harness.current().retainedScene?.stats.marker ?? "",
      /records-c/,
    );
    const currentStats = harness.current().retainedScene?.stats;
    harness.onNextCalculation(() => harness.replaceRecords("records-e"));
    harness.replaceRecords("records-d");
    harness.flushRenderAndLayout();
    harness.flushPassiveStep();
    harness.flushRenderAndLayout();
    assert.equal(
      harness.current().retainedScene?.stats,
      currentStats,
      "a calculation superseded by a newer source must not replace the retained scene",
    );
    assert.equal(harness.current().sceneActive, false);
    harness.flushAll();
    assert.match(
      harness.current().retainedScene?.stats.marker ?? "",
      /records-e/,
    );
    assert.equal(harness.current().sceneActive, true);
  } finally {
    harness.unmount();
  }
}
function runTargetAndRetryLifecycle(
  source: StatisticsHookAuditSourceOptions = {},
): void {
  const harness = loadStatisticsHookForAudit({
    ...source,
    initiallyPrepared: true,
  });
  const previousConsoleError = console.error;
  console.error = () => undefined;
  try {
    harness.focus();
    harness.flushAll();
    harness.current().setPeriod("month");
    assert.equal(
      harness.calculationCalls.length,
      1,
      "a cold target with a retained scene must calculate in the accepted action",
    );
    assert.equal(harness.deferredTaskCount, 0);
    assert.equal(
      harness.current().period,
      "week",
      "the old coherent frame remains committed until the atomic ready update",
    );
    harness.flushAll();
    assert.equal(harness.current().period, "month");
    assert.equal(harness.current().retainedScene?.period, "month");
    assert.equal(harness.current().sceneActive, true);
    const readyStats = harness.current().retainedScene?.stats;
    harness.failNextCalculation();
    harness.replaceRecords("records-error");
    harness.flushRenderAndLayout();
    harness.flushAll();
    assert.equal(harness.current().error, "load-failed");
    assert.equal(harness.current().sceneActive, false);
    assert.equal(harness.current().retainedScene?.stats, readyStats);
    void harness.current().reload();
    harness.flushAll();
    assert.equal(harness.current().error, null);
    assert.equal(harness.current().sceneActive, true);
    assert.match(
      harness.current().retainedScene?.stats.marker ?? "",
      /records-error/,
    );
  } finally {
    console.error = previousConsoleError;
    harness.unmount();
  }
}
function replaceExactlyOnce(
  source: string,
  expected: string,
  replacement: string,
): string {
  const first = source.indexOf(expected);
  assert.notEqual(first, -1, "the statistics mutation target must exist");
  assert.equal(
    source.indexOf(expected, first + expected.length),
    -1,
    "the statistics mutation target must be unique",
  );
  return `${source.slice(0, first)}${replacement}${source.slice(first + expected.length)}`;
}
function assertStatisticsMutationRejected(
  label: string,
  runScenario: (source?: StatisticsHookAuditSourceOptions) => void,
  transform: (source: string) => string,
  expectedFailure: RegExp,
): void {
  const source = { transform };
  validateStatisticsHookAuditTransform(source);
  let rejected = false;
  try {
    runScenario(source);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    assert.match(
      error.message,
      expectedFailure,
      `${label} must fail at the intended observable`,
    );
    rejected = true;
  }
  assert.ok(rejected, `${label} must be detected by the behavioral audit`);
}
runInitialColdLifecycle();
runRetainedFocusLifecycle();
runVisibleSourceLifecycle();
runRapidSourceLifecycle();
runCivilBoundaryLifecycle();
runTargetAndRetryLifecycle();
runCivilDatePresentationLifecycle();
assertStatisticsMutationRejected(
  "missing blur mask",
  runRetainedFocusLifecycle,
  (source) => replaceExactlyOnce(source, "        maskPresentation();\n", ""),
  /blur must mask the retained scene/,
);
assertStatisticsMutationRejected(
  "retained target incorrectly deferred",
  runTargetAndRetryLifecycle,
  (source) =>
    replaceExactlyOnce(
      source,
      `(presentationRef.current.retainedReadyScene == null
          ? "deferred"
          : "immediate")`,
      `"deferred"`,
    ),
  /cold target with a retained scene must calculate/,
);
assertStatisticsMutationRejected(
  "hidden source calculation",
  runRetainedFocusLifecycle,
  (source) =>
    replaceExactlyOnce(
      source,
      "      !statisticsFocusedRef.current ||\n",
      "      false ||\n",
    ),
  /hidden source change must not start statistics work/,
);
assertStatisticsMutationRejected(
  "visible source mismatch remains interactive",
  runVisibleSourceLifecycle,
  (source) =>
    replaceExactlyOnce(
      source,
      `  const currentPresentation =
    requestedPresentation != null &&
    areStatisticsSourcesEqual(requestedPresentation.source, source)
      ? requestedPresentation
      : null;`,
      "  const currentPresentation = requestedPresentation;",
    ),
  /visible source mismatch must commit its mask/,
);
assertStatisticsMutationRejected(
  "period label reads a newer ambient civil date",
  runCivilDatePresentationLifecycle,
  (source) =>
    replaceExactlyOnce(
      source,
      `  const periodBaseCivilDate =
    currentPresentation?.source.todayStr ??
    requestedPresentation?.source.todayStr ??
    source.todayStr;`,
      "  const periodBaseCivilDate = source.todayStr;",
    ),
  /masked retained request must keep its own civil-date label basis/,
);
assertStatisticsMutationRejected(
  "source boundary normalization is not published",
  runCivilBoundaryLifecycle,
  (source) =>
    replaceExactlyOnce(
      source,
      "      requestedTargetRef.current = normalized;",
      "      requestedTargetRef.current = current;",
    ),
  /normalized source target must publish a ready presentation/,
);
assertStatisticsMutationRejected(
  "stale resolved target bypasses current admission",
  runCivilBoundaryLifecycle,
  (source) =>
    replaceExactlyOnce(
      source,
      "        !targetsEqual(nextTarget, admittedTarget)",
      "        false",
    ),
  /target resolved for an older source date/,
);
function getRetainedSceneElements(
  tree: AuditElement,
  periodSceneType: unknown,
): {
  scene: AuditElement;
  wrapper: AuditElement;
} {
  const scenes = findAuditElements(
    tree,
    (element) => element.type === periodSceneType,
  );
  assert.equal(
    scenes.length,
    1,
    "a retained statistics model must keep exactly one scene in the tree",
  );
  const scene = scenes[0];
  const wrappers = findAuditElements(
    tree,
    (element) => element.props.children === scene,
  );
  assert.equal(
    wrappers.length,
    1,
    "the retained scene must have one interaction and accessibility boundary",
  );
  return { scene, wrapper: wrappers[0] };
}
function runStatisticsScreenRetentionLifecycle(
  transform?: (source: string) => string,
): void {
  const harness = loadStatisticsScreenForAudit({}, transform);
  const readyTree = harness.render();
  const ready = getRetainedSceneElements(readyTree, harness.periodSceneType);
  const readySelectors = findAuditElements(
    readyTree,
    (element) =>
      (
        element.type as {
          auditComponent?: string;
        }
      ).auditComponent === "PeriodSelector",
  );
  assert.equal(readySelectors.length, 1);
  assert.deepEqual(
    readySelectors[0].props.periodRange,
    {
      startDay: 0,
      endDay: 6,
      startDate: "2026-11-09",
      endDate: "2026-11-15",
    },
    "the selector must receive the exact domain range of its request",
  );
  assert.equal(ready.scene.key, null);
  assert.equal(ready.scene.props.active, true);
  assert.equal(
    ready.scene.props.todayStr,
    "2026-11-13",
    "the retained scene must receive its own source date",
  );
  assert.equal(ready.wrapper.props.pointerEvents, "auto");
  assert.equal(ready.wrapper.props.accessibilityElementsHidden, false);
  assert.equal(ready.wrapper.props.importantForAccessibility, "auto");
  const retainedStats = ready.scene.props.stats;
  const retainedSceneType = ready.scene.type;
  const loading = getRetainedSceneElements(
    harness.render({
      isLoading: true,
      periodBaseCivilDate: "2026-11-14",
      periodRange: {
        startDay: 7,
        endDay: 13,
        startDate: "2026-11-16",
        endDate: "2026-11-22",
      },
      sceneActive: false,
    }),
    harness.periodSceneType,
  );
  assert.equal(
    loading.scene.type,
    retainedSceneType,
    "loading must retain the same Statistics scene component type",
  );
  assert.equal(loading.scene.key, ready.scene.key);
  assert.equal(loading.scene.props.stats, retainedStats);
  assert.equal(
    loading.scene.props.todayStr,
    "2026-11-13",
    "a newer masked request must not change the retained scene's source date",
  );
  assert.equal(
    loading.scene.props.active,
    false,
    "a masked retained scene must not accept drag or reorder input",
  );
  assert.equal(
    loading.wrapper.props.pointerEvents,
    "none",
    "a masked retained scene must reject pointer input",
  );
  assert.equal(loading.wrapper.props.accessibilityElementsHidden, true);
  const loadingSelectors = findAuditElements(
    harness.render(),
    (element) =>
      (
        element.type as {
          auditComponent?: string;
        }
      ).auditComponent === "PeriodSelector",
  );
  assert.equal(loadingSelectors.length, 1);
  assert.deepEqual(
    loadingSelectors[0].props.periodRange,
    {
      startDay: 7,
      endDay: 13,
      startDate: "2026-11-16",
      endDate: "2026-11-22",
    },
    "the masked selector must receive the exact range of its request",
  );
  assert.equal(
    loading.wrapper.props.importantForAccessibility,
    "no-hide-descendants",
  );
  const error = getRetainedSceneElements(
    harness.render({
      error: "load-failed",
      isLoading: false,
      sceneActive: false,
    }),
    harness.periodSceneType,
  );
  assert.equal(error.scene.type, retainedSceneType);
  assert.equal(error.scene.props.stats, retainedStats);
  assert.equal(error.scene.props.active, false);
  assert.equal(error.wrapper.props.pointerEvents, "none");
  const changedPreferences = getRetainedSceneElements(
    harness.render({
      effectiveMode: "dark",
      error: null,
      isLoading: false,
      language: "pl",
      sceneActive: true,
      statisticsBlockOrders: {
        week: ["habit", "summary", "bar", "heatmap"],
        month: ["habit", "summary", "heatmap", "bar"],
        year: ["habit", "summary", "heatmap", "bar"],
      },
    }),
    harness.periodSceneType,
  );
  assert.equal(changedPreferences.scene.type, retainedSceneType);
  assert.equal(changedPreferences.scene.key, ready.scene.key);
  assert.equal(changedPreferences.scene.props.stats, retainedStats);
  assert.equal(changedPreferences.scene.props.language, "pl");
  assert.deepEqual(changedPreferences.scene.props.persistedBlockOrder, [
    "habit",
    "summary",
    "bar",
    "heatmap",
  ]);
  const cold = loadStatisticsScreenForAudit(
    {
      isLoading: true,
      retainedScene: null,
      sceneActive: false,
    },
    transform,
  );
  assert.equal(
    findAuditElements(
      cold.render(),
      (element) => element.type === cold.periodSceneType,
    ).length,
    0,
    "initial cold loading must not fabricate a retained scene",
  );
}
function getHabitBreakdownItems(
  tree: AuditElement,
  itemType: unknown,
): AuditElement[] {
  return findAuditElements(tree, (element) => element.type === itemType);
}
function runHabitBreakdownMemoLifecycle(
  transform?: (source: string) => string,
): void {
  const harness = loadHabitBreakdownForAudit(transform);
  assert.equal(
    (
      harness.itemType as {
        auditKind?: string;
      }
    ).auditKind,
    "memo",
    "habit rows must use a memoized component boundary",
  );
  const firstHabits = [
    { habitId: 1, name: "Alpha", completionRate: 90, currentStreak: 4 },
    { habitId: 2, name: "Beta", completionRate: 75, currentStreak: 2 },
  ];
  const first = getHabitBreakdownItems(
    harness.render(firstHabits),
    harness.itemType,
  );
  assert.equal(first.length, 2);
  assert.equal(first[0].props.name, "Alpha");
  assert.equal(first[1].props.name, "Beta");
  const copied = getHabitBreakdownItems(
    harness.render(firstHabits.map((habit) => ({ ...habit }))),
    harness.itemType,
  );
  assert.equal(copied.length, 2);
  assert.ok(
    shallowPropsEqual(first[0].props, copied[0].props) &&
      shallowPropsEqual(first[1].props, copied[1].props),
    "equivalent row payloads must preserve shallow-equal memo props",
  );
  assert.equal(
    first[0].props.onOpenHabit,
    copied[0].props.onOpenHabit,
    "the shared row navigation callback must remain stable",
  );
  const changed = getHabitBreakdownItems(
    harness.render([
      firstHabits[0],
      { ...firstHabits[1], name: "Beta updated" },
    ]),
    harness.itemType,
  );
  assert.ok(
    shallowPropsEqual(copied[0].props, changed[0].props),
    "an unrelated row update must preserve the first row props",
  );
  assert.equal(
    shallowPropsEqual(copied[1].props, changed[1].props),
    false,
    "a changed row must receive its new visible payload",
  );
  assert.equal(changed[1].props.name, "Beta updated");
  const dark = getHabitBreakdownItems(
    harness.render(
      [firstHabits[0], { ...firstHabits[1], name: "Beta updated" }],
      { colorScheme: "violet", effectiveMode: "dark" },
    ),
    harness.itemType,
  );
  assert.equal(dark[0].props.accent, "accent-violet");
  assert.equal(dark[0].props.streakColor, "dark-muted");
  assert.equal(
    shallowPropsEqual(changed[0].props, dark[0].props),
    false,
    "visual preference changes must still update each row's primitive colors",
  );
}
function runBarChartSlotLifecycle(
  transform?: (source: string) => string,
): void {
  const harness = loadBarChartForAudit(transform);
  const labels = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const points = Array.from({ length: 5 }, (_, index) => ({
    label: `9999-12-${27 + index}`,
    value: index * 20,
    isFuture: false,
    isToday: index === 4,
  }));
  const tree = harness.render(points, labels);
  const barSlots = findAuditElements(
    tree,
    (element) =>
      (
        element.type as {
          auditComponent?: string;
        }
      ).auditComponent === "View" &&
      (element.props.className === "items-center flex-1 mx-[2px]" ||
        element.props.className === "mx-[2px] flex-1"),
  );
  assert.equal(
    barSlots.length,
    7,
    "a clipped civil week must render seven physical chart slots",
  );
  assert.equal(
    barSlots.filter((slot) => slot.props.className === "mx-[2px] flex-1")
      .length,
    2,
    "the unsupported weekend must use two empty slots",
  );
  assert.equal(barSlots[5].props.children, undefined);
  assert.equal(barSlots[6].props.children, undefined);
  const labelElements = findAuditElements(
    tree,
    (element) =>
      (
        element.type as {
          auditComponent?: string;
        }
      ).auditComponent === "Text" &&
      element.props.className === "text-muted text-center flex-1",
  );
  assert.equal(labelElements.length, 7);
  assert.equal(labelElements[4].props.children, "FR");
  assert.equal(
    JSON.stringify(labelElements[4].props.style).includes('"color":"accent"'),
    true,
    "the current supported day must keep its label emphasis at slot five",
  );
}
function assertRenderMutationRejected(
  label: string,
  kind: "screen" | "habit" | "bar",
  transform: (source: string) => string,
  expectedFailure: RegExp,
): void {
  if (kind === "screen") validateStatisticsScreenAuditTransform(transform);
  else if (kind === "habit") validateHabitBreakdownAuditTransform(transform);
  else validateBarChartAuditTransform(transform);
  const scenario =
    kind === "screen"
      ? () => runStatisticsScreenRetentionLifecycle(transform)
      : kind === "habit"
        ? () => runHabitBreakdownMemoLifecycle(transform)
        : () => runBarChartSlotLifecycle(transform);
  let rejected = false;
  try {
    scenario();
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    assert.match(
      error.message,
      expectedFailure,
      `${label} must fail at the intended rendered-tree observable`,
    );
    rejected = true;
  }
  assert.ok(rejected, `${label} must be detected by the rendered-tree audit`);
}
runStatisticsScreenRetentionLifecycle();
runHabitBreakdownMemoLifecycle();
runBarChartSlotLifecycle();
const localizedPeriodLabels = new Map<
  string,
  readonly [string, string, string]
>([
  ["ru", ["9 нояб. – 15 нояб.", "ноябрь 2026", "2025"]],
  ["en", ["9 Nov – 15 Nov", "November 2026", "2025"]],
  ["uk", ["9 листоп. – 15 листоп.", "листопад 2026", "2025"]],
  ["es", ["9 nov – 15 nov", "noviembre 2026", "2025"]],
  ["de", ["9 Nov. – 15 Nov.", "November 2026", "2025"]],
  ["fr", ["9 nov. – 15 nov.", "novembre 2026", "2025"]],
  ["it", ["9 nov – 15 nov", "novembre 2026", "2025"]],
  ["nl", ["9 nov. – 15 nov.", "november 2026", "2025"]],
  ["pl", ["9 lis – 15 lis", "listopad 2026", "2025"]],
]);
const currentWeekRange = getStatisticsPeriodRange("week", 0, "2026-11-13");
const currentMonthRange = getStatisticsPeriodRange("month", 0, "2026-11-13");
const previousYearRange = getStatisticsPeriodRange("year", -1, "2026-11-13");
assert.ok(currentWeekRange);
assert.ok(currentMonthRange);
assert.ok(previousYearRange);
for (const [language, expected] of localizedPeriodLabels) {
  assert.deepEqual(
    [
      getPeriodLabel("week", language, currentWeekRange),
      getPeriodLabel("month", language, currentMonthRange),
      getPeriodLabel("year", language, previousYearRange),
    ],
    expected,
    `${language} period labels must preserve their localized text`,
  );
}
const apiaWeek = getStatisticsPeriodRange("week", 0, "2011-12-30");
assert.deepEqual(apiaWeek && [apiaWeek.startDate, apiaWeek.endDate], [
  "2011-12-26",
  "2012-01-01",
]);
assert.equal(getStatisticsPeriodRange("week", 0, "not-a-date"), null);
assert.throws(
  () =>
    getPeriodLabel("week", "en", {
      startDay: 0,
      endDay: 0,
      startDate: "not-a-date",
      endDate: "not-a-date",
    }),
  RangeError,
  "an invalid explicit source date must not silently fall back to the ambient clock",
);
const supportedBoundaryRanges = {
  week: {
    minimum: ["0001-01-01", "0001-01-07"],
    maximum: ["9999-12-27", "9999-12-31"],
  },
  month: {
    minimum: ["0001-01-01", "0001-01-31"],
    maximum: ["9999-12-01", "9999-12-31"],
  },
  year: {
    minimum: ["0001-01-01", "0001-12-31"],
    maximum: ["9999-01-01", "9999-12-31"],
  },
} as const;
for (const period of ["week", "month", "year"] as const) {
  const minimum = getStatisticsPeriodRange(period, 0, "0001-01-01");
  const maximum = getStatisticsPeriodRange(period, 0, "9999-12-31");
  assert.deepEqual(
    minimum && [minimum.startDate, minimum.endDate],
    supportedBoundaryRanges[period].minimum,
  );
  assert.deepEqual(
    maximum && [maximum.startDate, maximum.endDate],
    supportedBoundaryRanges[period].maximum,
  );
  assert.equal(getStatisticsPeriodRange(period, -1, "0001-01-01"), null);
  assert.equal(getStatisticsPeriodRange(period, 1, "9999-12-31"), null);
  assert.equal(
    getStatisticsPeriodRange(period, Number.MAX_SAFE_INTEGER, "2026-11-13"),
    null,
  );
  assert.equal(
    getStatisticsPeriodRange(period, Number.NaN, "2026-11-13"),
    null,
  );
  assert.equal(
    getStatisticsPeriodRange(period, Number.POSITIVE_INFINITY, "2026-11-13"),
    null,
  );
  assert.equal(
    canNavigateStatisticsBackward({ period, periodOffset: 0 }, "0001-01-01"),
    false,
  );
  assert.deepEqual(
    getStatisticsNavigationTarget(
      { period, periodOffset: 0 },
      "prev",
      "0001-01-01",
    ),
    { period, periodOffset: 0 },
  );
  assert.equal(
    canNavigateStatisticsForward({ period, periodOffset: 0 }, "9999-12-31"),
    false,
  );
  const normalizedExtreme = normalizeStatisticsTargetForBase(
    { period, periodOffset: Number.MIN_SAFE_INTEGER },
    "2026-11-13",
  );
  assert.ok(
    getStatisticsPeriodRange(
      normalizedExtreme.period,
      normalizedExtreme.periodOffset,
      "2026-11-13",
    ),
  );
  assert.deepEqual(
    getStatisticsNavigationTarget(normalizedExtreme, "prev", "2026-11-13"),
    normalizedExtreme,
    `${period} normalization must stop at its earliest supported target`,
  );
  assert.deepEqual(
    normalizeStatisticsTargetForBase(
      { period, periodOffset: Number.MAX_SAFE_INTEGER },
      "2026-11-13",
    ),
    { period, periodOffset: 0 },
  );
}
const firstYearRange = getStatisticsPeriodRange("year", 0, "0001-01-01");
const lastYearRange = getStatisticsPeriodRange("year", 0, "9999-12-31");
const lastWeekRange = getStatisticsPeriodRange("week", 0, "9999-12-31");
assert.ok(firstYearRange);
assert.ok(lastYearRange);
assert.ok(lastWeekRange);
assert.equal(getPeriodLabel("year", "en", firstYearRange), "0001");
assert.equal(getPeriodLabel("year", "en", lastYearRange), "9999");
assert.equal(getPeriodLabel("week", "en", lastWeekRange), "27 Dec – 31 Dec");
assert.equal(
  getStatisticsPeriodRange("week", -1000000000, "2026-01-01"),
  null,
  "an extreme week offset must be rejected before Date conversion",
);
assert.equal(
  getStatisticsPeriodRange("week", Number.MIN_SAFE_INTEGER, "2026-01-01"),
  null,
  "the minimum safe week offset must be rejected without throwing",
);
assert.throws(
  () =>
    normalizeStatisticsTargetForBase(
      { period: "week", periodOffset: -1 },
      "not-a-date",
    ),
  RangeError,
  "an unsupported source date must fail instead of entering normalization",
);
const invalidEmptySource = createStatisticsSourceIndex({
  allHabits: [],
  allRecords: [],
  showArchivedHabitsInStatistics: false,
  todayStr: "0001-01-01",
});
assert.throws(
  () => calculateStatisticsPeriod(invalidEmptySource, "year", -1, () => 0),
  RangeError,
  "an invalid direct calculation must not masquerade as an empty period",
);
const finalWeekSource = createStatisticsSource({
  allHabits: [
    createStatisticsHabit({
      startDate: "9999-01-01",
      scheduleHistory: [
        {
          effectiveFrom: "9999-01-01",
          startDate: "9999-01-01",
          repeatSchedule: { type: "daily" },
        },
      ],
    }),
  ],
  allRecords: [],
  todayStr: "9999-12-31",
});
const finalWeekStats = getStatisticsPeriod(finalWeekSource, "week", 0).stats;
assert.deepEqual(
  finalWeekStats.barChartData.map((point) => point.label),
  ["9999-12-27", "9999-12-28", "9999-12-29", "9999-12-30", "9999-12-31"],
  "the clipped final week must contain only supported civil dates",
);
assertRenderMutationRejected(
  "retained scene removed while masked",
  "screen",
  (source) =>
    replaceExactlyOnce(source, "{retainedScene != null ? (", "{false ? ("),
  /keep exactly one scene/,
);
assertRenderMutationRejected(
  "masked scene accepts pointer input",
  "screen",
  (source) =>
    replaceExactlyOnce(
      source,
      'pointerEvents={sceneActive ? "auto" : "none"}',
      'pointerEvents="auto"',
    ),
  /must reject pointer input/,
);
assertRenderMutationRejected(
  "masked reorder scene remains active",
  "screen",
  (source) =>
    replaceExactlyOnce(source, "active={sceneActive}", "active={true}"),
  /must not accept drag or reorder input/,
);
assertRenderMutationRejected(
  "selector range disconnected",
  "screen",
  (source) =>
    replaceExactlyOnce(
      source,
      "periodRange={periodRange}",
      "periodRange={{ ...periodRange, startDate: periodRange.endDate }}",
    ),
  /exact domain range/,
);
assertRenderMutationRejected(
  "retained heatmap reads a newer request date",
  "screen",
  (source) =>
    replaceExactlyOnce(
      source,
      "todayStr={retainedScene.todayStr}",
      "todayStr={periodRange.endDate}",
    ),
  /retained scene must receive its own source date/,
);
assertRenderMutationRejected(
  "habit rows lose memo boundary",
  "habit",
  (source) =>
    replaceExactlyOnce(
      replaceExactlyOnce(
        source,
        "const HabitBreakdownItem = React.memo(function HabitBreakdownItem(",
        "function HabitBreakdownItem(",
      ),
      "\n});\n// Habits are sorted by completion rate descending.",
      "\n}\n// Habits are sorted by completion rate descending.",
    ),
  /memoized component boundary/,
);
assertRenderMutationRejected(
  "habit rows receive a new navigation closure",
  "habit",
  (source) =>
    replaceExactlyOnce(
      source,
      "onOpenHabit={handleOpenHabit}",
      "onOpenHabit={(habitId) => handleOpenHabit(habitId)}",
    ),
  /preserve shallow-equal memo props/,
);
assertRenderMutationRejected(
  "clipped week drops empty chart slots",
  "bar",
  (source) =>
    replaceExactlyOnce(
      source,
      "{chartData.map((point, i) => {",
      "{chartData.filter((point) => point != null).map((point, i) => {",
    ),
  /render seven physical chart slots/,
);
const root = resolve(import.meta.dirname, "..");
const summarySource = readFileSync(
  resolve(root, "src/features/statistics/components/SummaryCards.tsx"),
  "utf8",
);
const barChartSource = readFileSync(
  resolve(root, "src/features/statistics/components/BarChart.tsx"),
  "utf8",
);
const hookSource = readFileSync(
  resolve(root, "src/features/statistics/hooks/useStatistics.ts"),
  "utf8",
);
const statisticsScreenSource = readFileSync(
  resolve(root, "app/statistics.tsx"),
  "utf8",
);
const periodSelectorSource = readFileSync(
  resolve(root, "src/features/statistics/components/PeriodSelector.tsx"),
  "utf8",
);
const sessionSource = readFileSync(
  resolve(root, "src/application/statistics/statistics-session.ts"),
  "utf8",
);
const domainSource = readFileSync(
  resolve(root, "src/domain/statistics/statistics-period.ts"),
  "utf8",
);
const prewarmSource = readFileSync(
  resolve(root, "src/features/statistics/utils/statistics-prewarm.ts"),
  "utf8",
);
const homeSource = readFileSync(resolve(root, "app/index.tsx"), "utf8");
type AuditBarDataPoint = {
  label: string;
  value: number;
  isFuture: boolean;
  isToday: boolean;
};
type CreateBarChartSlots = (
  data: readonly AuditBarDataPoint[],
  slotCount: number,
) => (AuditBarDataPoint | null)[];
const loadBarChartSlots = (source: string): CreateBarChartSlots =>
  loadSourceCallableForAudit<CreateBarChartSlots>(
    source,
    "createBarChartSlots",
    { Array },
  );
const createBarSlots = loadBarChartSlots(barChartSource);
const completeWeekPoints = Array.from({ length: 7 }, (_, index) => ({
  label: `day-${index}`,
  value: index * 10,
  isFuture: false,
  isToday: index === 4,
}));
const completeWeekSlots = createBarSlots(completeWeekPoints, 7);
assert.equal(completeWeekSlots.length, 7);
for (let index = 0; index < completeWeekPoints.length; index += 1) {
  assert.equal(
    completeWeekSlots[index],
    completeWeekPoints[index],
    "an ordinary complete week must preserve every existing bar model",
  );
}
const clippedWeekSlots = createBarSlots(completeWeekPoints.slice(0, 5), 7);
assert.equal(clippedWeekSlots.length, 7);
assert.equal(clippedWeekSlots[4], completeWeekPoints[4]);
assert.equal(clippedWeekSlots[5], null);
assert.equal(clippedWeekSlots[6], null);
const shortenedSlotMutant = loadBarChartSlots(
  replaceExactlyOnce(
    barChartSource,
    "{ length: slotCount }",
    "{ length: Math.min(slotCount, data.length) }",
  ),
);
assert.throws(
  () =>
    assert.equal(
      shortenedSlotMutant(completeWeekPoints.slice(0, 5), 7).length,
      7,
      "a clipped civil week must retain seven physical chart slots",
    ),
  (error) =>
    error instanceof AssertionError &&
    /retain seven physical chart slots/.test(error.message),
  "the chart-slot audit must reject removal of trailing empty slots",
);
assert.match(summarySource, /<Entypo\s+name="bar-graph"/);
assert.match(summarySource, /t\("statistics\.progress"\)/);
assert.doesNotMatch(summarySource, /statistics\.completionRate/);
assert.match(
  barChartSource,
  /t\("statistics\.completionRate"\)/,
  "the separate daily completion chart must keep its existing title",
);
assert.match(
  domainSource,
  /for \(const \{ date: dateStr, scheduleFacts \} of periodDates\)[\s\S]*calculatePeriodProgress/,
  "progress must use the full period, not only dates through today",
);
assert.match(
  domainSource,
  /isEmpty: scheduledStatuses\.length === 0/,
  "all-skipped and future-only periods must still show their normal statistics blocks",
);
assert.match(
  domainSource,
  /\.filter\(\(evaluation\) => evaluation\.occurrenceCount > 0\)/,
  "habit breakdown must omit habits with no occurrence in the selected period",
);
assert.match(
  domainSource,
  /periodEndDate < source\.todayStr \? periodEndDate : source\.todayStr/,
  "a historical period streak must be evaluated at that period's end",
);
assert.match(
  sessionSource,
  /left\.allHabits === right\.allHabits[\s\S]*left\.allRecords === right\.allRecords[\s\S]*left\.showArchivedHabitsInStatistics ===[\s\S]*right\.showArchivedHabitsInStatistics[\s\S]*left\.todayStr === right\.todayStr/,
  "every authoritative source must participate in session invalidation",
);
assert.match(
  sessionSource,
  /periodCache: new Map\(\)/,
  "a source replacement must create a fresh bounded period cache",
);
assert.match(domainSource, /const scheduleMatcherByHabit = new Map/);
assert.match(
  sessionSource,
  /prepareStreakStats\(habit, records, evaluationDate\)\.stats\.current/,
  "statistics prewarm must also prepare the same bounded streak model consumed by Habit detail",
);
assert.match(
  hookSource,
  /const previousTarget = getStatisticsNavigationTarget\([\s\S]{0,180}visibleTarget,[\s\S]{0,80}"prev",[\s\S]{0,80}source\.todayStr[\s\S]{0,500}\.\.\.adjacentTargets,[\s\S]{0,120}\.\.\.CURRENT_STATISTICS_PERIOD_TARGETS/,
  "only supported adjacent periods may be scheduled after commit",
);
assert.match(
  hookSource,
  /preparationTaskRef\.current\?\.cancel\(\)[\s\S]{0,240}preparationRevisionRef\.current = revision/,
  "every newer period or source request must cancel queued work before assigning its revision",
);
assert.match(
  hookSource,
  /isLatestStatisticsPreparation\([\s\S]{0,620}publishPresentation\(\{/,
  "a completed cold calculation must pass the source+target+revision gate before publication",
);
assert.doesNotMatch(
  hookSource,
  /useMemo\([\s\S]{0,500}getStatisticsPeriod\(/,
  "a cache miss must never run the full statistics calculation during render",
);
assert.match(
  hookSource,
  /const prepared = peekPreparedStatisticsPeriod\([\s\S]{0,900}if \(prepared\) \{[\s\S]{0,900}state: "ready"[\s\S]{0,500}return;/,
  "prepared hits must publish immediately without scheduling calculation work",
);
assert.match(
  hookSource,
  /if \(resolvedMode === "immediate"\) \{[\s\S]{0,120}calculateAndPublish\(\);[\s\S]{0,120}\} else \{[\s\S]{0,120}runAfterUiPaint\(calculateAndPublish\)/,
  "initial cold work must remain deferred while retained-scene replacement may calculate synchronously",
);
assert.match(
  hookSource,
  /publishPresentation\(\{[\s\S]{0,220}period: target\.period,[\s\S]{0,160}periodOffset: target\.periodOffset,[\s\S]{0,100}state: "ready",[\s\S]{0,80}result/,
  "selector target and complete body model must be published in one state update",
);
assert.match(
  hookSource,
  /activePreparationRef\.current = \{[\s\S]{0,260}publishPresentation\(\{[\s\S]{0,220}period: target\.period,[\s\S]{0,120}periodOffset: target\.periodOffset,[\s\S]{0,100}state: "loading"/,
  "a cold target must atomically publish its selector and neutral loading body before deferred calculation",
);
assert.match(
  hookSource,
  /const resolveNavigationTarget = useCallback\([\s\S]{0,360}normalizeRequestedTargetForSource\([\s\S]{0,100}currentOwner\.source[\s\S]{0,180}getStatisticsNavigationTarget\([\s\S]{0,100}currentTarget,[\s\S]{0,100}direction,[\s\S]{0,100}currentOwner\.source\.todayStr/,
  "period controls must resolve their action target from the latest requested target and source date",
);
assert.match(
  periodSelectorSource,
  /const target = resolveNavigationTarget\("prev"\);\s*onNavigate\("prev", target\)[\s\S]{0,1800}const target = resolveNavigationTarget\("next"\);\s*onNavigate\("next", target\)/,
  "each period-arrow action and applied navigation must share one exact resolved target",
);
assert.match(
  hookSource,
  /publishRequestedTarget\(admittedTarget\);\s*prepareAndPublishTarget\(currentOwner\.source, admittedTarget\)/,
  "the requested target must publish before a later rapid control action",
);
assert.match(
  hookSource,
  /catch \(calculationError\)[\s\S]{0,900}publishPresentation\(\{[\s\S]{0,220}source: targetSource,[\s\S]{0,120}period: target\.period,[\s\S]{0,120}periodOffset: target\.periodOffset,[\s\S]{0,100}state: "error"/,
  "a failed target calculation must publish an exact target-owned error presentation",
);
assert.doesNotMatch(
  hookSource,
  /setErrorKind\("target"\)/,
  "a target calculation error must not become a source-global error that survives a newer source revision",
);
assert.match(
  hookSource,
  /const requestedPresentation = presentation\.request;[\s\S]{0,420}const period =[\s\S]{0,160}currentPresentation\?\.period \?\? requestedPresentation\?\.period \?\? "week";[\s\S]{0,220}const periodOffset =[\s\S]{0,220}requestedPresentation\?\.periodOffset \?\?[\s\S]{0,40}0/,
  "the visible selector must come from the same loading, error, or ready presentation envelope as its body",
);
assert.match(
  hookSource,
  /useLayoutEffect\(\(\) => \{[\s\S]{0,160}presentationRef\.current = presentation;[\s\S]{0,120}sourceRef\.current = source;/,
  "committed mirrors used by async work must advance only after React commits the presentation",
);
const publishPresentationSource = hookSource.slice(
  hookSource.indexOf("const publishPresentation = useCallback"),
  hookSource.indexOf("const maskPresentation"),
);
assert.doesNotMatch(
  publishPresentationSource,
  /presentationRef\.current|sourceRef\.current/,
  "publishing a presentation must not mutate committed refs before React commits it",
);
assert.match(
  hookSource,
  /const reloadRef = useRef\(reload\)[\s\S]{0,220}reloadRef\.current = reload[\s\S]{0,360}statisticsFocusedRef\.current = true;[\s\S]{0,120}void reloadRef\.current\(\)/,
  "one stable focus lifecycle must own both source loading and initial target preparation",
);
assert.doesNotMatch(
  statisticsScreenSource,
  /useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*void reload\(\)/,
  "the screen must not race the hook with a second focus-triggered reload",
);
assert.match(
  hookSource,
  /setErrorKind\("source"\)[\s\S]{0,420}catch \(loadError\)[\s\S]{0,220}setErrorKind\("source"\)/,
  "incomplete and failed source loads must remain distinguishable from a target calculation error",
);
for (const [name, startMarker, endMarker] of [
  [
    "period navigation",
    "const navigatePeriod = useCallback",
    "const changePeriod = useCallback",
  ],
  [
    "period selection",
    "const changePeriod = useCallback",
    "  return {\n    period,",
  ],
] as const) {
  const section = hookSource.slice(
    hookSource.indexOf(startMarker),
    hookSource.indexOf(endMarker),
  );
  const sourceGuard = section.search(
    /!allHabitsLoaded|!currentOwner\.store\.allHabitsLoaded/,
  );
  const unavailableReturn = section.indexOf("return;", sourceGuard);
  const publication = section.indexOf("publishRequestedTarget(");
  assert.ok(
    sourceGuard >= 0 &&
      unavailableReturn >= 0 &&
      publication > sourceGuard &&
      publication > unavailableReturn,
    `${name} must preserve the source-error presentation and Retry control until source data is available`,
  );
}
assert.ok(
  (hookSource.match(/cancelStatisticsPreparation\(\)/g) ?? []).length === 2,
  "blur and unmount must both cancel their owned preparation work",
);
const focusedPreparationGuardIndex = hookSource.indexOf(
  "!statisticsFocusedRef.current",
);
const focusStartIndex = hookSource.indexOf(
  "statisticsFocusedRef.current = true",
);
const focusEndIndex = hookSource.indexOf(
  "statisticsFocusedRef.current = false",
  focusStartIndex,
);
assert.ok(
  focusedPreparationGuardIndex >= 0 &&
    focusStartIndex > focusedPreparationGuardIndex &&
    focusEndIndex > focusStartIndex,
  "a retained blurred Statistics screen must neither start nor retain target preparation",
);
assert.match(
  hookSource,
  /const canNavigatePrevious = canNavigateStatisticsBackward\([\s\S]{0,100}visibleTarget,[\s\S]{0,100}periodBaseCivilDate[\s\S]{0,180}const canNavigateNext = canNavigateStatisticsForward\([\s\S]{0,100}visibleTarget,[\s\S]{0,100}periodBaseCivilDate/,
  "both navigation bounds must describe the committed target and its exact source date",
);
assert.match(
  periodSelectorSource,
  /const isPreviousDisabled = !canNavigatePrevious;[\s\S]{0,100}const isNextDisabled = !canNavigateNext/,
  "both period controls must expose their domain navigation bounds",
);
assert.match(
  hookSource,
  /currentOwner\.store\.allHabitsLoaded &&[\s\S]{0,100}currentOwner\.store\.allDayRecordsLoaded[\s\S]{0,1100}else if \(!targetIsPreparing\) \{[\s\S]{0,260}prepareAndPublishTarget\([\s\S]{0,80}currentOwner\.source,\s*target,/,
  "retrying a target-owned error must synchronously replace it with the exact loading presentation",
);
assert.match(
  hookSource,
  /current\?\.state === "ready" &&[\s\S]{0,100}areStatisticsSourcesEqual\(current\.source, source\)[\s\S]{0,220}return;[\s\S]{0,220}areStatisticsSourcesEqual\(active\.source, source\)[\s\S]{0,100}targetsEqual\(active\.target, target\)/,
  "an error clear must not restart an already active target preparation",
);
assert.match(
  hookSource,
  /const nextTarget = getStatisticsNavigationTarget\([\s\S]{0,180}visibleTarget,[\s\S]{0,80}"next",[\s\S]{0,80}source\.todayStr/,
  "a supported historical period's next neighbour must also be scheduled after commit",
);
assert.match(
  hookSource,
  /useFocusEffect\([\s\S]*scheduleStatisticsPeriodsPrewarm[\s\S]*task\.cancel\(\)/,
  "Statistics must cancel speculative neighbour work as soon as it blurs",
);
assert.match(prewarmSource, /runWhenUiIsIdle\(/);
assert.doesNotMatch(
  prewarmSource,
  /runAfterUiSettles|timeoutMs|setTimeout/,
  "speculative statistics work must never be forced into an interaction",
);
assert.match(
  homeSource,
  /runWhenUiIsIdle\(\(\) => \{[\s\S]{0,260}import\("@\/features\/statistics\/utils\/statistics-prewarm"\)[\s\S]{0,900}period: "week", periodOffset: 0/,
  "Home must prepare only the common current-week calculation through a dynamic import and genuine idle slots",
);
assert.doesNotMatch(
  homeSource,
  /period: "month"|period: "year"|router\.prefetch/,
);
assert.match(
  homeSource,
  /statisticsCurrentWeekPrewarmRevisionRef\.current \+= 1;[\s\S]{0,160}statisticsCurrentWeekPrewarmRef\.current\?\.cancel\(\)/,
  "a source change or Statistics press must cancel queued current-week work",
);
assert.match(
  summarySource,
  /periodProgress === "—"\s*\?\s*periodProgress\s*:\s*`\$\{periodProgress\}%`/,
  "an all-skipped period must show a dash without a percent sign",
);
console.log("Statistics period progress audit passed.");
