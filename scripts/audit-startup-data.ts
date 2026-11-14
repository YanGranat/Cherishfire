import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { mapDayRecordDatabaseRow, type RawDayRecordDatabaseRow } from "../src/db/rows";
import type { DayRecord, Habit } from "../src/types/habit";
import { loadHabitStoreForAudit } from "./fixtures/load-habit-store-for-audit";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

const mutation = process.argv.find(argument => argument.startsWith("--mutation="))?.slice(11);
const knownMutations = new Set(["window-before-history", "history-not-enqueued", "duplicate-history", "mapping-timestamps", "mapping-date-allocation"]);
assert.ok(!mutation || knownMutations.has(mutation), "the selected startup mutation must be known");

function replaceOnce(source: string, target: string, replacement: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  target = target.replace(/\r?\n/g, newline);
  replacement = replacement.replace(/\r?\n/g, newline);
  assert.equal(source.split(target).length - 1, 1, "the startup mutation target must be unique");
  return source.replace(target, replacement);
}

function auditRawMapping(): void {
  let source = readFileSync(resolve("src/data/sqlite/habit-repository.ts"), "utf8");
  if (mutation === "mapping-timestamps") source = replaceOnce(source,
    "    createdAt: row.created_at,", "    createdAt: row.updated_at,");
  if (mutation === "mapping-date-allocation") source = replaceOnce(source,
    "    createdAt: row.created_at,", "    createdAt: new Date(row.created_at).getTime(),");
  let dateAllocations = 0;
  class CountingDate extends Date {
    constructor(value: number) { super(value); dateAllocations += 1; }
  }
  const mapModel = loadSourceCallableForAudit<(row: RawDayRecordDatabaseRow) => DayRecord>(
    source, "mapRawDayRecordRow", { Date: CountingDate },
  );
  const epochs = [-8_640_000_000_000_000, -1, 0, 1,
    Date.UTC(2020, 2, 8, 7), Date.UTC(2020, 9, 25, 1), 8_640_000_000_000_000];
  const statuses = ["done", "minimum", "maximum", "skipped", "failure"] as const;
  for (const [index, createdAt] of epochs.entries()) {
    for (const status of statuses) {
      const raw: RawDayRecordDatabaseRow = {
        id: index + 1, habit_id: 20 + index, date: "2000-02-29", status,
        created_at: createdAt, updated_at: epochs[(index + 1) % epochs.length],
      };
      const row = mapDayRecordDatabaseRow(raw);
      assert.ok(row.createdAt instanceof Date && row.updatedAt instanceof Date,
        "schema/export rows must retain their Date-valued timestamp contract");
      const model = mapModel(raw);
      assert.deepEqual({ ...model }, {
        id: row.id, habitId: row.habitId, date: row.date, status: row.status,
        createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
      }, "raw model mapping must preserve valid persisted epochs and every record field");
      assert.equal(raw.created_at, createdAt, "mapping must not mutate the raw database row");
    }
  }
  assert.equal(dateAllocations, 0, "domain record mapping must not allocate intermediate Date objects");
}

interface EffectDefinition {
  readonly callback: string;
  readonly dependencies: readonly string[];
}

function startupEffects(): EffectDefinition[] {
  let source = readFileSync(resolve("app/index.tsx"), "utf8");
  if (mutation === "window-before-history") source = replaceOnce(source,
    "    if (!allDayRecordsLoaded) return;\n    if (currentDayRecordsDate === selectedDate) return;",
    "    if (currentDayRecordsDate === selectedDate) return;");
  if (mutation === "history-not-enqueued") source = replaceOnce(source,
    "    void loadAllDayRecords();", "    void 0;");
  if (mutation === "duplicate-history") source = replaceOnce(source,
    "    void loadAllDayRecords();", "    void loadAllDayRecords();\n    void loadAllDayRecords();");
  const tree = ts.createSourceFile("index.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let owner: ts.FunctionExpression | undefined;
  const findOwner = (node: ts.Node): void => {
    if (ts.isFunctionExpression(node) && node.name?.text === "HabitListScreenContent") owner = node;
    ts.forEachChild(node, findOwner);
  };
  findOwner(tree);
  assert.ok(owner, "the Home data effects must belong to the live content owner");
  const effects: EffectDefinition[] = [];
  for (const statement of owner.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "useEffect") continue;
    const [callback, dependencies] = call.arguments;
    if (!callback || !ts.isArrowFunction(callback) || !dependencies || !ts.isArrayLiteralExpression(dependencies)) continue;
    if (!ts.isBlock(callback.body)) continue;
    const invokesHydration = callback.body.statements.some(statement => {
      if (!ts.isExpressionStatement(statement)) return false;
      const expression = ts.isVoidExpression(statement.expression) ? statement.expression.expression : statement.expression;
      return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
        ["loadHabits", "loadAllDayRecords", "loadDayRecords"].includes(expression.expression.text);
    });
    if (!invokesHydration) continue;
    const callbackText = callback.getText(tree);
    assert.ok(dependencies.elements.every(ts.isIdentifier), "data effect dependencies must remain explicit stable bindings");
    effects.push({ callback: callbackText, dependencies: dependencies.elements.map(node => node.getText(tree)) });
  }
  return effects;
}

async function auditStartupDispatch(): Promise<void> {
  const initialHabit: Habit = {
    id: 1, name: "Practice", description: null, descriptionVisible: false,
    repeatSchedule: { type: "daily" }, startDate: "2001-01-01",
    reminderEnabled: false, reminderTime: null, displayOrder: 0,
    isArchived: false, archivedAt: null, archiveHistory: [], createdAt: 1, updatedAt: 1,
  };
  const { storeModule, persistence } = loadHabitStoreForAudit({ habits: [initialHabit], records: [] });
  const store = storeModule.useHabitStore;
  const definitions = startupEffects();
  const queue: string[] = [];
  let rangeReads = 0;
  let historyReads = 0;
  const readRange = persistence.application.readDayRecordsInDateRange;
  const readHistory = persistence.application.readAllDayRecords;
  persistence.application.readDayRecordsInDateRange = (...args) => { rangeReads += 1; return readRange(...args); };
  persistence.application.readAllDayRecords = () => { historyReads += 1; return readHistory(); };
  let pending: Promise<unknown>[] = [];
  const loadHabits = () => { queue.push("habits"); pending.push(store.getState().loadHabits()); };
  const loadAllDayRecords = () => { queue.push("history"); pending.push(store.getState().loadAllDayRecords()); };
  const loadDayRecords = (date: string) => { queue.push("day"); pending.push(store.getState().loadDayRecords(date)); };
  const previous = new Map<number, readonly unknown[]>();
  async function render(selectedDate: string): Promise<void> {
    const state = store.getState();
    const environment: Record<string, unknown> = {
      loadHabits, loadAllDayRecords, loadDayRecords, selectedDate,
      allDayRecordsLoaded: state.allDayRecordsLoaded,
      currentDayRecordsDate: state.currentDayRecordsDate,
      hasSelectedDateCached: Object.hasOwn(state.dayRecordsByDate, selectedDate),
    };
    pending = [];
    for (const [index, effect] of definitions.entries()) {
      const next = effect.dependencies.map(name => {
        assert.ok(Object.hasOwn(environment, name), `the fixture must supply dependency ${name}`);
        return environment[name];
      });
      const before = previous.get(index);
      if (before && before.length === next.length && next.every((value, offset) => Object.is(value, before[offset]))) continue;
      previous.set(index, next);
      const callback = loadSourceCallableForAudit<() => void>(
        `const invoke = useEffect(${effect.callback});`, "invoke", environment,
      );
      callback();
    }
    await Promise.all(pending);
  }
  await render("2002-05-14");
  assert.deepEqual(queue, ["habits", "history"],
    "cold Home must enqueue only habits and complete history before any date-window read");
  assert.equal(historyReads, 1);
  assert.equal(rangeReads, 0, "cold startup must not queue a redundant selected-date SQL window");
  await render("2002-05-14");
  assert.deepEqual(queue, ["habits", "history", "day"]);
  assert.equal(rangeReads, 0);
  assert.equal(store.getState().currentDayRecordsDate, "2002-05-14");
  await render("2002-05-15");
  assert.equal(store.getState().currentDayRecordsDate, "2002-05-15");
  assert.equal(rangeReads, 0, "adjacent dates must derive from complete in-memory history");
  const beforeReadyRender = queue.length;
  await render("2002-05-15");
  assert.equal(queue.length, beforeReadyRender, "an unchanged ready state must not enqueue more hydration jobs");
  store.setState({ allDayRecordsLoaded: false });
  await render("2002-05-15");
  assert.equal(queue.at(-1), "history", "revoked history readiness must retain its authoritative retry");
  assert.equal(historyReads, 2);
  assert.equal(rangeReads, 0, "readiness recovery must not reintroduce the date-window query");
  await render("2002-05-15");
  assert.equal(store.getState().allDayRecordsLoaded, true);
}

async function main(): Promise<void> {
  auditRawMapping();
  await auditStartupDispatch();
}
const timeout = setTimeout(() => { throw new Error("Startup data audit did not settle"); }, 10_000);
void main().then(() => {
  console.log("Startup data audit passed: raw epoch parity, ordered hydration and authoritative history retries.");
}, error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => { clearTimeout(timeout); });
