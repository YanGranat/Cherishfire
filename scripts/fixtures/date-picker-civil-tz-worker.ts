import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UTCDateMini } from "@date-fns/utc";
import { addMonths } from "date-fns/addMonths";
import { format } from "date-fns/format";
import { endOfMonth } from "date-fns/endOfMonth";
import { parseISO } from "date-fns/parseISO";
import { startOfMonth } from "date-fns/startOfMonth";
import { subMonths } from "date-fns/subMonths";
import { isCivilDateKey } from "../../src/domain/dates/civil-date";
import { DatePickerMonthModelCache, prewarmAdjacentDatePickerMonthModels } from "../../src/features/habit-form/utils/date-picker-month-model";
import { resolveDatePickerSelectionIntent } from "../../src/features/habit-form/utils/date-picker-selection-intent";
import { LANGUAGE_OPTIONS, normalizeLanguageCode } from "../../src/i18n/languages";
import { formatCivilDate, formatLocalizedDate, formatLocalizedDateTime, getDateFnsLocale, toCivilDate } from "../../src/utils/date";
import { buildExportJsonFromRows, normalizeImportData, validateImportData } from "../../src/application/data-transfer/data-transfer-codec";
import { loadSourceCallableForAudit } from "./load-source-callable-for-audit";

const modelCache = new DatePickerMonthModelCache();
const pad = (value: number) => String(value).padStart(2, "0");
const key = (year: number, month: number, day: number) => `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
const daysInMonth = (year: number, month: number) => month === 2
  ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  : [4, 6, 9, 11].includes(month) ? 30 : 31;

function assertCivilRoundtrip(dateKey: string): void {
  assert.equal(isCivilDateKey(dateKey), true);
  const parsed = toCivilDate(dateKey);
  assert.ok(parsed instanceof UTCDateMini, "civil parsing must return a UTC date extension");
  assert.equal(parsed.getTimezoneOffset(), 0);
  assert.equal(format(parsed, "yyyy-MM-dd"), dateKey, "civil dates must roundtrip independently of the device time zone");
  assert.equal(formatCivilDate(dateKey, "yyyy-MM-dd", "en"), dateKey);
}

for (const year of [1, 99, 100, 1900, 2000, 2011, 2024, 2026, 9999]) {
  for (let month = 1; month <= 12; month += 1) {
    const startKey = key(year, month, 1);
    const model = modelCache.get(startKey, "en");
    const count = daysInMonth(year, month);
    assert.equal(model.days.length, count, "the calendar must include every Gregorian date exactly once");
    assert.deepEqual(model.days.map(day => day.dateString), Array.from({ length: count }, (_, index) => key(year, month, index + 1)));
    model.days.forEach(day => {
      assertCivilRoundtrip(day.dateString);
      assert.equal(day.dayNumber, Number(day.dateString.slice(-2)));
      assert.equal(day.dayLabel, String(day.dayNumber));
      assert.equal(Object.hasOwn(day, "dayTime"), false, "civil cells must not retain a local-time selection surrogate");
      assert.equal(Object.hasOwn(day, "key"), false);
      assert.ok(Object.isFrozen(day));
    });
    assert.ok(Object.isFrozen(model) && Object.isFrozen(model.days) && Object.isFrozen(model.gridSlots));
    assert.equal(model.gridSlots.length, model.offset + count);
    model.gridSlots.forEach((slot, index) => {
      assert.equal(slot.key, `slot-${index}`);
      assert.equal(slot.day, index < model.offset ? null : model.days[index - model.offset]);
      assert.ok(Object.isFrozen(slot));
    });
  }
}

assertCivilRoundtrip("2011-12-30");
assert.equal(modelCache.get("2011-12-30", "en").days.length, 31);
for (const value of [null, 1, {}, "", "0000-01-01", "10000-01-01", "-0001-01-01", "2024-2-01", "2024-00-01", "2024-13-01", "2024-02-00", "2024-02-30", "1900-02-29", "2023-02-29", "2024-01-32", "2024-02-29T12:00:00Z", " 2024-02-29"]) {
  assert.equal(isCivilDateKey(value), false);
  if (typeof value !== "string") continue;
  assert.ok(Number.isNaN(toCivilDate(value).getTime()));
  assert.equal(formatCivilDate(value, "P", "en"), value, "invalid civil inputs must not fall back to the current day");
}
for (const invalid of ["0000-01-01", "2023-02-29", "bad-date"]) {
  assert.equal(formatLocalizedDate(invalid, "en"), invalid);
  assert.throws(() => modelCache.get(invalid, "en"), RangeError);
}
assert.equal(formatLocalizedDate(new Date(NaN), "en"), "");
assert.equal(formatLocalizedDateTime(new Date(NaN), "en"), "");
const beforeCommonEra = new Date(0);
beforeCommonEra.setFullYear(0, 0, 1);
assert.throws(() => modelCache.get(beforeCommonEra, "en"), RangeError);

for (const { code } of LANGUAGE_OPTIONS) {
  for (const year of [2024, 2026]) {
    for (let month = 1; month <= 12; month += 1) {
      const localMonth = new Date(year, month - 1, 15, 12);
      const model = modelCache.get(localMonth, code);
      assert.equal(modelCache.get(key(year, month, 1), code), model, "Date and civil-key inputs must share one normalized month");
      for (const boundary of [new Date(year, month - 1, 1, 0, 30), new Date(year, month - 1, daysInMonth(year, month), 23, 30)]) {
        assert.equal(modelCache.get(boundary, code), model, "Date inputs must preserve their local month even across a UTC month boundary");
      }
      const localStart = new Date(year, month - 1, 1, 12);
      assert.equal(model.label, format(localStart, "LLLL yyyy", { locale: getDateFnsLocale(code) }));
      assert.equal(model.offset, (localStart.getDay() + 6) % 7);
      for (const day of model.days) {
        const local = new Date(year, month - 1, day.dayNumber, 12);
        const expected = format(local, "P", { locale: getDateFnsLocale(code) });
        assert.equal(day.accessibilityLabel, expected, "ordinary calendar labels must preserve all supported locale formats");
        assert.equal(formatLocalizedDate(day.dateString, code), expected);
        assert.equal(formatLocalizedDate(local, code), expected);
        assert.equal(formatLocalizedDateTime(local, code), format(local, "Pp", { locale: getDateFnsLocale(code) }));
      }
    }
  }
  for (const timestamp of ["2024-03-31T23:30:00Z", "2024-10-27T00:30:00+02:00"]) {
    assert.equal(formatLocalizedDate(timestamp, code), format(parseISO(timestamp), "P", { locale: getDateFnsLocale(code) }), "timestamp strings must retain local wall-clock formatting");
  }
}

const bounded = new DatePickerMonthModelCache();
for (let month = 0; month < 50; month += 1) bounded.get(addMonths(toCivilDate("2000-01-01"), month), "en");
assert.equal(bounded.size, 18);
const familiar = bounded.get("2011-12-30", "en");
assert.equal(bounded.get("2011-12-01", "en"), familiar);
const adjacent = new DatePickerMonthModelCache(5);
adjacent.get("2011-12-30", "en");
prewarmAdjacentDatePickerMonthModels("2011-12-30", "en", adjacent);
assert.equal(adjacent.size, 5);
for (const month of ["2011-10-01", "2011-11-01", "2011-12-01", "2012-01-01", "2012-02-01"]) assert.equal(adjacent.getWithStatus(month, "en").cacheHit, true);
for (const edge of ["0001-01-01", "9999-12-01"]) {
  const edgeCache = new DatePickerMonthModelCache(5);
  edgeCache.get(edge, "en");
  prewarmAdjacentDatePickerMonthModels(edge, "en", edgeCache);
  assert.equal(edgeCache.size, 3, "prewarm must skip months outside the public Common Era range");
}
assert.deepEqual(new Set(Array.from({ length: 12 }, (_, index) => modelCache.get(key(2026, index + 1, 1), "en").offset)), new Set([0, 1, 2, 3, 4, 5, 6]));
assert.deepEqual(resolveDatePickerSelectionIntent("2011-12-31", "2011-12-30", "2011-12-30"), { draftChanged: true, publishSelection: true, outcome: "stable" });
assert.deepEqual(resolveDatePickerSelectionIntent("2011-12-30", "2011-12-31", "2011-12-30"), { draftChanged: false, publishSelection: true, outcome: "pending" });

const pickerSource = readFileSync(resolve("src/features/habit-form/components/DatePickerModal.tsx"), "utf8");
function monthNavigation(initial: string) {
  const currentMonthRef = { current: initial };
  const renderedMonthRef = { current: initial };
  let published = initial;
  const environment = { currentMonthRef, renderedMonthRef,
    monthModel: modelCache.get(initial, "en"), toCivilDate, addMonths, subMonths, format,
    setCurrentMonth(value: string) { published = value; },
  };
  return {
    previous: loadSourceCallableForAudit<() => void>(pickerSource, "showPreviousMonth", environment),
    next: loadSourceCallableForAudit<() => void>(pickerSource, "showNextMonth", environment),
    value: () => published,
    requested: () => currentMonthRef.current,
    committed: () => renderedMonthRef.current,
  };
}
for (const [initial, direction, expected] of [
  ["0001-01-01", "previous", "0001-01-01"],
  ["9999-12-01", "next", "9999-12-01"],
  ["0099-12-01", "next", "0100-01-01"],
  ["0100-01-01", "previous", "0099-12-01"],
  ["2011-11-01", "next", "2011-12-01"],
] as const) {
  const navigation = monthNavigation(initial);
  navigation[direction]();
  assert.equal(navigation.value(), expected, "real month callbacks must preserve civil arithmetic and supported-year bounds");
}
const rapidMonth = monthNavigation("2011-12-01");
rapidMonth.next();
rapidMonth.next();
assert.equal(rapidMonth.value(), "2012-02-01", "rapid arrows must derive from the latest requested civil month");
rapidMonth.previous();
rapidMonth.previous();
assert.equal(rapidMonth.value(), "2011-12-01");
assert.equal(rapidMonth.requested(), rapidMonth.committed(), "a rapid month reversal must settle on the committed month");

const baseline = normalizeImportData(readFileSync(resolve("scripts/fixtures/export-v5-baseline.json"), "utf8"));
const transferred = buildExportJsonFromRows({
  habits: [{ ...baseline.habits[0], startDate: "2011-12-30", repeatType: "daily", repeatConfig: {
    scheduleHistory: [{ effectiveFrom: "2011-12-30", startDate: "2011-12-30", repeatSchedule: { type: "daily" } }],
  }, archiveHistory: [{ archivedAt: 1, restoredAt: 2, archivedDate: "2011-12-29", restoredDate: "2011-12-30" }] }],
  dayRecords: [{ ...baseline.day_records[0], date: "2011-12-30" }],
  notes: [{ ...baseline.notes[0], date: "2011-12-30" }],
  settings: baseline.settings,
  exportedAt: "2000-01-01T00:00:00.000Z",
});
assert.equal(validateImportData(transferred).valid, true, "a valid civil date must remain importable after a time-zone change");
const imported = normalizeImportData(transferred);
assert.equal(imported.habits[0].startDate, "2011-12-30");
assert.equal(imported.habits[0].archiveHistory[0].restoredDate, "2011-12-30");
assert.equal(imported.day_records[0].date, "2011-12-30");
assert.equal(imported.notes[0].date, "2011-12-30");
assert.equal(imported.integrity.day_records_by_date["2011-12-30"], 1);
assert.equal(imported.integrity.notes_by_date["2011-12-30"], 1);
for (const invalid of ["0000-01-01", "2023-02-29"]) {
  assert.throws(() => buildExportJsonFromRows({ habits: imported.habits,
    dayRecords: [{ ...imported.day_records[0], date: invalid }], notes: imported.notes,
    settings: imported.settings, exportedAt: "2000-01-01T00:00:00.000Z",
  }), /Invalid day_records\[0\]\.date/, "export validation must retain strict public date-key bounds");
}

const dateSource = readFileSync(resolve("src/utils/date.ts"), "utf8");
const target = "parseISO(dateString, { in: (value) => new UTCDateMini(value) })";
assert.equal(dateSource.split(target).length, 2, "the civil-context mutation must select one parser");
const localParser = loadSourceCallableForAudit<typeof toCivilDate>(dateSource.replace(target, "parseISO(dateString)"), "toCivilDate", { isCivilDateKey, UTCDateMini, parseISO });
assert.notEqual(localParser("2011-12-30").constructor, UTCDateMini, "the civil parser regression must be observable");
assert.throws(() => assert.ok(localParser("2011-12-30") instanceof UTCDateMini), assert.AssertionError);
const validatorSource = readFileSync(resolve("src/domain/dates/civil-date.ts"), "utf8");
const eraGuard = "if (year < 1) return false;";
assert.equal(validatorSource.split(eraGuard).length, 2);
const yearZeroValidator = loadSourceCallableForAudit<typeof isCivilDateKey>(validatorSource.replace(eraGuard, ""), "isCivilDateKey", { Date });
assert.throws(() => assert.equal(yearZeroValidator("0000-02-29"), false), assert.AssertionError,
  "removing the public Common Era bound must violate the acceptance contract");
if (process.env.TZ === "Pacific/Apia") {
  const localValidator = loadSourceCallableForAudit<typeof isCivilDateKey>(validatorSource
    .replace("setUTCFullYear", "setFullYear")
    .replaceAll("getUTCFullYear", "getFullYear")
    .replaceAll("getUTCMonth", "getMonth")
    .replaceAll("getUTCDate", "getDate"), "isCivilDateKey", { Date });
  assert.throws(() => assert.equal(localValidator("2011-12-30"), true), assert.AssertionError,
    "local-calendar validation must reject a valid skipped civil date and fail the contract");
}

const modelSource = readFileSync(resolve("src/features/habit-form/utils/date-picker-month-model.ts"), "utf8");
const describeMonth = loadSourceCallableForAudit<(date: Date | string, language: string) => { start: Date }>(modelSource, "describeMonth", { toCivilDate, format, startOfMonth, endOfMonth, normalizeLanguageCode });
for (const [guard, date] of [
  ["if (previousMonth.getUTCFullYear() >= 1)", "0001-01-01"],
  ["if (nextMonth.getUTCFullYear() <= 9999)", "9999-12-01"],
] as const) {
  assert.equal(modelSource.split(guard).length, 2, "a boundary mutation must target one prewarm guard");
  const unboundedPrewarm = loadSourceCallableForAudit<typeof prewarmAdjacentDatePickerMonthModels>(
    modelSource.replace(guard, "if (true)"), "prewarmAdjacentDatePickerMonthModels", { describeMonth, addMonths, subMonths },
  );
  assert.throws(() => assert.doesNotThrow(() => unboundedPrewarm(date, "en", new DatePickerMonthModelCache())), assert.AssertionError,
    "prewarming beyond a supported year must violate the no-throw boundary contract");
}
const selectionSource = readFileSync(resolve("src/features/habit-form/utils/date-picker-selection-intent.ts"), "utf8");
const selectionGuard = "if (nextDate === renderedPickedDate)";
assert.equal(selectionSource.split(selectionGuard).length, 2);
const draftOnly = loadSourceCallableForAudit<typeof resolveDatePickerSelectionIntent>(selectionSource.replace(selectionGuard, "if (nextDate === pickedDate)"), "resolveDatePickerSelectionIntent", {});
assert.throws(() => assert.equal(draftOnly("2011-12-30", "2011-12-31", "2011-12-30").outcome, "pending"), assert.AssertionError,
  "confusing draft and committed dates must violate rapid-selection ownership");

console.log(`Civil date worker passed: ${process.env.TZ}.`);
