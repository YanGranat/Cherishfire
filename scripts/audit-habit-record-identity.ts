import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DayRecord, Habit } from "../src/types/habit";
import {
  capturePendingHabitWriteFence,
  releasePendingHabitWriteFence,
  waitForPendingHabitWritesThrough,
} from "../src/application/habits/habit-write-fence";
import { loadHabitStoreForAudit } from "./fixtures/load-habit-store-for-audit";

const date = "2002-05-14";
const sourcePath = resolve("src/stores/habit-store.ts");
const mutation = process.argv.find(argument => argument.startsWith("--mutation="))?.slice(11);
const knownMutations = new Set([
  "ack-sql-id", "ack-created-at", "ack-updated-at", "ack-ownership",
  "prune-negative-id", "restore-noop-publication", "restore-noop-invalidation",
  "restore-superseded-error",
]);
assert.ok(!mutation || knownMutations.has(mutation), "the selected mutation must be known");

function replaceOnce(source: string, target: string, replacement: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  target = target.replace(/\r?\n/g, newline);
  replacement = replacement.replace(/\r?\n/g, newline);
  assert.equal(source.split(target).length - 1, 1, "the mutation target must be unique");
  return source.replace(target, replacement);
}

function transformStore(source: string): string {
  if (mutation === "ack-sql-id") return replaceOnce(source,
    "const optimisticMatchesPersisted =\n        optimisticRecord.habitId",
    "const optimisticMatchesPersisted =\n        optimisticRecord.id === persisted.id &&\n        optimisticRecord.habitId");
  if (mutation === "ack-created-at") return replaceOnce(source,
    "        optimisticRecord.createdAt === persisted.createdAt &&\n", "");
  if (mutation === "ack-updated-at") return replaceOnce(source,
    " &&\n        optimisticRecord.updatedAt === persisted.updatedAt;", ";");
  if (mutation === "ack-ownership") return replaceOnce(source,
    "      if (!isLatestDayMutation(overlayKey, mutationId)) return true;\n      const currentHabit = get().habits.find(",
    "      const currentHabit = get().habits.find(");
  if (mutation === "prune-negative-id") return replaceOnce(source,
    "record.habitId !== id || !removedDates.has(record.date);",
    "record.id < 0 || record.habitId !== id || !removedDates.has(record.date);");
  if (mutation === "restore-noop-publication") return replaceOnce(source,
    "        if (habits === state.habits && allHabits === state.allHabits) {\n          return state;\n        }\n", "");
  if (mutation === "restore-noop-invalidation") return replaceOnce(source,
    "      let confirmedActiveHabits = get().habits;\n      set((state) => {",
    "      let confirmedActiveHabits = get().habits;\n      invalidateViewModelCachesForChange(\"lifecycle\");\n      set((state) => {");
  if (mutation === "restore-superseded-error") return replaceOnce(source,
    "        if (!publishedError) return state;\n", "");
  return source;
}

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 1, name: "Practice", description: null, descriptionVisible: false,
    repeatSchedule: { type: "daily" }, startDate: "2001-01-01",
    reminderEnabled: false, reminderTime: null, displayOrder: 0,
    isArchived: false, archivedAt: null, archiveHistory: [], createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function load(initialHabit = habit(), records: readonly DayRecord[] = []) {
  return loadHabitStoreForAudit({ habits: [initialHabit], records }, { transform: transformStore });
}

type Loaded = ReturnType<typeof load>;
async function hydrate(loaded: Loaded, committedImport = false): Promise<void> {
  const store = loaded.storeModule.useHabitStore;
  assert.equal(await store.getState().loadHabits(committedImport ? { mode: "committed-import" } : undefined), true);
  assert.equal(await store.getState().loadAllDayRecords(), true);
  assert.equal(await store.getState().loadDayRecords(date), true);
  store.getState().getDayListSnapshot(date, true);
}

function presentation(loaded: Loaded) {
  const state = loaded.storeModule.useHabitStore.getState();
  return {
    all: state.allDayRecords,
    byDate: state.dayRecordsByDate,
    day: state.dayRecords,
    habitRecords: loaded.storeModule.getHabitDayRecordsForState(state, 1),
    snapshot: state.getDayListSnapshot(date, true),
  };
}

function assertSamePresentation(actual: ReturnType<typeof presentation>, expected: ReturnType<typeof presentation>) {
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.equal(actual[key], expected[key], `an acknowledgement must preserve ${key} identity`);
  }
}

async function equalAcknowledgement(): Promise<void> {
  const loaded = load();
  await hydrate(loaded);
  const store = loaded.storeModule.useHabitStore;
  const originalMark = loaded.persistence.application.markDay;
  const calls: Parameters<typeof originalMark>[0][] = [];
  loaded.persistence.application.markDay = input => {
    calls.push(input);
    return originalMark(input);
  };
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const write = store.getState().markDay(1, date, "failure", "  Draft  ");
  const accepted = presentation(loaded);
  const optimistic = accepted.all[0];
  assert.ok(optimistic.id < 0);
  assert.equal(await write, true);
  assert.equal(notifications, 1, "equal persistence payload must publish exactly one optimistic state");
  assertSamePresentation(presentation(loaded), accepted);
  assert.equal(calls.length, 1, "acknowledgement must not repeat a reason-note persistence command");
  assert.equal(calls[0].reason, "Draft");
  assert.ok(loaded.persistence.snapshotRecords()[0].id > 0, "durable rows must retain their SQL identity");
  assert.equal(store.getState().allDayRecords[0], optimistic);

  notifications = 0;
  const update = store.getState().markDay(1, date, "maximum");
  const second = presentation(loaded);
  assert.equal(await update, true);
  assert.equal(notifications, 1, "a later update must retain the existing logical record identity");
  assertSamePresentation(presentation(loaded), second);
  unsubscribe();
}

async function changedPayload(field: "createdAt" | "updatedAt"): Promise<void> {
  const loaded = load();
  await hydrate(loaded);
  const originalMark = loaded.persistence.application.markDay;
  loaded.persistence.application.markDay = async input => {
    const persisted = await originalMark(input);
    const changed = { ...persisted, [field]: persisted[field] + 1 };
    loaded.persistence.replaceDataset({ habits: [habit()], records: [changed] });
    return changed;
  };
  const store = loaded.storeModule.useHabitStore;
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const write = store.getState().markDay(1, date, "done");
  const accepted = store.getState().allDayRecords[0];
  const acceptedTimestamp = accepted[field];
  assert.equal(await write, true);
  assert.equal(notifications, 2, `${field} changes require an authoritative publication`);
  assert.equal(store.getState().allDayRecords[0][field], acceptedTimestamp + 1);
  assert.equal(accepted[field], acceptedTimestamp, "accepted records must remain immutable");
  unsubscribe();
}

async function staleAcknowledgement(): Promise<void> {
  const loaded = load();
  await hydrate(loaded);
  const originalMark = loaded.persistence.application.markDay;
  const entered = deferred<void>();
  const acknowledgement = deferred<void>();
  loaded.persistence.application.markDay = async input => {
    const persisted = await originalMark(input);
    if (input.status === "done") {
      const authoritative = { ...persisted, createdAt: persisted.createdAt + 1 };
      loaded.persistence.replaceDataset({ habits: [habit()], records: [authoritative] });
      entered.resolve();
      await acknowledgement.promise;
      return authoritative;
    }
    return persisted;
  };
  const store = loaded.storeModule.useHabitStore;
  const first = store.getState().markDay(1, date, "done");
  await entered.promise;
  assert.equal(await store.getState().markDay(1, date, "maximum"), true);
  const latest = presentation(loaded);
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  acknowledgement.resolve();
  assert.equal(await first, true);
  assert.equal(notifications, 0, "an older acknowledgement must not publish over a newer intent");
  assertSamePresentation(presentation(loaded), latest);
  assert.equal(store.getState().allDayRecords[0].status, "maximum");
  assert.equal(loaded.persistence.snapshotRecords()[0].status, "maximum");
  unsubscribe();
}

async function acknowledgementDuringNewerWrite(): Promise<void> {
  const loaded = load();
  await hydrate(loaded);
  const store = loaded.storeModule.useHabitStore;
  const originalMark = loaded.persistence.application.markDay;
  const firstEntered = deferred<void>();
  const newerEntered = deferred<void>();
  const firstAcknowledgement = deferred<void>();
  const newerPersistence = deferred<void>();
  loaded.persistence.application.markDay = async input => {
    if (input.status === "maximum") {
      newerEntered.resolve();
      await newerPersistence.promise;
      return originalMark(input);
    }
    const persisted = await originalMark(input);
    firstEntered.resolve();
    await firstAcknowledgement.promise;
    return persisted;
  };
  const first = store.getState().markDay(1, date, "done");
  await firstEntered.promise;
  const newer = store.getState().markDay(1, date, "maximum");
  await newerEntered.promise;
  firstAcknowledgement.resolve();
  await first;
  assert.equal(await store.getState().loadAllDayRecords(), true);
  assert.equal(store.getState().allDayRecords[0].status, "maximum",
    "an older acknowledgement must preserve the newer pending overlay during authoritative reads");
  newerPersistence.resolve();
  assert.equal(await newer, true);
  assert.equal(store.getState().allDayRecords[0].status, "maximum");
}

async function schedulePruning(): Promise<void> {
  const loaded = load();
  await hydrate(loaded);
  const store = loaded.storeModule.useHabitStore;
  assert.equal(await store.getState().markDay(1, date, "done"), true);
  assert.ok(store.getState().allDayRecords[0].id < 0);
  const schedule = store.getState().updateHabit(1, { startDate: "2003-01-01" });
  assert.equal(store.getState().allDayRecords.length, 0,
    "logical pruning must include optimistic identities in its first projection");
  await schedule;
  assert.equal(loaded.persistence.snapshotRecords().length, 0);
  assert.equal(store.getState().allDayRecords.length, 0, "schedule pruning must use the logical record key");
  assert.equal(store.getState().dayRecordsByDate[date]?.length ?? 0, 0);
  assert.equal(store.getState().dayRecords.length, 0);
}

async function emptyDateIdentity(): Promise<void> {
  const loaded = load();
  await hydrate(loaded);
  const store = loaded.storeModule.useHabitStore;
  const empty = store.getState().dayRecords;
  assert.equal(await store.getState().preloadDayRecordsWindow(date, 1), true);
  for (const records of Object.values(store.getState().dayRecordsByDate)) {
    assert.equal(records, empty, "empty dates must share the existing immutable empty projection");
  }
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  assert.equal(await store.getState().loadDayRecords(date), true);
  assert.equal(notifications, 0, "an already-current empty date must not publish another projection");
  assert.equal(await store.getState().markDay(1, date, "done"), true);
  assert.equal(empty.length, 0, "day mutations must not mutate a shared empty projection");
  unsubscribe();
}

async function transferFence(discard: boolean): Promise<void> {
  const loaded = load();
  await hydrate(loaded);
  const store = loaded.storeModule.useHabitStore;
  assert.equal(await store.getState().markDay(1, date, "done"), true);
  const fence = capturePendingHabitWriteFence();
  try {
    const beforeCutoff = loaded.persistence.snapshotRecords();
    const afterCutoff = store.getState().markDay(1, date, "maximum");
    await waitForPendingHabitWritesThrough(fence);
    assert.deepEqual(loaded.persistence.snapshotRecords(), beforeCutoff,
      "a post-cutoff optimistic intent must not change the durable snapshot");
    const accepted = presentation(loaded);
    if (discard) {
      loaded.persistence.replaceDataset({ habits: [habit()], records: [] });
      store.getState().resetInMemoryCaches();
      await hydrate(loaded, true);
    }
    releasePendingHabitWriteFence(fence, { discardPostFence: discard });
    assert.equal(await afterCutoff, !discard);
    if (discard) {
      assert.equal(store.getState().allDayRecords.length, 0);
      assert.equal(loaded.persistence.snapshotRecords().length, 0,
        "committed import must discard the post-cutoff write");
    } else {
      assertSamePresentation(presentation(loaded), accepted);
      assert.equal(loaded.persistence.snapshotRecords()[0].status, "maximum");
      assert.ok(loaded.persistence.snapshotRecords()[0].id > 0);
    }
  } finally {
    releasePendingHabitWriteFence(fence);
  }
}

function archivedHabit(): Habit {
  return habit({ isArchived: true, archivedAt: 1_000,
    archiveHistory: [{ archivedAt: 1_000, restoredAt: null, archivedDate: "2001-01-01", restoredDate: null }] });
}

async function restoreAcknowledgement(changeMetadata: boolean): Promise<void> {
  const loaded = load(archivedHabit());
  await hydrate(loaded);
  const store = loaded.storeModule.useHabitStore;
  loaded.persistence.application.restoreHabits = async ids => {
    const accepted = store.getState().allHabits[0];
    const actual = { ...accepted, updatedAt: accepted.updatedAt + (changeMetadata ? 1 : 0) };
    loaded.persistence.replaceDataset({ habits: [actual], records: [] });
    return new Map(ids.map(id => [id, actual]));
  };
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  const restore = store.getState().restoreHabits([1]);
  const acceptedHabits = store.getState().habits;
  const acceptedSnapshot = presentation(loaded).snapshot;
  await restore;
  assert.equal(store.getState().habits[0].isArchived, false);
  assert.equal(notifications, changeMetadata ? 2 : 1,
    "restore acknowledgement must publish only changed authoritative collections");
  if (!changeMetadata) {
    assert.equal(store.getState().habits, acceptedHabits);
    assert.equal(presentation(loaded).snapshot, acceptedSnapshot,
      "equal restore acknowledgement must retain derived caches");
  }
  unsubscribe();
}

async function supersededRestore(reject: boolean): Promise<void> {
  const loaded = load(archivedHabit());
  await hydrate(loaded);
  const store = loaded.storeModule.useHabitStore;
  const entered = deferred<void>();
  const acknowledgement = deferred<Map<number, Habit>>();
  loaded.persistence.application.restoreHabits = async () => {
    const accepted = { ...store.getState().allHabits[0] };
    loaded.persistence.replaceDataset({ habits: [accepted], records: [] });
    entered.resolve();
    return acknowledgement.promise;
  };
  const restore = store.getState().restoreHabits([1]);
  const outcome = restore.then(() => null, error => error as Error);
  await entered.promise;
  await store.getState().archiveHabit(1);
  const latest = store.getState();
  const latestSnapshot = presentation(loaded).snapshot;
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  if (reject) acknowledgement.reject(new Error("Restore rejected"));
  else acknowledgement.resolve(new Map([[1, habit()]]));
  const failure = await outcome;
  assert.equal(failure?.message ?? null, reject ? "Restore rejected" : null);
  assert.equal(notifications, 0, "a fully superseded restore must not publish state or an error");
  assert.equal(store.getState().habits, latest.habits);
  assert.equal(store.getState().allHabits, latest.allHabits);
  assert.equal(presentation(loaded).snapshot, latestSnapshot,
    "a fully superseded restore must not invalidate derived caches");
  assert.equal(store.getState().error, null);
  unsubscribe();
}

async function restoreFailure(): Promise<void> {
  const loaded = load(archivedHabit());
  await hydrate(loaded);
  loaded.persistence.application.restoreHabits = async () => { throw new Error("Restore rejected"); };
  const store = loaded.storeModule.useHabitStore;
  await assert.rejects(store.getState().restoreHabits([1]), /Restore rejected/);
  assert.equal(store.getState().habits.length, 0, "an owned restore failure must roll back the active collection");
  assert.equal(store.getState().allHabits[0].isArchived, true);
  assert.equal(store.getState().error, "Restore rejected", "an owned restore failure must remain visible");
}

async function run(): Promise<void> {
  assert.ok(readFileSync(sourcePath, "utf8").includes("const optimisticMatchesPersisted"));
  await equalAcknowledgement();
  await changedPayload("createdAt");
  await changedPayload("updatedAt");
  await staleAcknowledgement();
  await acknowledgementDuringNewerWrite();
  await schedulePruning();
  await emptyDateIdentity();
  await transferFence(false);
  await transferFence(true);
  await restoreAcknowledgement(false);
  await restoreAcknowledgement(true);
  await supersededRestore(false);
  await supersededRestore(true);
  await restoreFailure();
}

const timeout = setTimeout(() => { throw new Error("Habit record identity audit did not settle"); }, 10_000);
void run().then(() => {
  console.log("Habit record identity audit passed: immutable acknowledgements, logical pruning, transfer fences and lifecycle no-ops.");
}, error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => { clearTimeout(timeout); });
