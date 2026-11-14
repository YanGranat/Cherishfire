import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { calculateCurrentStreak, calculateStreakStats } from "../src/domain/habits/streak";
import * as scheduleModule from "../src/domain/habits/schedule";
import { createHabitScheduleMatcher, getEarliestScheduleStartDate, isHabitScheduledForDate } from "../src/domain/habits/schedule";
import * as archivePeriodsModule from "../src/domain/habits/archive-periods";
import {
  isDateInArchiveHistory,
  normalizeArchiveHistory,
} from "../src/domain/habits/archive-periods";
import { isCivilDateKey } from "../src/domain/dates/civil-date";
import * as periodProgressModule from "../src/domain/statistics/period-progress";
import {
  calculateStatisticsPeriod,
  createStatisticsSourceIndex,
} from "../src/domain/statistics/statistics-period";
import {
  expectedStatisticsEquivalenceHashes,
  statisticsEquivalenceFixtures,
} from "./fixtures/statistics-equivalence-fixtures";
import type { ArchivePeriod, DayRecord, DayStatus, Habit, RepeatSchedule, ScheduleHistoryEntry } from "../src/types/habit";

const completed = new Set<DayStatus>(["done", "minimum", "maximum"]);
const dateAt = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
const ordinal = (date: string) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);

// The reference enumerates immutable ISO dates and uses the public one-date
// schedule evaluator instead of the optimized matcher or reverse traversal.
function reference(
  records: DayRecord[], schedule: RepeatSchedule, start: string,
  archives: ArchivePeriod[], history: ScheduleHistoryEntry[] | undefined, end: string,
) {
  const dates: string[] = [];
  for (let day = ordinal(getEarliestScheduleStartDate(start, history)); day <= ordinal(end); day += 1) {
    dates.push(dateAt(day));
  }
  const statusByDate = new Map(records.map((record) => [record.date, record.status]));
  let current = 0;
  let best = 0;
  for (const date of dates) {
    if (isDateInArchiveHistory(date, archives)) { current = 0; continue; }
    if (!isHabitScheduledForDate(schedule, start, date, records, history)) continue;
    const status = statusByDate.get(date);
    if (status && completed.has(status)) current += 1;
    else if (status !== "skipped" && !(date === end && status == null)) current = 0;
    best = Math.max(best, current);
  }
  const total = records.filter((record) => completed.has(record.status) && !isDateInArchiveHistory(record.date, archives)).length;
  return { current, best, total };
}

interface CommonJsModuleInstance extends NodeModule {
  _compile(source: string, fileName: string): void;
}

interface CommonJsModuleConstructor {
  new (id?: string, parent?: NodeModule): CommonJsModuleInstance;
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
  _nodeModulePaths(from: string): string[];
}

function replaceExactlyOnce(
  source: string,
  expected: string,
  replacement: string,
): string {
  const index = source.indexOf(expected);
  assert.notEqual(index, -1, "the civil-period mutation target must exist");
  assert.equal(
    source.indexOf(expected, index + expected.length),
    -1,
    "the civil-period mutation target must be unique",
  );
  return `${source.slice(0, index)}${replacement}${source.slice(
    index + expected.length,
  )}`;
}

function loadStatisticsPeriodForMutation(
  transform: (source: string) => string,
): {
  calculateStatisticsPeriod: typeof calculateStatisticsPeriod;
  createStatisticsSourceIndex: typeof createStatisticsSourceIndex;
} {
  const fileName = resolve(
    import.meta.dirname,
    "../src/domain/statistics/statistics-period.ts",
  );
  const source = transform(readFileSync(fileName, "utf8"));
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
    reportDiagnostics: true,
  });
  const diagnostics = transpiled.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostics?.length) {
    throw new Error(
      `Civil-period mutation transpile failed: ${diagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  const mocks = new Map<string, unknown>([
    ["@/domain/statistics/period-progress", periodProgressModule],
    ["@/domain/habits/archive-periods", archivePeriodsModule],
    ["@/domain/habits/schedule", scheduleModule],
  ]);
  const ModuleInternals = Module as unknown as CommonJsModuleConstructor;
  const originalLoad = ModuleInternals._load;
  const compiledModule = new ModuleInternals(fileName);
  compiledModule.filename = fileName;
  compiledModule.paths = ModuleInternals._nodeModulePaths(dirname(fileName));
  ModuleInternals._load = (request, parent, isMain) => {
    if (mocks.has(request)) return mocks.get(request);
    return originalLoad(request, parent, isMain);
  };
  try {
    compiledModule._compile(transpiled.outputText, fileName);
  } finally {
    ModuleInternals._load = originalLoad;
  }
  const exports = compiledModule.exports as Partial<{
    calculateStatisticsPeriod: typeof calculateStatisticsPeriod;
    createStatisticsSourceIndex: typeof createStatisticsSourceIndex;
  }>;
  if (
    typeof exports.calculateStatisticsPeriod !== "function" ||
    typeof exports.createStatisticsSourceIndex !== "function"
  ) {
    throw new Error("Compiled civil-period module is missing its public API");
  }
  return {
    calculateStatisticsPeriod: exports.calculateStatisticsPeriod,
    createStatisticsSourceIndex: exports.createStatisticsSourceIndex,
  };
}

function loadCivilDateValidatorForMutation(
  transform: (source: string) => string,
): typeof isCivilDateKey {
  const fileName = resolve(
    import.meta.dirname,
    "../src/domain/dates/civil-date.ts",
  );
  const source = transform(readFileSync(fileName, "utf8"));
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
    reportDiagnostics: true,
  });
  const diagnostics = transpiled.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostics?.length) {
    throw new Error(
      `Archive-date mutation transpile failed: ${diagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  const ModuleInternals = Module as unknown as CommonJsModuleConstructor;
  const originalLoad = ModuleInternals._load;
  const compiledModule = new ModuleInternals(fileName);
  compiledModule.filename = fileName;
  compiledModule.paths = ModuleInternals._nodeModulePaths(dirname(fileName));
  try {
    compiledModule._compile(transpiled.outputText, fileName);
  } finally {
    ModuleInternals._load = originalLoad;
  }
  const exported = compiledModule.exports as {
    isCivilDateKey?: typeof isCivilDateKey;
  };
  if (typeof exported.isCivilDateKey !== "function") {
    throw new Error("Compiled civil-date module has no validator export");
  }
  return exported.isCivilDateKey;
}

function assertCivilPeriodMutationRejected(
  label: string,
  transform: (source: string) => string,
  expectedFailure: RegExp,
): void {
  const module = loadStatisticsPeriodForMutation(transform);
  const habit: Habit = {
    id: 1,
    name: "Daily",
    description: null,
    descriptionVisible: true,
    repeatSchedule: { type: "daily" },
    scheduleHistory: [],
    startDate: "2010-01-01",
    reminderEnabled: false,
    reminderTime: null,
    displayOrder: 0,
    isArchived: false,
    archivedAt: null,
    archiveHistory: [],
    createdAt: 0,
    updatedAt: 0,
  };
  let rejected = false;
  try {
    const stats = module.calculateStatisticsPeriod(
      module.createStatisticsSourceIndex({
        allHabits: [habit],
        allRecords: [],
        showArchivedHabitsInStatistics: false,
        todayStr: "2011-12-31",
      }),
      "week",
      0,
      () => 0,
    );
    assert.deepEqual(
      stats.heatmapData.map(({ date }) => date),
      [
        "2011-12-26",
        "2011-12-27",
        "2011-12-28",
        "2011-12-29",
        "2011-12-30",
        "2011-12-31",
        "2012-01-01",
      ],
      "civil week dates must remain Monday-based and end-inclusive",
    );
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    assert.match(
      error.message,
      expectedFailure,
      `${label} must fail at the intended civil-period observable`,
    );
    rejected = true;
  }
  assert.ok(rejected, `${label} must be detected by the civil-period audit`);
}

function runCases() {
  let seed = 0x5eeda11;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  const schedules: RepeatSchedule[] = [
    { type: "daily" }, { type: "weekdays", days: [1, 3, 5] },
    { type: "weekdays", days: [2, 6, 7] }, { type: "monthly", dates: [1, 15, 29, 30, 31] },
    { type: "interval", every: 2 }, { type: "interval", every: 13 },
    { type: "interval", every: 3, fromCompletion: true },
  ];
  const statuses: (DayStatus | null)[] = [null, "done", "minimum", "maximum", "skipped", "failure"];
  const record = (date: string, status: DayStatus, id: number): DayRecord => ({
    id, habitId: 1, date, status, createdAt: 0, updatedAt: 0,
  });
  for (let iteration = 0; iteration < 3000; iteration += 1) {
    const startDay = ordinal("2023-01-01") + random(1000);
    const length = 1 + random(400);
    const start = dateAt(startDay);
    const end = dateAt(startDay + length);
    const schedule = schedules[random(schedules.length)];
    const history: ScheduleHistoryEntry[] = [{ effectiveFrom: start, startDate: start, repeatSchedule: schedules[random(schedules.length)] }];
    if (iteration % 2 === 0) history.push({
      effectiveFrom: dateAt(startDay + Math.floor(length / 2)),
      startDate: dateAt(startDay + random(Math.max(1, Math.floor(length / 3)))),
      repeatSchedule: schedule,
    });
    const archives: ArchivePeriod[] = iteration % 3 === 0 ? [{
      archivedAt: 0, restoredAt: iteration % 9 === 0 ? null : 1,
      archivedDate: dateAt(startDay + Math.floor(length / 3)),
      restoredDate: iteration % 9 === 0 ? null : dateAt(startDay + Math.floor(length * 2 / 3)),
    }] : [];
    const records: DayRecord[] = [];
    for (let offset = -2; offset < length + 3; offset += 1) {
      const status = statuses[random(statuses.length)];
      if (status) records.push(record(dateAt(startDay + offset), status, records.length + 1));
    }
    const versions = iteration % 4 === 0 ? undefined : history;
    const expected = reference(records, schedule, start, archives, versions, end);
    assert.deepEqual(calculateStreakStats(records, schedule, start, archives, versions, end), expected, `full streak case ${iteration}`);
    assert.equal(calculateCurrentStreak(records, schedule, start, archives, versions, end), expected.current, `current streak case ${iteration}`);
  }

  const continuous = Array.from({ length: 21 }, (_, index) => record(dateAt(ordinal("2026-04-10") + index), "done", index + 1));
  assert.deepEqual(calculateStreakStats(continuous, { type: "daily" }, "2026-04-10", [], undefined, "2026-04-30"), { current: 21, best: 21, total: 21 });
  assert.equal(calculateCurrentStreak(continuous, { type: "daily" }, "2026-04-10", [], undefined, "2026-04-30"), 21);
  assert.equal(calculateCurrentStreak(continuous, { type: "daily" }, "2026-05-01", [], undefined, "2026-04-30"), 0);
  const leapYearZero = [record("0000-02-28", "done", 1), record("0000-02-29", "done", 2), record("0000-03-01", "done", 3)];
  assert.deepEqual(calculateStreakStats(leapYearZero, { type: "daily" }, "0000-02-28", [], undefined, "0000-03-01"), { current: 3, best: 3, total: 3 });
  const normalizedCivilArchive = normalizeArchiveHistory([{
    archivedAt: 1,
    restoredAt: 2,
    archivedDate: "2011-12-30",
    restoredDate: "0000-02-29",
  }]);
  assert.equal(normalizedCivilArchive[0]?.archivedDate, "2011-12-30");
  assert.equal(isCivilDateKey("0000-02-29"), false);
  assert.notEqual(
    normalizedCivilArchive[0]?.restoredDate,
    "0000-02-29",
    "public date keys must remain inside the Common Era 0001-9999 contract",
  );
  assert.notEqual(
    normalizeArchiveHistory([{
      archivedAt: 1,
      restoredAt: null,
      archivedDate: "2011-02-29",
      restoredDate: null,
    }])[0]?.archivedDate,
    "2011-02-29",
    "an invalid civil day must still fall back to its authoritative timestamp",
  );
  const anchoredInterval: RepeatSchedule = { type: "interval", every: 2, fromCompletion: true };
  const anchor = [record("2011-12-28", "done", 1)];
  assert.equal(isHabitScheduledForDate(anchoredInterval, "2011-12-28", "2011-12-30", anchor), true);
  assert.deepEqual(calculateStreakStats(anchor, anchoredInterval, "2011-12-28", [], undefined, "2011-12-31"), { current: 0, best: 1, total: 1 });
  assert.equal(isHabitScheduledForDate({ type: "weekdays", days: [5] }, "2011-12-28", "2011-12-30"), true);
  assert.equal(isHabitScheduledForDate({ type: "interval", every: 2 }, "2011-12-28", "2011-12-30"), true);
  const upperBoundary = [record("9999-12-30", "done", 1), record("9999-12-31", "done", 2)];
  assert.equal(isHabitScheduledForDate(anchoredInterval, "9999-12-30", "9999-12-31", upperBoundary), false);
  assert.equal(createHabitScheduleMatcher(anchoredInterval, "9999-12-30", upperBoundary)("9999-12-31"), false);
  assert.deepEqual(calculateStreakStats(upperBoundary, anchoredInterval, "9999-12-30", [], undefined, "9999-12-31"), { current: 1, best: 1, total: 2 });
  assert.equal(calculateCurrentStreak(upperBoundary, anchoredInterval, "9999-12-30", [], undefined, "9999-12-31"), 1);
  const statisticsHabit: Habit = {
    id: 1,
    name: "Daily",
    description: null,
    descriptionVisible: true,
    repeatSchedule: { type: "daily" },
    scheduleHistory: [],
    startDate: "0001-01-01",
    reminderEnabled: false,
    reminderTime: null,
    displayOrder: 0,
    isArchived: false,
    archivedAt: null,
    archiveHistory: [],
    createdAt: 0,
    updatedAt: 0,
  };
  const statisticsFor = (
    todayStr: string,
    period: "week" | "month" | "year",
    periodOffset = 0,
  ) => calculateStatisticsPeriod(
    createStatisticsSourceIndex({
      allHabits: [statisticsHabit],
      allRecords: [],
      showArchivedHabitsInStatistics: false,
      todayStr,
    }),
    period,
    periodOffset,
    () => 0,
  );
  assert.deepEqual(
    statisticsFor("2011-12-31", "week").heatmapData.map(({ date }) => date),
    [
      "2011-12-26",
      "2011-12-27",
      "2011-12-28",
      "2011-12-29",
      "2011-12-30",
      "2011-12-31",
      "2012-01-01",
    ],
    "a civil week must keep every ISO date across a skipped local timezone day",
  );
  assert.deepEqual(
    statisticsFor("2022-01-01", "week").heatmapData.map(({ date }) => date),
    [
      "2021-12-27",
      "2021-12-28",
      "2021-12-29",
      "2021-12-30",
      "2021-12-31",
      "2022-01-01",
      "2022-01-02",
    ],
    "a week crossing a year boundary must remain Monday-based",
  );
  const previousDecember = statisticsFor("2012-01-15", "month", -1);
  assert.equal(previousDecember.heatmapData.length, 31);
  assert.equal(previousDecember.heatmapData[0]?.date, "2011-12-01");
  assert.equal(previousDecember.heatmapData[29]?.date, "2011-12-30");
  assert.equal(previousDecember.heatmapData[30]?.date, "2011-12-31");
  const leapMonth = statisticsFor("2024-02-29", "month");
  assert.equal(leapMonth.heatmapData.length, 29);
  assert.equal(leapMonth.heatmapData[0]?.date, "2024-02-01");
  assert.equal(leapMonth.heatmapData[28]?.date, "2024-02-29");
  assert.throws(
    () => statisticsFor("0000-02-29", "year"),
    RangeError,
    "Statistics presentation must reject a civil date outside the public Common Era range",
  );
  assert.equal(statisticsFor("9999-12-31", "year").heatmapData.length, 365);

  for (const fixture of statisticsEquivalenceFixtures) {
    const index = createStatisticsSourceIndex(fixture.source);
    for (const target of fixture.targets) {
      const stats = calculateStatisticsPeriod(
        index,
        target.period,
        target.periodOffset,
        (habit, records, evaluationDate) =>
          calculateCurrentStreak(
            [...records],
            habit.repeatSchedule,
            habit.startDate,
            habit.archiveHistory,
            habit.scheduleHistory,
            evaluationDate,
          ),
      );
      const key = `${fixture.name}:${target.period}:${target.periodOffset}`;
      const semanticProjection = {
        ...Object.fromEntries(
          Object.entries(stats).filter(([field]) => field !== "progressCounts"),
        ),
        heatmapData: stats.heatmapData.map(({ date, score }) => ({ date, score })),
      };
      assert.equal(
        createHash("sha256")
          .update(JSON.stringify(semanticProjection))
          .digest("hex"),
        expectedStatisticsEquivalenceHashes.get(key),
        `${key} must remain timezone-independent and reference-equivalent`,
      );
    }
  }

  assertCivilPeriodMutationRejected(
    "exclusive civil-period end",
    (source) => replaceExactlyOnce(
      source,
      "for (let day = startDay; day <= endDay; day += 1)",
      "for (let day = startDay; day < endDay; day += 1)",
    ),
    /civil week dates must remain Monday-based and end-inclusive/,
  );
  assertCivilPeriodMutationRejected(
    "shifted Monday week start",
    (source) => replaceExactlyOnce(
      source,
      "const startDay = baseDay - (base.isoWeekday - 1);",
      "const startDay = baseDay - base.isoWeekday;",
    ),
    /civil week dates must remain Monday-based and end-inclusive/,
  );
  assertCivilPeriodMutationRejected(
    "shifted civil-day iteration",
    (source) => replaceExactlyOnce(
      source,
      "const scheduleFacts = createScheduleDateFactsFromDayNumber(day);",
      "const scheduleFacts = createScheduleDateFactsFromDayNumber(day + 1);",
    ),
    /civil week dates must remain Monday-based and end-inclusive/,
  );
  const yearZeroValidator = loadCivilDateValidatorForMutation((source) =>
    replaceExactlyOnce(source, "if (year < 1) return false;", "if (year < 0) return false;"),
  );
  let rejectedYearZeroMutant = false;
  try {
    assert.equal(
      yearZeroValidator("0000-02-29"),
      false,
      "public date keys must reject year zero",
    );
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    assert.match(error.message, /public date keys must reject year zero/);
    rejectedYearZeroMutant = true;
  }
  assert.ok(
    rejectedYearZeroMutant,
    "the date-key audit must reject a mutant that expands the public contract to year zero",
  );
  if (process.env.TZ === "Pacific/Apia") {
    const mutatedValidator = loadCivilDateValidatorForMutation((source) =>
      replaceExactlyOnce(
        source,
        "parsed.getUTCDate() === day",
        "parsed.getDate() === day",
      ),
    );
    let rejected = false;
    try {
      assert.equal(
        mutatedValidator("2011-12-30"),
        true,
        "archive-date validation must use civil UTC fields",
      );
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      assert.match(error.message, /archive-date validation must use civil UTC fields/);
      rejected = true;
    }
    assert.ok(
      rejected,
      "local-field archive-date validation must be detected in the skipped-day timezone",
    );
  }
  console.log(`Streak audit passed: 3000 generated histories, TZ=${process.env.TZ}.`);
}

if (process.argv.includes("--worker")) runCases();
else {
  for (const zone of ["UTC", "Africa/Cairo", "America/Santiago", "Pacific/Apia"]) {
    process.stdout.write(execFileSync(process.execPath, [...process.execArgv, __filename, "--worker"], {
      env: { ...process.env, TZ: zone }, encoding: "utf8", timeout: 120_000,
    }));
  }
}
