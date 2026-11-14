import assert from "node:assert/strict";
import type { DayRecord, DayStatus, Habit } from "../src/types/habit";
import {
  loadHabitStoreForAudit,
  type HabitStoreAuditDataset,
  type HabitStoreAuditSourceOptions,
} from "./fixtures/load-habit-store-for-audit";

function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const TEST_DATE = localIsoDate(new Date());
const READ_TIMEOUT_MS = 2_000;
const SCENARIO_TIMEOUT_MS = 10_000;

type StoreModule = ReturnType<typeof loadHabitStoreForAudit>["storeModule"];

interface Scenario {
  name: string;
  run(): Promise<void>;
}

function habit(id: number, name: string): Habit {
  return {
    id,
    name,
    description: null,
    descriptionVisible: false,
    repeatSchedule: { type: "daily" },
    startDate: TEST_DATE,
    reminderEnabled: false,
    reminderTime: null,
    displayOrder: id - 1,
    isArchived: false,
    archivedAt: null,
    archiveHistory: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

function record(
  id: number,
  habitId: number,
  status: DayStatus,
): DayRecord {
  return {
    id,
    habitId,
    date: TEST_DATE,
    status,
    createdAt: id,
    updatedAt: id,
  };
}

function dataset(
  habits: readonly Habit[],
  records: readonly DayRecord[],
): HabitStoreAuditDataset {
  return { habits, records };
}

async function hydrateStore(storeModule: StoreModule, committedImport = false): Promise<void> {
  const initial = storeModule.useHabitStore.getState();
  assert.equal(await initial.loadHabits(committedImport ? { mode: "committed-import" } : undefined), true, "habit hydration must succeed");
  assert.equal(
    await storeModule.useHabitStore.getState().loadDayRecords(TEST_DATE),
    true,
    "date hydration must succeed",
  );
  assert.equal(
    await storeModule.useHabitStore.getState().loadAllDayRecords(),
    true,
    "history hydration must succeed",
  );
  storeModule.useHabitStore.getState().getDayListSnapshot(TEST_DATE, false);
}

function statusFor(
  records: readonly DayRecord[] | undefined,
  habitId: number,
): DayStatus | null {
  return (
    records?.find(
      (candidate) =>
        candidate.habitId === habitId && candidate.date === TEST_DATE,
    )?.status ?? null
  );
}

function assertVisibleOwners(
  storeModule: StoreModule,
  expected: ReadonlyMap<number, DayStatus | null>,
): void {
  const state = storeModule.useHabitStore.getState();
  const snapshot = state.getDayListSnapshot(TEST_DATE, false);
  for (const [habitId, expectedStatus] of expected) {
    assert.equal(
      statusFor(state.allDayRecords, habitId),
      expectedStatus,
      `allDayRecords must expose the authoritative status for habit ${habitId}`,
    );
    assert.equal(
      statusFor(state.dayRecordsByDate[TEST_DATE], habitId),
      expectedStatus,
      `dayRecordsByDate must expose the authoritative status for habit ${habitId}`,
    );
    assert.equal(
      statusFor(state.dayRecords, habitId),
      expectedStatus,
      `current dayRecords must expose the authoritative status for habit ${habitId}`,
    );
    assert.equal(
      snapshot.statusByHabitId.get(habitId) ?? null,
      expectedStatus,
      `Home snapshot must expose the authoritative status for habit ${habitId}`,
    );
    const item = [...snapshot.activeItems, ...snapshot.completedItems].find(
      (candidate) => candidate.habit.id === habitId,
    );
    const expectedStreak =
      expectedStatus === "done" ||
      expectedStatus === "minimum" ||
      expectedStatus === "maximum"
        ? 1
        : 0;
    assert.equal(
      item?.currentStreak,
      expectedStreak,
      `Home snapshot must reconcile the streak for habit ${habitId}`,
    );
  }
}

async function assertModuleDateCache(
  storeModule: StoreModule,
  expected: ReadonlyMap<number, DayStatus | null>,
): Promise<void> {
  storeModule.useHabitStore.setState((state) => {
    const nextByDate = { ...state.dayRecordsByDate };
    delete nextByDate[TEST_DATE];
    return {
      currentDayRecordsDate: null,
      dayRecords: [],
      dayRecordsByDate: nextByDate,
    };
  });
  assert.equal(
    await storeModule.useHabitStore.getState().loadDayRecords(TEST_DATE),
    true,
    "the derived date cache must remain readable",
  );
  const state = storeModule.useHabitStore.getState();
  for (const [habitId, expectedStatus] of expected) {
    assert.equal(
      statusFor(state.dayRecords, habitId),
      expectedStatus,
      `module date cache must expose the authoritative status for habit ${habitId}`,
    );
  }
}

async function waitForRead(
  entered: Promise<string>,
  scenario: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(`${scenario} did not start an authoritative read`),
            ),
          READ_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function runScenarioWithTimeout(scenario: Scenario): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scenario.run(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${scenario.name} did not settle`)),
          SCENARIO_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sourceOptionsFromArguments(): HabitStoreAuditSourceOptions {
  const mutationArgument = process.argv.find((argument) =>
    argument.startsWith("--mutation="),
  );
  const mutation = mutationArgument?.slice("--mutation=".length);
  if (!mutation) return {};
  if (mutation === "skip-hot-date-repair") {
    return {
      transform(source) {
        const target = "updates: { [date]: nextDateRecords },";
        assert.equal(
          source.split(target).length - 1,
          1,
          "hot-date mutation target must be unique",
        );
        return source.replace(target, "updates: {},");
      },
    };
  }
  if (mutation === "drop-repair-ownership") {
    return {
      transform(source) {
        const target = "isLatestDayMutation(key, mutationId) &&";
        assert.equal(
          source.split(target).length - 1,
          1,
          "ownership mutation target must be unique",
        );
        return source.replace(target, "true &&");
      },
    };
  }
  if (mutation === "replace-whole-date-repair") {
    return {
      transform(source) {
        const start = source.indexOf("async function repairFailedDayMutation");
        const end = source.indexOf("export const useHabitStore", start);
        assert.ok(start >= 0 && end > start, "repair function must exist");
        const repair = source.slice(start, end);
        const dateTarget = /const nextDateRecords = replaceHabitRecordsForDate\([\s\S]*?new Map\(record \? \[\[date, record\]\] : \[\]\),\s*\);/;
        const allTarget = /const nextAll = state\.allDayRecords\.filter\([\s\S]*?\);\s*if \(record\) nextAll\.push\(record\);/;
        assert.match(repair, dateTarget);
        assert.match(repair, allTarget);
        const mutatedRepair = repair
          .replace(
            dateTarget,
            "const nextDateRecords = applyDayRecordOverlaysForDate(persisted, date);",
          )
          .replace(
            allTarget,
            "const nextAll = state.allDayRecords.filter((entry) => entry.date !== date);\n      nextAll.push(...nextDateRecords);",
          );
        return `${source.slice(0, start)}${mutatedRepair}${source.slice(end)}`;
      },
    };
  }
  if (mutation === "drop-read-generation-guard") {
    return {
      transform(source) {
        const target =
          /if \(generation !== dayRecordReadGeneration\)\s*\{\s*continue;\s*\}/g;
        assert.equal(
          [...source.matchAll(target)].length,
          1,
          "read-generation mutation target must be unique",
        );
        return source.replace(target, "if (false) { continue; }");
      },
    };
  }
  if (mutation === "drop-unmark-success-read-fence") {
    return {
      transform(source) {
        const start = source.indexOf("async unmarkDay(habitId, date)");
        const end = source.indexOf("resetInMemoryCaches()", start);
        assert.ok(start >= 0 && end > start, "unmark function must exist");
        const unmark = source.slice(start, end);
        const target = "invalidatePendingDayRecordReads();";
        assert.equal(
          unmark.split(target).length - 1,
          1,
          "unmark success-fence mutation target must be unique",
        );
        const mutatedUnmark = unmark.replace(target, "void 0;");
        return `${source.slice(0, start)}${mutatedUnmark}${source.slice(end)}`;
      },
    };
  }
  throw new Error(`Unknown mutation: ${mutation}`);
}

const sourceOptions = sourceOptionsFromArguments();

function load(
  initialDataset: HabitStoreAuditDataset,
): ReturnType<typeof loadHabitStoreForAudit> {
  return loadHabitStoreForAudit(initialDataset, sourceOptions);
}

const scenarios: Scenario[] = [
  {
    name: "mark failure restores every visible record owner",
    async run() {
      const firstHabit = habit(1, "Morning walk");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(101, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextMark();

      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "failure"),
        false,
        "a rejected mark must report failure",
      );
      const expected = new Map([[firstHabit.id, "done" as const]]);
      assertVisibleOwners(storeModule, expected);
      assert.match(
        storeModule.useHabitStore.getState().error ?? "",
        /Injected mark persistence failure/,
        "the owned failure must remain user-visible",
      );
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "unmark failure restores every visible record owner",
    async run() {
      const firstHabit = habit(1, "Read a chapter");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(102, firstHabit.id, "minimum")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextUnmark();

      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .unmarkDay(firstHabit.id, TEST_DATE),
        false,
        "a rejected unmark must report failure",
      );
      const expected = new Map([[firstHabit.id, "minimum" as const]]);
      assertVisibleOwners(storeModule, expected);
      assert.match(
        storeModule.useHabitStore.getState().error ?? "",
        /Injected unmark persistence failure/,
        "the owned failure must remain user-visible",
      );
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "late same-key repair cannot replace a newer successful intent",
    async run() {
      const firstHabit = habit(1, "Stretch");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(103, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextMark();
      const deferredRead = persistence.deferNextAuthoritativeRead();

      const rejected = storeModule.useHabitStore
        .getState()
        .markDay(firstHabit.id, TEST_DATE, "failure");
      await waitForRead(deferredRead.entered, "same-key repair");
      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "maximum"),
        true,
        "the newer same-key intent must persist",
      );
      deferredRead.release();
      assert.equal(
        await rejected,
        true,
        "a superseded failure must not report a current action failure",
      );

      const expected = new Map([[firstHabit.id, "maximum" as const]]);
      assertVisibleOwners(storeModule, expected);
      assert.equal(
        storeModule.useHabitStore.getState().error,
        null,
        "a superseded failure must not publish a stale global error",
      );
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "one habit repair cannot replace another habit's newer write",
    async run() {
      const firstHabit = habit(1, "Journal");
      const secondHabit = habit(2, "Practice scales");
      const { storeModule, persistence } = load(
        dataset(
          [firstHabit, secondHabit],
          [
            record(104, firstHabit.id, "done"),
            record(105, secondHabit.id, "done"),
          ],
        ),
      );
      await hydrateStore(storeModule);
      persistence.failNextMark();
      const deferredRead = persistence.deferNextAuthoritativeRead();

      const rejected = storeModule.useHabitStore
        .getState()
        .markDay(firstHabit.id, TEST_DATE, "failure");
      await waitForRead(deferredRead.entered, "cross-habit repair");
      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(secondHabit.id, TEST_DATE, "maximum"),
        true,
        "the competing habit write must persist",
      );
      deferredRead.release();
      assert.equal(await rejected, false);

      const expected = new Map<number, DayStatus | null>([
        [firstHabit.id, "done"],
        [secondHabit.id, "maximum"],
      ]);
      assertVisibleOwners(storeModule, expected);
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "a stale full-history read cannot overwrite a successful repair",
    async run() {
      const firstHabit = habit(1, "Plan tomorrow");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(106, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      const deferredRead = persistence.deferNextAuthoritativeRead();
      const staleHistoryLoad = storeModule.useHabitStore
        .getState()
        .loadAllDayRecords();
      await waitForRead(deferredRead.entered, "stale full-history read");

      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "maximum"),
        true,
        "the first same-key intent must persist",
      );
      persistence.failNextMark();
      const rejected = storeModule.useHabitStore
        .getState()
        .markDay(firstHabit.id, TEST_DATE, "failure");
      assert.equal(
        await rejected,
        false,
        "the newer rejected intent must be repaired from persisted state",
      );

      deferredRead.release();
      const staleHistoryResult = await staleHistoryLoad;
      const expected = new Map([[firstHabit.id, "maximum" as const]]);
      assertVisibleOwners(storeModule, expected);
      assert.equal(
        staleHistoryResult,
        true,
        "snapshot invalidation must transparently retry the history read",
      );
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "a stale date-window read cannot overwrite a successful repair",
    async run() {
      const firstHabit = habit(1, "Prepare breakfast");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(107, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      storeModule.useHabitStore.setState((state) => {
        const nextByDate = { ...state.dayRecordsByDate };
        delete nextByDate[TEST_DATE];
        return {
          allDayRecordsLoaded: false,
          dayRecordsByDate: nextByDate,
        };
      });
      const deferredRead = persistence.deferNextAuthoritativeRead();
      const staleWindowLoad = storeModule.useHabitStore
        .getState()
        .preloadDayRecords(TEST_DATE);
      await waitForRead(deferredRead.entered, "stale date-window read");
      storeModule.useHabitStore.setState({ allDayRecordsLoaded: true });

      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "maximum"),
        true,
        "the first same-key intent must persist",
      );
      persistence.failNextMark();
      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "failure"),
        false,
        "the newer rejected intent must be repaired from persisted state",
      );

      deferredRead.release();
      const staleWindowResult = await staleWindowLoad;
      const expected = new Map([[firstHabit.id, "maximum" as const]]);
      assertVisibleOwners(storeModule, expected);
      assert.equal(
        staleWindowResult,
        true,
        "snapshot invalidation must transparently retry the date-window read",
      );
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "a foreground date load survives record-read invalidation",
    async run() {
      const firstHabit = habit(1, "Check supplies");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(108, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      storeModule.useHabitStore.setState({
        allDayRecordsLoaded: false,
        currentDayRecordsDate: null,
        dayRecords: [],
        dayRecordsByDate: {},
      });
      const deferredRead = persistence.deferNextAuthoritativeRead();
      const foregroundLoad = storeModule.useHabitStore
        .getState()
        .loadDayRecords(TEST_DATE);
      await waitForRead(deferredRead.entered, "foreground date load");

      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "maximum"),
        true,
        "the overlapping day intent must persist",
      );
      deferredRead.release();
      assert.equal(
        await foregroundLoad,
        true,
        "record invalidation must not cancel the foreground date owner",
      );

      const state = storeModule.useHabitStore.getState();
      assert.equal(state.currentDayRecordsDate, TEST_DATE);
      assert.equal(
        statusFor(state.allDayRecords, firstHabit.id),
        "maximum",
        "the complete in-memory history must retain the newer intent",
      );
      assert.equal(
        statusFor(state.dayRecordsByDate[TEST_DATE], firstHabit.id),
        "maximum",
        "the foreground date cache must publish the newer intent",
      );
      assert.equal(
        statusFor(state.dayRecords, firstHabit.id),
        "maximum",
        "the foreground current-date slice must publish the newer intent",
      );
    },
  },
  {
    name: "a stale history read cannot resurrect a successfully unmarked record",
    async run() {
      const firstHabit = habit(1, "Prepare workspace");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(109, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      const deferredRead = persistence.deferNextAuthoritativeRead();
      const staleHistoryLoad = storeModule.useHabitStore
        .getState()
        .loadAllDayRecords();
      await waitForRead(deferredRead.entered, "successful unmark history read");

      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .unmarkDay(firstHabit.id, TEST_DATE),
        true,
        "the unmark must persist while an older history read is pending",
      );
      deferredRead.release();
      assert.equal(
        await staleHistoryLoad,
        true,
        "the stale history owner must retry after a successful unmark",
      );

      const expected = new Map([[firstHabit.id, null]]);
      assertVisibleOwners(storeModule, expected);
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "a stale history read cannot resurrect a schedule-pruned record",
    async run() {
      const firstHabit = habit(1, "Review calendar");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(109, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      const deferredRead = persistence.deferNextAuthoritativeRead();
      const staleHistoryLoad = storeModule.useHabitStore
        .getState()
        .loadAllDayRecords();
      await waitForRead(deferredRead.entered, "schedule-prune history read");
      const currentDayOfMonth = Number(TEST_DATE.slice(8, 10));
      const excludedDayOfMonth = currentDayOfMonth === 1 ? 2 : 1;

      await storeModule.useHabitStore.getState().updateHabit(firstHabit.id, {
        repeatSchedule: {
          type: "monthly",
          dates: [excludedDayOfMonth],
        },
      });
      assert.equal(
        persistence
          .snapshotRecords()
          .some((candidate) => candidate.habitId === firstHabit.id),
        false,
        "the schedule transaction must durably prune the incompatible record",
      );
      deferredRead.release();
      assert.equal(
        await staleHistoryLoad,
        true,
        "the stale history owner must retry after schedule pruning",
      );

      const state = storeModule.useHabitStore.getState();
      assert.equal(
        statusFor(state.allDayRecords, firstHabit.id),
        null,
        "full history must not resurrect the schedule-pruned record",
      );
      assert.equal(
        statusFor(state.dayRecordsByDate[TEST_DATE], firstHabit.id),
        null,
        "the hot date cache must not resurrect the schedule-pruned record",
      );
      assert.equal(
        statusFor(state.dayRecords, firstHabit.id),
        null,
        "the current date slice must not resurrect the schedule-pruned record",
      );
      await assertModuleDateCache(
        storeModule,
        new Map([[firstHabit.id, null]]),
      );
    },
  },
  {
    name: "a stale history read cannot overwrite schedule recovery",
    async run() {
      const firstHabit = habit(1, "Check milestones");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(110, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      const deferredRead = persistence.deferNextAuthoritativeRead();
      const staleHistoryLoad = storeModule.useHabitStore
        .getState()
        .loadAllDayRecords();
      await waitForRead(deferredRead.entered, "schedule recovery history read");
      persistence.replaceDataset(dataset([firstHabit], []));
      persistence.failNextScheduleEdit();

      const currentDayOfMonth = Number(TEST_DATE.slice(8, 10));
      const excludedDayOfMonth = currentDayOfMonth === 1 ? 2 : 1;
      await assert.rejects(
        storeModule.useHabitStore.getState().updateHabit(firstHabit.id, {
          repeatSchedule: {
            type: "monthly",
            dates: [excludedDayOfMonth],
          },
        }),
        /Injected schedule persistence failure/,
      );
      assert.equal(
        statusFor(
          storeModule.useHabitStore.getState().allDayRecords,
          firstHabit.id,
        ),
        null,
        "schedule recovery must publish the authoritative empty history",
      );

      deferredRead.release();
      assert.equal(
        await staleHistoryLoad,
        true,
        "the stale history owner must retry after schedule recovery",
      );
      const state = storeModule.useHabitStore.getState();
      assert.equal(
        statusFor(state.allDayRecords, firstHabit.id),
        null,
        "full history must not overwrite schedule recovery",
      );
      assert.equal(
        statusFor(state.dayRecordsByDate[TEST_DATE], firstHabit.id),
        null,
        "the hot date cache must not overwrite schedule recovery",
      );
      assert.equal(
        statusFor(state.dayRecords, firstHabit.id),
        null,
        "the current date slice must not overwrite schedule recovery",
      );
      await assertModuleDateCache(
        storeModule,
        new Map([[firstHabit.id, null]]),
      );
    },
  },
  {
    name: "a second storage failure revokes readiness until an authoritative retry",
    async run() {
      const firstHabit = habit(1, "Review vocabulary");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(111, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextMark();
      persistence.failNextAuthoritativeRead();

      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "failure"),
        false,
        "the owned write failure must remain a failed action",
      );
      let state = storeModule.useHabitStore.getState();
      assert.equal(
        state.allDayRecordsLoaded,
        false,
        "an unreadable authoritative state must revoke history readiness",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          state.dayRecordsByDate,
          TEST_DATE,
        ),
        false,
        "an unreadable date must be evicted from the hot cache",
      );
      assert.equal(
        statusFor(state.allDayRecords, firstHabit.id),
        null,
        "the rejected optimistic status must leave the incomplete history",
      );
      assert.equal(
        statusFor(state.dayRecords, firstHabit.id),
        null,
        "the rejected optimistic status must leave the current date slice",
      );
      assert.match(
        state.error ?? "",
        /Injected mark persistence failure/,
        "the original user action failure must remain visible",
      );

      assert.equal(
        await state.loadAllDayRecords(),
        true,
        "a later authoritative history retry must be allowed",
      );
      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .preloadDayRecords(TEST_DATE),
        true,
        "a later date preload must be allowed",
      );
      assert.equal(
        await storeModule.useHabitStore.getState().loadDayRecords(TEST_DATE),
        true,
        "a later authoritative date retry must be allowed",
      );
      state = storeModule.useHabitStore.getState();
      assert.equal(state.allDayRecordsLoaded, true);
      const expected = new Map([[firstHabit.id, "done" as const]]);
      assertVisibleOwners(storeModule, expected);
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "a late second-read failure cannot invalidate a newer same-key intent",
    async run() {
      const firstHabit = habit(1, "Write a summary");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(112, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextMark();
      persistence.failNextAuthoritativeRead();
      const deferredRead = persistence.deferNextAuthoritativeRead();

      const rejected = storeModule.useHabitStore
        .getState()
        .markDay(firstHabit.id, TEST_DATE, "failure");
      await waitForRead(deferredRead.entered, "second-read failure");
      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "maximum"),
        true,
        "the newer same-key intent must persist",
      );
      deferredRead.release();
      assert.equal(
        await rejected,
        true,
        "the stale double failure must be superseded",
      );

      const state = storeModule.useHabitStore.getState();
      assert.equal(
        state.allDayRecordsLoaded,
        true,
        "a stale repair failure must not revoke newer loaded state",
      );
      assert.equal(
        state.error,
        null,
        "a stale repair failure must not publish a global error",
      );
      const expected = new Map([[firstHabit.id, "maximum" as const]]);
      assertVisibleOwners(storeModule, expected);
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "a read started during superseded repair cannot overwrite its newer intent",
    async run() {
      const firstHabit = habit(1, "Outline a lesson");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(113, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextMark();
      const repairRead = persistence.deferNextAuthoritativeRead();

      const rejected = storeModule.useHabitStore
        .getState()
        .markDay(firstHabit.id, TEST_DATE, "failure");
      await waitForRead(repairRead.entered, "superseded repair read");
      const staleHistoryRead = persistence.deferNextAuthoritativeRead();
      const staleHistoryLoad = storeModule.useHabitStore
        .getState()
        .loadAllDayRecords();
      await waitForRead(
        staleHistoryRead.entered,
        "read started during superseded repair",
      );
      assert.equal(
        await storeModule.useHabitStore
          .getState()
          .markDay(firstHabit.id, TEST_DATE, "maximum"),
        true,
        "the newer same-key intent must persist",
      );

      repairRead.release();
      assert.equal(
        await rejected,
        true,
        "the older repair must be superseded",
      );
      staleHistoryRead.release();
      const staleHistoryResult = await staleHistoryLoad;
      const expected = new Map([[firstHabit.id, "maximum" as const]]);
      assertVisibleOwners(storeModule, expected);
      assert.equal(
        staleHistoryResult,
        true,
        "the read opened during repair must retry after the newer intent",
      );
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "repair remains valid when the habit is archived during its read",
    async run() {
      const firstHabit = habit(1, "Organize notes");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(114, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextMark();
      const deferredRead = persistence.deferNextAuthoritativeRead();

      const rejected = storeModule.useHabitStore
        .getState()
        .markDay(firstHabit.id, TEST_DATE, "failure");
      await waitForRead(deferredRead.entered, "archive-during-repair");
      await storeModule.useHabitStore.getState().archiveHabit(firstHabit.id);
      deferredRead.release();
      assert.equal(
        await rejected,
        false,
        "archiving must not erase the owned write failure",
      );

      const state = storeModule.useHabitStore.getState();
      assert.equal(
        state.habits.some((candidate) => candidate.id === firstHabit.id),
        false,
        "the archived habit must leave the active collection",
      );
      assert.equal(
        state.allHabits.find((candidate) => candidate.id === firstHabit.id)
          ?.isArchived,
        true,
        "the archived habit must remain in the complete collection",
      );
      const expected = new Map([[firstHabit.id, "done" as const]]);
      assert.equal(
        statusFor(state.allDayRecords, firstHabit.id),
        "done",
        "archive history must retain the repaired record",
      );
      assert.equal(
        statusFor(state.dayRecordsByDate[TEST_DATE], firstHabit.id),
        "done",
        "the hot date cache must retain the repaired archived record",
      );
      assert.equal(
        statusFor(state.dayRecords, firstHabit.id),
        "done",
        "the current date slice must retain the repaired archived record",
      );
      await assertModuleDateCache(storeModule, expected);
    },
  },
  {
    name: "repair captured before deletion cannot resurrect a deleted habit record",
    async run() {
      const firstHabit = habit(1, "Evening review");
      const { storeModule, persistence } = load(
        dataset([firstHabit], [record(115, firstHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextUnmark();
      const deferredRead = persistence.deferNextAuthoritativeRead();

      const rejected = storeModule.useHabitStore
        .getState()
        .unmarkDay(firstHabit.id, TEST_DATE);
      await waitForRead(deferredRead.entered, "delete-during-repair");
      await storeModule.useHabitStore.getState().deleteHabits([firstHabit.id]);
      deferredRead.release();
      const rejectedResult = await rejected;

      const state = storeModule.useHabitStore.getState();
      assert.equal(
        state.habits.some((candidate) => candidate.id === firstHabit.id),
        false,
        "the deleted habit must stay absent from active habits",
      );
      assert.equal(
        state.allHabits.some((candidate) => candidate.id === firstHabit.id),
        false,
        "the deleted habit must stay absent from all habits",
      );
      assert.equal(
        state.allDayRecords.some(
          (candidate) => candidate.habitId === firstHabit.id,
        ),
        false,
        "a stale repair must not resurrect the deleted habit record",
      );
      assert.equal(
        state.dayRecordsByDate[TEST_DATE]?.some(
          (candidate) => candidate.habitId === firstHabit.id,
        ) ?? false,
        false,
        "the hot date cache must not resurrect the deleted habit record",
      );
      assert.equal(
        state.dayRecords.some(
          (candidate) => candidate.habitId === firstHabit.id,
        ),
        false,
        "the current date slice must not resurrect the deleted habit record",
      );
      const snapshot = state.getDayListSnapshot(TEST_DATE, false);
      assert.equal(
        [...snapshot.activeItems, ...snapshot.completedItems].some(
          (candidate) => candidate.habit.id === firstHabit.id,
        ),
        false,
        "the Home snapshot must not resurrect the deleted habit",
      );
      assert.equal(
        state.error,
        null,
        "the superseded day failure must not publish an error after deletion",
      );
      assert.equal(
        rejectedResult,
        true,
        "a durable deletion must supersede the failed day action",
      );
      await assertModuleDateCache(
        storeModule,
        new Map([[firstHabit.id, null]]),
      );
    },
  },
  {
    name: "repair started before reset cannot repopulate the replacement dataset",
    async run() {
      const oldHabit = habit(1, "Old dataset habit");
      const replacementHabit = habit(2, "Replacement dataset habit");
      const { storeModule, persistence } = load(
        dataset([oldHabit], [record(116, oldHabit.id, "done")]),
      );
      await hydrateStore(storeModule);
      persistence.failNextMark();
      const deferredRead = persistence.deferNextAuthoritativeRead();

      const rejected = storeModule.useHabitStore
        .getState()
        .markDay(oldHabit.id, TEST_DATE, "failure");
      await waitForRead(deferredRead.entered, "reset repair");

      persistence.replaceDataset(
        dataset(
          [replacementHabit],
          [record(117, replacementHabit.id, "maximum")],
        ),
      );
      storeModule.useHabitStore.getState().resetInMemoryCaches();
      await hydrateStore(storeModule, true);
      deferredRead.release();
      assert.equal(
        await rejected,
        true,
        "a reset must supersede the old failed action",
      );

      const state = storeModule.useHabitStore.getState();
      assert.deepEqual(
        state.habits.map((candidate) => candidate.id),
        [replacementHabit.id],
        "reset must keep only the replacement dataset",
      );
      assert.equal(
        state.allDayRecords.some((candidate) => candidate.habitId === oldHabit.id),
        false,
        "the late repair must not resurrect an old habit record",
      );
      assert.equal(
        state.error,
        null,
        "the late repair must not republish an error from the old dataset",
      );
      const expected = new Map([[replacementHabit.id, "maximum" as const]]);
      assertVisibleOwners(storeModule, expected);
      await assertModuleDateCache(storeModule, expected);
    },
  },
];

async function main(): Promise<void> {
  const failures: { name: string; error: unknown }[] = [];
  for (const scenario of scenarios) {
    try {
      await runScenarioWithTimeout(scenario);
      console.log(`ok - ${scenario.name}`);
    } catch (error) {
      failures.push({ name: scenario.name, error });
      console.error(`not ok - ${scenario.name}`);
      console.error(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `${failures.length} habit day rollback scenario(s) failed`,
    );
  }

  console.log("Habit day rollback audit passed.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
