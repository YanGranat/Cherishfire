import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { drizzle } from "drizzle-orm/expo-sqlite/driver";
import { migrate } from "drizzle-orm/expo-sqlite/migrator";

import {
  createHabitPersistenceApplication,
  StaleHabitScheduleMutationError,
  type HabitPatch,
  type HabitPersistenceRepository,
  type HabitPersistenceSession,
  type NewPersistedHabit,
  type PersistedReasonNote,
} from "../src/application/habits/habit-persistence";
import {
  capturePendingHabitWriteFence,
  captureHabitScheduleWriteBarrier,
  getCurrentHabitWriteSequence,
  isHabitWriteProtectedByFence,
  releasePendingHabitWriteFence,
  waitForHabitPersistenceTurn,
  waitForPendingHabitWritesThrough,
  withPendingHabitWriteTracking,
} from "../src/application/habits/habit-write-fence";
import {
  partitionMixedHabitUpdateInput,
  selectPersistableHabitUpdatePatch,
} from "../src/application/habits/habit-update-patch";
import {
  FIXED_NOW_MS,
  FIXED_TODAY,
  HABIT_PERSISTENCE_EQUIVALENCE_FIXTURES,
  createHabitFixture,
} from "./fixtures/habit-persistence-equivalence-fixtures";
import type { DayRecord, Habit } from "../src/types/habit";
import { areRepeatSchedulesEqual } from "../src/types/habit";
import { calculateStreakStats } from "../src/domain/habits/streak";
import {
  SQLITE_DELETE_BIND_CHUNK_SIZE,
  deleteSqliteRowsByValues,
} from "../src/data/sqlite/chunked-delete";
import {
  HABIT_DISPLAY_ORDER_UPDATE_CHUNK_SIZE,
  patchHabitDisplayOrders,
} from "../src/data/sqlite/bulk-display-order-update";
import {
  assignDisplayOrdersAroundArchivedSlots,
  reconcileDisplayOrderRows,
} from "../src/domain/habits/display-order";
import type { AsyncDatabaseExecutor } from "../src/db/runtime";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import { loadSqliteRepositoriesForAudit } from "./fixtures/load-sqlite-repositories-for-audit";
import { loadHabitStoreForAudit } from "./fixtures/load-habit-store-for-audit";
import {
  buildExportJsonFromRows,
  normalizeImportData,
  verifyRestoredImportRows,
} from "../src/application/data-transfer/data-transfer-codec";
import type { DataTransferRows, NormalizedImportData } from "../src/application/data-transfer/data-transfer-model";

function cloneHabit(habit: Habit): Habit {
  return structuredClone(habit);
}

function applyPatch(habit: Habit, patch: HabitPatch): Habit {
  const { schedule, ...fields } = patch;
  return {
    ...habit,
    ...fields,
    ...(schedule
      ? {
          repeatSchedule: structuredClone(schedule.repeatSchedule),
          scheduleHistory: structuredClone(schedule.scheduleHistory),
          startDate: schedule.startDate,
        }
      : null),
  };
}

class FakeHabitRepository implements HabitPersistenceRepository {
  habits = new Map<number, Habit>();
  records: DayRecord[] = [];
  reasonNotes: PersistedReasonNote[] = [];
  settings = new Set<string>();
  operations: string[] = [];
  nextHabitId = 100;
  nextRecordId = 1000;

  constructor(habits: readonly Habit[] = [], records: readonly DayRecord[] = []) {
    for (const habit of habits) this.habits.set(habit.id, cloneHabit(habit));
    this.records = records.map((record) => ({ ...record }));
  }

  private snapshot() {
    return {
      habits: structuredClone([...this.habits.entries()]),
      records: structuredClone(this.records),
      reasonNotes: structuredClone(this.reasonNotes),
      settings: [...this.settings],
    };
  }

  private restore(snapshot: ReturnType<FakeHabitRepository["snapshot"]>) {
    this.habits = new Map(snapshot.habits);
    this.records = snapshot.records;
    this.reasonNotes = snapshot.reasonNotes;
    this.settings = new Set(snapshot.settings);
  }

  async transaction<T>(
    task: (session: HabitPersistenceSession) => Promise<T>,
  ): Promise<T> {
    this.operations.push("transaction.begin");
    const snapshot = this.snapshot();
    try {
      const result = await task(this);
      this.operations.push("transaction.commit");
      return result;
    } catch (error) {
      this.restore(snapshot);
      this.operations.push("transaction.rollback");
      throw error;
    }
  }

  async readAllHabits(): Promise<Habit[]> {
    this.operations.push("readAllHabits");
    return [...this.habits.values()].map(cloneHabit);
  }

  async readHabit(habitId: number): Promise<Habit | null> {
    this.operations.push(`readHabit:${habitId}`);
    const habit = this.habits.get(habitId);
    return habit ? cloneHabit(habit) : null;
  }

  async readDayRecordsForHabitOrderedByDate(
    habitId: number,
  ): Promise<DayRecord[]> {
    this.operations.push(`readRecordsOrdered:${habitId}`);
    return this.records
      .filter((record) => record.habitId === habitId)
      .sort((left, right) => left.date.localeCompare(right.date))
      .map((record) => ({ ...record }));
  }

  async readDayRecordsForHabit(habitId: number): Promise<DayRecord[]> {
    this.operations.push(`readRecords:${habitId}`);
    return this.records
      .filter((record) => record.habitId === habitId)
      .map((record) => ({ ...record }));
  }

  async readAllDayRecords(): Promise<DayRecord[]> {
    this.operations.push("readAllRecords");
    return structuredClone(this.records);
  }

  async readDayRecordsInDateRange(
    startDate: string,
    endDate: string,
  ): Promise<DayRecord[]> {
    this.operations.push(`readRange:${startDate}:${endDate}`);
    return this.records
      .filter((record) => record.date >= startDate && record.date <= endDate)
      .map((record) => ({ ...record }));
  }

  async readArchivedDisplayOrders() {
    this.operations.push("readArchivedDisplayOrders");
    return [...this.habits.values()]
      .filter((habit) => habit.isArchived)
      .map(({ id, displayOrder }) => ({ id, displayOrder }));
  }

  async readMaxDisplayOrder(): Promise<number | null> {
    this.operations.push("readMaxDisplayOrder");
    const orders = [...this.habits.values()].map((habit) => habit.displayOrder);
    return orders.length > 0 ? Math.max(...orders) : null;
  }

  async insertHabit(habit: NewPersistedHabit): Promise<Habit> {
    this.operations.push("insertHabit");
    const persisted = { ...structuredClone(habit), id: this.nextHabitId++ };
    this.habits.set(persisted.id, persisted);
    return cloneHabit(persisted);
  }

  async patchHabit(habitId: number, patch: HabitPatch): Promise<void> {
    this.operations.push(`patchHabit:${habitId}`);
    const habit = this.habits.get(habitId);
    if (habit) this.habits.set(habitId, applyPatch(habit, patch));
  }

  async patchHabitDisplayOrders(
    assignments: readonly { id: number; displayOrder: number }[],
  ): Promise<void> {
    this.operations.push(
      `patchHabitDisplayOrders:${assignments.map(({ id }) => id).join(",")}`,
    );
    for (const { id, displayOrder } of assignments) {
      const habit = this.habits.get(id);
      if (habit) this.habits.set(id, { ...habit, displayOrder });
    }
  }

  async deleteDayRecordsByIds(recordIds: readonly number[]): Promise<void> {
    this.operations.push(`deleteDayRecords:${recordIds.join(",")}`);
    const ids = new Set(recordIds);
    this.records = this.records.filter((record) => !ids.has(record.id));
  }

  async deleteReasonNotesForDates(
    habitId: number,
    dates: ReadonlySet<string>,
  ): Promise<void> {
    this.operations.push(
      `deleteReasonNotes:${habitId}:${[...dates].sort().join(",")}`,
    );
    this.reasonNotes = this.reasonNotes.filter(
      (note) => note.habitId !== habitId || !dates.has(note.date),
    );
  }

  async deleteSettingsByKeys(keys: readonly string[]): Promise<void> {
    this.operations.push(`deleteSettings:${keys.join(",")}`);
    for (const key of keys) this.settings.delete(key);
  }

  async deleteHabitsByIds(habitIds: readonly number[]): Promise<void> {
    this.operations.push(`deleteHabits:${habitIds.join(",")}`);
    for (const id of habitIds) this.habits.delete(id);
    const ids = new Set(habitIds);
    this.records = this.records.filter((record) => !ids.has(record.habitId));
  }

  async upsertDayRecord(input: {
    habitId: number;
    date: string;
    status: DayRecord["status"];
    createdAt: number;
    updatedAt: number;
  }): Promise<DayRecord> {
    this.operations.push(`upsertDayRecord:${input.habitId}:${input.date}`);
    const existing = this.records.find(
      (record) =>
        record.habitId === input.habitId && record.date === input.date,
    );
    const persisted: DayRecord = existing
      ? { ...existing, status: input.status, updatedAt: input.updatedAt }
      : { id: this.nextRecordId++, ...input };
    this.records = existing
      ? this.records.map((record) =>
          record.id === existing.id ? persisted : record,
        )
      : [...this.records, persisted];
    return { ...persisted };
  }

  async insertReasonNote(note: PersistedReasonNote): Promise<void> {
    this.operations.push(`insertReasonNote:${note.habitId}:${note.date}`);
    this.reasonNotes.push({ ...note });
  }

  async deleteDayRecord(habitId: number, date: string): Promise<void> {
    this.operations.push(`deleteDayRecord:${habitId}:${date}`);
    this.records = this.records.filter(
      (record) => record.habitId !== habitId || record.date !== date,
    );
  }
}

async function assertScheduleEquivalence() {
  for (const [name, fixture] of Object.entries(
    HABIT_PERSISTENCE_EQUIVALENCE_FIXTURES.schedule,
  )) {
    const repository = new FakeHabitRepository([fixture.habit], fixture.records);
    const application = createHabitPersistenceApplication(repository);
    const result = await application.persistScheduleEdit({
      habitId: fixture.habit.id,
      patch: { updatedAt: FIXED_NOW_MS },
      nextRepeatSchedule:
        "nextSchedule" in fixture ? fixture.nextSchedule : undefined,
      nextStartDate:
        "nextStartDate" in fixture ? fixture.nextStartDate : undefined,
      today: FIXED_TODAY,
      isCurrent: () => true,
    });
    if (name === "noChange") {
      assert.equal(result.kind, "unchanged");
      assert.deepEqual(
        repository.records.map((record) => record.date),
        fixture.records.map((record) => record.date),
      );

      for (const staleBoundary of [1, 2]) {
        const staleRepository = new FakeHabitRepository(
          [fixture.habit],
          fixture.records,
        );
        const beforeHabit = cloneHabit(fixture.habit);
        let checks = 0;
        await assert.rejects(
          createHabitPersistenceApplication(
            staleRepository,
          ).persistScheduleEdit({
            habitId: fixture.habit.id,
            patch: {
              description: "must not leak from a stale no-op schedule edit",
              updatedAt: FIXED_NOW_MS,
            },
            nextRepeatSchedule: fixture.habit.repeatSchedule,
            nextStartDate: fixture.habit.startDate,
            today: FIXED_TODAY,
            isCurrent: () => ++checks !== staleBoundary,
          }),
          StaleHabitScheduleMutationError,
        );
        assert.deepEqual(staleRepository.habits.get(fixture.habit.id), beforeHabit);
        assert.equal(staleRepository.operations.at(-1), "transaction.rollback");
      }
      continue;
    }
    assert.equal(result.kind, "updated");
    if (result.kind !== "updated") continue;
    const expectedRemovedDates = new Set<string>(
      fixture.expectedRemovedDates,
    );
    assert.deepEqual(
      [...result.removedRecordDates],
      [...fixture.expectedRemovedDates],
      `${name}: removed dates`,
    );
    assert.deepEqual(
      repository.records.map((record) => record.date),
      fixture.records
        .map((record) => record.date)
        .filter((date) => !expectedRemovedDates.has(date)),
      `${name}: persisted records`,
    );
  }

  const destructive = HABIT_PERSISTENCE_EQUIVALENCE_FIXTURES.schedule
    .removeImpossibleToday;
  const repository = new FakeHabitRepository(
    [destructive.habit],
    destructive.records,
  );
  await createHabitPersistenceApplication(repository).persistScheduleEdit({
    habitId: 1,
    patch: { updatedAt: FIXED_NOW_MS },
    nextRepeatSchedule: destructive.nextSchedule,
    today: FIXED_TODAY,
    isCurrent: () => true,
  });
  assert.deepEqual(repository.operations, [
    "transaction.begin",
    "readHabit:1",
    "readRecordsOrdered:1",
    "deleteDayRecords:11",
    "deleteReasonNotes:1:2026-07-24",
    "patchHabit:1",
    "transaction.commit",
  ]);

  for (const staleBoundary of [1, 2, 3]) {
    const staleRepository = new FakeHabitRepository(
      [destructive.habit],
      destructive.records,
    );
    const beforeHabit = cloneHabit(destructive.habit);
    const beforeRecords = structuredClone(destructive.records);
    let checks = 0;
    await assert.rejects(
      createHabitPersistenceApplication(staleRepository).persistScheduleEdit({
        habitId: 1,
        // A mixed row patch must never disable schedule cancellation. The
        // transaction snapshot proves both the ordinary field and deleted
        // records roll back together at every destructive boundary.
        patch: {
          description: "mixed stale description",
          updatedAt: FIXED_NOW_MS,
        },
        nextRepeatSchedule: destructive.nextSchedule,
        today: FIXED_TODAY,
        isCurrent: () => ++checks !== staleBoundary,
      }),
      StaleHabitScheduleMutationError,
    );
    assert.deepEqual(staleRepository.habits.get(1), beforeHabit);
    assert.deepEqual(staleRepository.records, beforeRecords);
    assert.equal(staleRepository.operations.at(-1), "transaction.rollback");
  }
}

async function assertOtherPersistenceProtocols() {
  const createRepository = new FakeHabitRepository([
    createHabitFixture({ id: 9, displayOrder: 7 }),
  ]);
  const { id: _fixtureId, ...newHabit } = createHabitFixture({ id: 0 });
  const created = await createHabitPersistenceApplication(
    createRepository,
  ).createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: true });
  assert.equal(created.displayOrder, 8);
  assert.deepEqual(createRepository.operations, [
    "transaction.begin",
    "readMaxDisplayOrder",
    "insertHabit",
    "transaction.commit",
  ]);
  createRepository.operations = [];
  const explicitlyOrdered = await createHabitPersistenceApplication(createRepository)
    .createHabit({ habit: { ...newHabit, displayOrder: 12 }, resolveDisplayOrderFromStorage: false });
  assert.equal(explicitlyOrdered.displayOrder, 12);
  assert.deepEqual(createRepository.operations, ["insertHabit"],
    "a complete in-memory order must retain the single-insert path");

  const reorderFixture = HABIT_PERSISTENCE_EQUIVALENCE_FIXTURES.reorder;
  const reorderRepository = new FakeHabitRepository([
    ...reorderFixture.activeIds.map((id, index) =>
      createHabitFixture({ id, displayOrder: index, isArchived: false }),
    ),
    createHabitFixture({
      id: reorderFixture.archived[0].id,
      displayOrder: reorderFixture.archived[0].displayOrder,
      isArchived: true,
    }),
  ]);
  const assignments = await createHabitPersistenceApplication(
    reorderRepository,
  ).persistReorder(reorderFixture.activeIds);
  assert.deepEqual(assignments, reorderFixture.expected);
  assert.deepEqual(reorderRepository.operations, [
    "transaction.begin",
    "readArchivedDisplayOrders",
    "patchHabitDisplayOrders:2,4,1,3",
    "transaction.commit",
  ]);
  assert.deepEqual(
    [...reorderRepository.habits.values()]
      .map(({ id, displayOrder }) => ({ id, displayOrder }))
      .sort((left, right) => left.id - right.id),
    reorderFixture.expected
      .slice()
      .sort((left, right) => left.id - right.id),
  );

  const lifecycleRepository = new FakeHabitRepository([createHabitFixture()]);
  const lifecycle = createHabitPersistenceApplication(lifecycleRepository);
  const archived = await lifecycle.archiveHabit(1, FIXED_NOW_MS);
  assert.equal(archived?.isArchived, true);
  assert.deepEqual(archived?.archiveHistory, [
    {
      archivedAt: FIXED_NOW_MS,
      restoredAt: null,
      archivedDate: FIXED_TODAY,
      restoredDate: null,
    },
  ]);
  const restored = await lifecycle.restoreHabits([1], FIXED_NOW_MS + 1_000);
  assert.equal(restored.get(1)?.isArchived, false);
  assert.deepEqual(restored.get(1)?.archiveHistory, [
    {
      archivedAt: FIXED_NOW_MS,
      restoredAt: FIXED_NOW_MS + 1_000,
      archivedDate: FIXED_TODAY,
      restoredDate: FIXED_TODAY,
    },
  ]);

  lifecycleRepository.settings.add("habit_description_lines_v1:1");
  lifecycleRepository.operations = [];
  await lifecycle.deleteHabits([1]);
  assert.deepEqual(lifecycleRepository.operations, [
    "transaction.begin",
    "deleteSettings:habit_description_lines_v1:1",
    "deleteHabits:1",
    "transaction.commit",
  ]);

  const markRepository = new FakeHabitRepository([createHabitFixture()]);
  const marks = createHabitPersistenceApplication(markRepository);
  await marks.markDay({
    ...HABIT_PERSISTENCE_EQUIVALENCE_FIXTURES.ordinaryMark,
    now: FIXED_NOW_MS,
  });
  assert.deepEqual(markRepository.operations, [
    "upsertDayRecord:1:2026-07-24",
  ]);
  markRepository.operations = [];
  await marks.markDay({
    ...HABIT_PERSISTENCE_EQUIVALENCE_FIXTURES.reasonedMark,
    now: FIXED_NOW_MS,
  });
  assert.deepEqual(markRepository.operations, [
    "transaction.begin",
    "upsertDayRecord:1:2026-07-24",
    "insertReasonNote:1:2026-07-24",
    "transaction.commit",
  ]);
  assert.equal(markRepository.reasonNotes[0]?.text, "no scales");
}

async function assertBulkDisplayOrderProtocol() {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  let activeRuns = 0;
  let maxConcurrentRuns = 0;
  const executor: AsyncDatabaseExecutor = {
    async run(sql, params) {
      activeRuns += 1;
      maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
      await Promise.resolve();
      calls.push({ sql, params: [...(params as readonly unknown[])] });
      activeRuns -= 1;
      return {} as never;
    },
    async getFirst() {
      throw new Error("unexpected getFirst");
    },
    async getAll() {
      throw new Error("unexpected getAll");
    },
  };
  const assignments = Array.from(
    { length: HABIT_DISPLAY_ORDER_UPDATE_CHUNK_SIZE + 1 },
    (_, index) => ({ id: index + 1, displayOrder: 500 - index }),
  );

  await patchHabitDisplayOrders(executor, assignments);
  assert.equal(calls.length, 2);
  assert.equal(maxConcurrentRuns, 1);
  assert.match(calls[0].sql, /UPDATE habits[\s\S]*CASE id[\s\S]*WHERE id IN/);
  assert.equal(
    calls[0].params.length,
    HABIT_DISPLAY_ORDER_UPDATE_CHUNK_SIZE * 3,
  );
  assert.deepEqual(calls[0].params.slice(0, 4), [1, 500, 2, 499]);
  assert.equal(
    calls[0].params[HABIT_DISPLAY_ORDER_UPDATE_CHUNK_SIZE * 2],
    1,
  );
  assert.equal(calls[0].params.at(-1), HABIT_DISPLAY_ORDER_UPDATE_CHUNK_SIZE);
  assert.deepEqual(calls[1].params, [251, 250, 251]);

  calls.length = 0;
  await patchHabitDisplayOrders(executor, []);
  assert.equal(calls.length, 0);
}

function assertDisplayOrderProjectionIdentity() {
  const rows = [
    { id: 1, displayOrder: 0, label: "one" },
    { id: 2, displayOrder: 1, label: "two" },
    { id: 3, displayOrder: 2, label: "three" },
    { id: 4, displayOrder: 3, label: "four" },
  ];
  const assignments = [
    { id: 1, displayOrder: 0 },
    { id: 3, displayOrder: 1 },
    { id: 2, displayOrder: 2 },
    { id: 4, displayOrder: 3 },
  ];
  const reconciled = reconcileDisplayOrderRows(rows, assignments);
  assert.deepEqual(
    reconciled.map(({ id }) => id),
    [1, 3, 2, 4],
  );
  assert.equal(reconciled[0], rows[0]);
  assert.equal(reconciled[3], rows[3]);
  assert.notEqual(reconciled[1], rows[2]);
  assert.notEqual(reconciled[2], rows[1]);
  assert.equal(
    reconcileDisplayOrderRows(reconciled, assignments),
    reconciled,
    "an equal persistence acknowledgement must preserve the array identity",
  );
  assert.equal(reconcileDisplayOrderRows(rows, []), rows);
}

async function assertExactCutoffFence() {
  let releaseReentrantAction!: () => void;
  let reentrantFence!: ReturnType<typeof capturePendingHabitWriteFence>;
  let reentrantFenceWait!: Promise<void>;
  let reentrantFenceSettled = false;
  const reentrantAction = withPendingHabitWriteTracking(async () => {
    // Simulate a synchronous Zustand subscriber starting export while the
    // mutation is still inside its optimistic state publication.
    reentrantFence = capturePendingHabitWriteFence();
    reentrantFenceWait = waitForPendingHabitWritesThrough(reentrantFence).then(
      () => {
        reentrantFenceSettled = true;
      },
    );
    await new Promise<void>((resolve) => {
      releaseReentrantAction = resolve;
    });
  });
  const reentrantOperation = reentrantAction();
  await Promise.resolve();
  assert.equal(
    reentrantFenceSettled,
    false,
    "a fence captured by a synchronous state subscriber must see the action",
  );
  releaseReentrantAction();
  await Promise.all([reentrantOperation, reentrantFenceWait]);
  assert.equal(reentrantFenceSettled, true);
  releasePendingHabitWriteFence(reentrantFence);

  let releaseCaptured!: () => void;
  let latestSequence = 0;
  const persisted: string[] = [];
  const capturedAction = withPendingHabitWriteTracking(async () => {
    const sequence = getCurrentHabitWriteSequence();
    await new Promise<void>((resolve) => {
      releaseCaptured = resolve;
    });
    if (
      (await waitForHabitPersistenceTurn(sequence)) &&
      isHabitWriteProtectedByFence(sequence, latestSequence)
    ) {
      persisted.push("captured");
    }
  });
  const postFenceAction = withPendingHabitWriteTracking(async () => {
    const sequence = getCurrentHabitWriteSequence();
    latestSequence = sequence;
    await Promise.resolve();
    if (await waitForHabitPersistenceTurn(sequence)) {
      persisted.push("post-fence");
    }
  });

  const captured = capturedAction();
  const exportFence = capturePendingHabitWriteFence();
  const postFence = postFenceAction();
  releaseCaptured();
  await waitForPendingHabitWritesThrough(exportFence);
  assert.deepEqual(persisted, ["captured"]);
  releasePendingHabitWriteFence(exportFence);
  await Promise.all([captured, postFence]);
  assert.deepEqual(persisted, ["captured", "post-fence"]);

  const importFence = capturePendingHabitWriteFence();
  const discarded = postFenceAction();
  await waitForPendingHabitWritesThrough(importFence);
  releasePendingHabitWriteFence(importFence, { discardPostFence: true });
  await discarded;
  assert.deepEqual(persisted, ["captured", "post-fence"]);

  const singleFence = capturePendingHabitWriteFence();
  assert.throws(capturePendingHabitWriteFence, /already active/);
  releasePendingHabitWriteFence(singleFence);
}

async function assertLargeSqliteDeletesAreChunked(): Promise<void> {
  const calls: { sql: string; params: unknown[] }[] = [];
  const executor = {
    async run(sql: string, params: unknown[] = []) {
      calls.push({ sql, params: [...params] });
    },
  };
  const values = Array.from(
    { length: SQLITE_DELETE_BIND_CHUNK_SIZE * 2 + 17 },
    (_, index) => index + 1,
  );

  await deleteSqliteRowsByValues(
    executor,
    { table: "habits", column: "id" },
    values,
  );
  assert.deepEqual(
    calls.map(({ params }) => params.length),
    [SQLITE_DELETE_BIND_CHUNK_SIZE, SQLITE_DELETE_BIND_CHUNK_SIZE, 17],
    "a valid large import/delete must never form one unbounded SQLite IN list",
  );
  assert.ok(
    calls.every(({ sql, params }) => {
      const placeholderCount = (sql.match(/\?/g) ?? []).length;
      return (
        sql.startsWith("DELETE FROM habits WHERE id IN (") &&
        placeholderCount === params.length
      );
    }),
    "every chunk must bind exactly the placeholders in its own statement",
  );

  calls.length = 0;
  await deleteSqliteRowsByValues(
    executor,
    { table: "settings", column: "key" },
    values.map((value) => `habit_description_lines_v1:${value}`),
  );
  assert.deepEqual(
    calls.map(({ params }) => params.length),
    [SQLITE_DELETE_BIND_CHUNK_SIZE, SQLITE_DELETE_BIND_CHUNK_SIZE, 17],
    "description-setting cleanup needs the same bind limit as habit deletion",
  );

  calls.length = 0;
  await deleteSqliteRowsByValues(
    executor,
    { table: "habits", column: "id" },
    [],
  );
  assert.equal(calls.length, 0, "an empty deletion must not issue invalid IN () SQL");
}

function assertOutOfOrderEditablePatchOwnership(): void {
  const olderPatch: HabitPatch = {
    description: "older description",
    reminderEnabled: true,
    reminderTime: "09:00",
    updatedAt: 100,
  };
  const selected = selectPersistableHabitUpdatePatch(
    olderPatch,
    (scope) => scope === "reminder-enabled" || scope === "reminder-time",
  );
  assert.deepEqual(selected, {
    reminderEnabled: true,
    reminderTime: "09:00",
  });

  const durableAfterNewerCommand: HabitPatch = {
    description: "newer description",
    reminderEnabled: false,
    reminderTime: null,
    updatedAt: 200,
  };
  assert.deepEqual(
    { ...durableAfterNewerCommand, ...selected },
    {
      description: "newer description",
      reminderEnabled: true,
      reminderTime: "09:00",
      updatedAt: 200,
    },
    "an older mixed command may persist its still-owned reminder fields without overwriting a newer description or timestamp",
  );

  assert.equal(
    selectPersistableHabitUpdatePatch(olderPatch, () => false),
    null,
    "a fully superseded command must not issue a stale row update",
  );
  assert.deepEqual(
    selectPersistableHabitUpdatePatch(olderPatch, () => true),
    olderPatch,
    "an uncontested command must preserve its complete patch",
  );

  assert.deepEqual(
    partitionMixedHabitUpdateInput({
      description: "keep me",
      reminderEnabled: true,
      reminderTime: "09:00",
      repeatSchedule: { type: "interval", every: 2 },
      startDate: "2026-07-02",
    }),
    {
      schedule: {
        repeatSchedule: { type: "interval", every: 2 },
        startDate: "2026-07-02",
      },
      editable: {
        description: "keep me",
        reminderEnabled: true,
        reminderTime: "09:00",
      },
    },
    "mixed schedule and row edits must receive independent ownership tokens",
  );
  assert.equal(
    partitionMixedHabitUpdateInput({ description: "ordinary" }),
    null,
  );
  assert.equal(
    partitionMixedHabitUpdateInput({
      repeatSchedule: { type: "weekdays", days: [1] },
    }),
    null,
  );
}

function assertDependencyDirection() {
  const store = readFileSync(
    resolve(process.cwd(), "src/stores/habit-store.ts"),
    "utf8",
  );
  const application = readFileSync(
    resolve(process.cwd(), "src/application/habits/habit-persistence.ts"),
    "utf8",
  );
  const adapter = readFileSync(
    resolve(process.cwd(), "src/data/sqlite/habit-repository.ts"),
    "utf8",
  );
  const composition = readFileSync(
    resolve(process.cwd(), "src/composition/habits.ts"),
    "utf8",
  );
  assert.doesNotMatch(store, /@\/(?:data|db)\//);
  assert.doesNotMatch(store, /runtimeDb\./);
  assert.doesNotMatch(
    store,
    /["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\s/i,
  );
  assert.match(store, /habitPersistence\./);
  assert.doesNotMatch(
    application,
    /@\/data|@\/db|react-native|zustand|expo-sqlite/,
  );
  assert.match(adapter, /HabitPersistenceRepository/);
  assert.match(adapter, /runtimeDb/);
  assert.match(composition, /createHabitPersistenceApplication/);
  assert.match(composition, /sqliteHabitRepository/);
  assert.doesNotMatch(composition, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/);
}

async function assertDelayedHabitFenceAdmission(): Promise<void> {
  for (const discard of [false, true]) {
    const fence = capturePendingHabitWriteFence();
    let releasePaint!: () => void;
    const paint = new Promise<void>((resolve) => { releasePaint = resolve; });
    let persistenceCalls = 0;
    const delayed = withPendingHabitWriteTracking(async () => {
      const sequence = getCurrentHabitWriteSequence();
      await paint;
      const admitted = await waitForHabitPersistenceTurn(sequence);
      if (admitted) persistenceCalls += 1;
      return admitted;
    });
    const pending = delayed();
    releasePendingHabitWriteFence(fence, { discardPostFence: discard });
    // A new fence captures this still-pending old command. Its own cutoff
    // cannot block that command while it waits for the command to settle.
    const nextFence = capturePendingHabitWriteFence();
    try {
      releasePaint();
      assert.equal(await pending, !discard, "delayed admission must retain its captured import outcome after release");
      await waitForPendingHabitWritesThrough(nextFence);
      assert.equal(persistenceCalls, discard ? 0 : 1);
    } finally {
      releasePendingHabitWriteFence(nextFence);
    }
    const fresh = withPendingHabitWriteTracking(async () =>
      waitForHabitPersistenceTurn(getCurrentHabitWriteSequence()),
    );
    assert.equal(await fresh(), true, "new writes after release must not inherit another command's captured fence");
  }

  let resumePreCutoff!: () => void;
  const preCutoffPaint = new Promise<void>((resolve) => { resumePreCutoff = resolve; });
  const preCutoff = withPendingHabitWriteTracking(async () => {
    const sequence = getCurrentHabitWriteSequence();
    await preCutoffPaint;
    return waitForHabitPersistenceTurn(sequence);
  });
  const pendingPreCutoff = preCutoff();
  const cutoff = capturePendingHabitWriteFence();
  try {
    resumePreCutoff();
    assert.equal(await pendingPreCutoff, true, "a captured pre-cutoff write must remain eligible to commit while its export waits");
    await waitForPendingHabitWritesThrough(cutoff);
  } finally {
    releasePendingHabitWriteFence(cutoff);
  }

  const source = readFileSync(resolve(process.cwd(), "src/application/habits/habit-write-fence.ts"), "utf8");
  const pending = new Map<number, { capturedFence: unknown }>();
  const active = new Map([[1, { token: { cutoffSequence: 0 } }]]);
  const register = loadSourceCallableForAudit<(sequence: number) => () => void>(
    source,
    "registerPendingHabitWriteSequence",
    { pendingHabitWrites: pending, activeHabitWriteFences: active, Promise },
  );
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    const settle = register(sequence);
    assert.equal(pending.size, 1);
    assert.strictEqual(pending.get(sequence)?.capturedFence, active.get(1));
    settle();
    assert.equal(pending.size, 0, "settlement must release the pending row and its captured fence reference");
  }
}

async function assertSqliteIntegerCapacity(): Promise<void> {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  const model = createHabitFixture({ name: "Example" });
  const { id: _modelId, ...newHabit } = model;
  type Fixture = ReturnType<typeof loadSqliteRepositoriesForAudit>;
  const snapshot = (fixture: Fixture): string => JSON.stringify(
    ["habits", "day_records", "notes", "settings", "sqlite_sequence"].map((table) => {
      const statement = fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`);
      statement.setReadBigInts(true);
      return statement.all();
    }),
    (_, value: unknown) => typeof value === "bigint" ? value.toString() : value,
  );
  const sequence = (fixture: Fixture, table: string): bigint => {
    const statement = fixture.database.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?");
    statement.setReadBigInts(true);
    return (statement.get(table)?.seq ?? 0n) as bigint;
  };
  const note = {
    habitId: 1, date: FIXED_TODAY, text: "Example", isFailureReason: false,
    reasonType: null, createdAt: FIXED_NOW_MS, updatedAt: FIXED_NOW_MS,
  } as const;

  for (const table of ["habits", "notes", "day_records"] as const) {
    for (const state of ["fresh", "last-slot", "full", "deleted-high-water", "max-row-low-sequence"] as const) {
      const fixture = loadSqliteRepositoriesForAudit();
      const application = createHabitPersistenceApplication(fixture.habits);
      try {
        if (table !== "habits") {
          await application.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: false });
        }
        const allocate = () => table === "habits"
          ? application.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: false })
          : table === "notes"
            ? fixture.notes.createNote(note)
            : application.markDay({ habitId: 1, date: "2026-07-25", status: "done", now: FIXED_NOW_MS });
        if (state !== "fresh") {
          const initial = table === "day_records"
            ? await application.markDay({ habitId: 1, date: FIXED_TODAY, status: "done", now: FIXED_NOW_MS })
            : await allocate();
          const high = state === "last-slot" ? maximum - 1n : maximum;
          fixture.database.prepare(`UPDATE ${table} SET id = ? WHERE id = ?`).run(high, initial.id);
          fixture.database.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(high, table);
          if (state === "deleted-high-water") fixture.database.exec(`DELETE FROM ${table}`);
          if (state === "max-row-low-sequence") fixture.database.prepare("UPDATE sqlite_sequence SET seq = 1 WHERE name = ?").run(table);
        }
        const before = snapshot(fixture);
        if (state === "fresh" || state === "last-slot") {
          const created = await allocate();
          assert.equal(created.id, state === "fresh" ? 1 : Number.MAX_SAFE_INTEGER, "a native insert must permit the final exactly representable identity");
        } else {
          await assert.rejects(allocate(), /returned no row/);
          assert.equal(snapshot(fixture), before, "identity exhaustion must preserve native rows and high-water counters without a transaction wrapper");
        }
        if (state === "full") {
          if (table === "habits") {
            await application.patchHabit(Number.MAX_SAFE_INTEGER, { name: "Updated" });
            assert.equal((await application.readHabit(Number.MAX_SAFE_INTEGER))?.name, "Updated");
            await application.archiveHabit(Number.MAX_SAFE_INTEGER, FIXED_NOW_MS);
            assert.equal((await application.readHabit(Number.MAX_SAFE_INTEGER))?.isArchived, true);
            await application.restoreHabits([Number.MAX_SAFE_INTEGER], FIXED_NOW_MS + 1);
            await application.deleteHabits([Number.MAX_SAFE_INTEGER]);
          } else if (table === "notes") {
            await fixture.notes.updateNoteText(Number.MAX_SAFE_INTEGER, "Updated", FIXED_NOW_MS + 1);
            assert.equal((await fixture.notes.getNotesForHabit(1))[0]?.text, "Updated");
            await fixture.notes.deleteNote(Number.MAX_SAFE_INTEGER);
          } else {
            const updated = await application.markDay({ habitId: 1, date: FIXED_TODAY, status: "maximum", now: FIXED_NOW_MS + 1 });
            assert.equal(updated.id, Number.MAX_SAFE_INTEGER);
            assert.equal(updated.createdAt, FIXED_NOW_MS);
            assert.equal(sequence(fixture, table), maximum, "an existing day UPSERT must reuse its ID without advancing an exhausted sequence");
            await application.unmarkDay(1, FIXED_TODAY);
          }
        }
      } finally {
        await fixture.runtime.whenIdle();
        fixture.database.close();
      }
    }
  }

  const fixture = loadSqliteRepositoriesForAudit();
  const application = createHabitPersistenceApplication(fixture.habits);
  try {
    await application.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: false });
    await application.markDay({ habitId: 1, date: FIXED_TODAY, status: "done", now: FIXED_NOW_MS });
    fixture.database.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'day_records'").run(9223372036854775807n);
    const existing = await application.markDay({ habitId: 1, date: FIXED_TODAY, status: "maximum", now: FIXED_NOW_MS + 1 });
    assert.equal(existing.id, 1);
    assert.equal(sequence(fixture, "day_records"), 9223372036854775807n);
    fixture.database.prepare("UPDATE sqlite_sequence SET seq = 1 WHERE name = 'day_records'").run();
    const firstNote = await fixture.notes.createNote(note);
    fixture.database.prepare("UPDATE notes SET id = ? WHERE id = ?").run(maximum, firstNote.id);
    fixture.database.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'notes'").run(maximum);
    for (const date of [FIXED_TODAY, "2026-07-25"]) {
      const before = snapshot(fixture);
      await assert.rejects(
        application.markDay({ habitId: 1, date, status: "failure", reason: "Example reason", now: FIXED_NOW_MS + 2 }),
        /Note identity capacity exhausted/,
      );
      assert.equal(snapshot(fixture), before, "an exhausted reason-note allocation must roll back the record change and both native sequences");
    }

    fixture.database.prepare("UPDATE habits SET display_order = ? WHERE id = 1").run(maximum);
    const beforeOrderFailure = snapshot(fixture);
    await assert.rejects(application.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: true }), /display order/);
    await assert.rejects(application.createHabit({ habit: { ...newHabit, displayOrder: Number.MAX_SAFE_INTEGER + 1 }, resolveDisplayOrderFromStorage: false }), /display order/);
    await assert.rejects(fixture.habits.insertHabit({ ...newHabit, displayOrder: Number.MAX_SAFE_INTEGER + 1 }), /display order/);
    await assert.rejects(fixture.habits.patchHabit(1, { displayOrder: Number.MAX_SAFE_INTEGER + 1 }), /display order/);
    assert.equal(snapshot(fixture), beforeOrderFailure, "unsafe computed or direct display order must fail before any native mutation");
    let bulkCalls = 0;
    await assert.rejects(patchHabitDisplayOrders({
      ...fixture.runtime,
      async run(sql, params) { bulkCalls += 1; return fixture.runtime.run(sql, params); },
    }, [
      { id: 1, displayOrder: 0 },
      { id: 2, displayOrder: Number.MAX_SAFE_INTEGER + 1 },
    ]), /display order/);
    assert.equal(bulkCalls, 0, "bulk display-order validation must finish before its first statement");
    assert.equal(snapshot(fixture), beforeOrderFailure);

    const store = loadHabitStoreForAudit({ habits: [], records: [] });
    Object.assign(store.persistence.application, application);
    const actualStore = store.storeModule.useHabitStore;
    await actualStore.getState().loadHabits();
    await assert.rejects(actualStore.getState().createHabit({ name: "Created", startDate: FIXED_TODAY, repeatSchedule: { type: "daily" }, reminderEnabled: false }), /display order/);
    assert.equal(actualStore.getState().habits.length, 1, "failed numeric allocation must remove its optimistic creation without losing existing rows");
    assert.equal(actualStore.getState().habits[0]?.id, 1);
    assert.equal(snapshot(fixture), beforeOrderFailure);
  } finally {
    await fixture.runtime.whenIdle();
    fixture.database.close();
  }
  assert.equal(assignDisplayOrdersAroundArchivedSlots([], [{ id: 1, displayOrder: Number.MAX_SAFE_INTEGER }]).archived[0]?.displayOrder, Number.MAX_SAFE_INTEGER);
  assert.throws(() => assignDisplayOrdersAroundArchivedSlots([], [
    { id: 1, displayOrder: Number.MAX_SAFE_INTEGER },
    { id: 2, displayOrder: Number.MAX_SAFE_INTEGER },
  ]), /display order/, "an archived-slot collision must reject before incrementing beyond exact integer capacity");

  let unsafeInsertCalls = 0;
  const domain = createHabitPersistenceApplication({
    ...fixture.habits,
    transaction: async (task) => {
      return task({
        ...fixture.habits,
        readMaxDisplayOrder: async () => Number.MAX_SAFE_INTEGER,
        insertHabit: async (habit) => {
          unsafeInsertCalls += 1;
          return createHabitFixture(habit);
        },
      });
    },
  });
  await assert.rejects(domain.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: true }), /display order/);
  assert.equal(unsafeInsertCalls, 0, "the application must not submit an unsafe computed order to its repository port");
}

async function assertConcurrentSqliteCreation(): Promise<void> {
  for (const existing of [false, true]) {
    const fixture = loadSqliteRepositoriesForAudit();
    const application = createHabitPersistenceApplication(fixture.habits);
    const { id: _fixtureId, ...newHabit } = createHabitFixture({ name: "Practice" });
    try {
      if (existing) {
        await application.createHabit({
          habit: { ...newHabit, name: "Active", displayOrder: 2 },
          resolveDisplayOrderFromStorage: false,
        });
        const archived = await application.createHabit({
          habit: { ...newHabit, name: "Archived", displayOrder: 7 },
          resolveDisplayOrderFromStorage: false,
        });
        await application.archiveHabit(archived.id, FIXED_NOW_MS);
      }
      const firstOrder = existing ? 8 : 0;
      const created = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        application.createHabit({
          habit: { ...newHabit, name: `Practice ${index + 1}`, displayOrder: index },
          resolveDisplayOrderFromStorage: true,
        }),
      ));
      assert.deepEqual(
        created.map((habit) => habit.displayOrder),
        Array.from({ length: created.length }, (_, index) => firstOrder + index),
        "concurrent allocation must use the order committed by the preceding insertion",
      );
      const snapshot = await fixture.transfers.readConsistentSnapshot();
      if (existing) {
        assert.equal(snapshot.habits.find((habit) => habit.name === "Active")?.displayOrder, 2);
        assert.equal(snapshot.habits.find((habit) => habit.name === "Archived")?.displayOrder, 7,
          "allocation must retain occupied archived positions and sparse existing order");
      }
      const restored = normalizeImportData(buildExportJsonFromRows({
        ...snapshot, exportedAt: new Date(FIXED_NOW_MS).toISOString(),
      }));
      await fixture.transfers.replaceAndVerify(restored, (rows) => verifyRestoredImportRows(restored, rows));
      assert.deepEqual(
        (await fixture.habits.readAllHabits()).map(({ id, displayOrder }) => ({ id, displayOrder })),
        snapshot.habits.map(({ id, displayOrder }) => ({ id, displayOrder })),
        "an export/import round trip must retain every allocated identity and order",
      );

      fixture.database.exec("CREATE TRIGGER reject_habit_insert BEFORE INSERT ON habits BEGIN SELECT RAISE(ABORT, 'Rejected insertion'); END");
      const beforeFailure = JSON.stringify(await fixture.transfers.readConsistentSnapshot());
      const sequenceBefore = fixture.database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'habits'").get()?.seq;
      await assert.rejects(application.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: true }), /Rejected insertion/);
      assert.equal(JSON.stringify(await fixture.transfers.readConsistentSnapshot()), beforeFailure);
      assert.equal(fixture.database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'habits'").get()?.seq, sequenceBefore,
        "failed allocation must leave the habit identity counter unchanged");
      fixture.database.exec("DROP TRIGGER reject_habit_insert");
      assert.equal(
        (await application.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: true })).displayOrder,
        firstOrder + created.length,
        "a rejected insertion must not reserve an unused display position",
      );
    } finally {
      await fixture.runtime.whenIdle();
      fixture.database.close();
    }
  }
}

async function assertDisplayOrderMigration(): Promise<void> {
  const migration = readFileSync(resolve("drizzle/0001_habit_display_order.sql"), "utf8");
  const cases = [
    [], [0], [12, 2, 7], [Number.MAX_SAFE_INTEGER - 2, Number.MAX_SAFE_INTEGER],
    [0, 0], [0, 0, 9], [7, 2, 2, 0, 9], [2, 2, 2, 7],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ];
  for (const orders of cases) {
    const fixture = loadSqliteRepositoriesForAudit();
    const application = createHabitPersistenceApplication(fixture.habits);
    const { id: _fixtureId, ...newHabit } = createHabitFixture({ name: "Practice" });
    const relatedRows = () => JSON.stringify({
      records: fixture.database.prepare("SELECT * FROM day_records ORDER BY id").all(),
      notes: fixture.database.prepare("SELECT * FROM notes ORDER BY id").all(),
      settings: fixture.database.prepare("SELECT * FROM settings ORDER BY key").all(),
      sequences: fixture.database.prepare("SELECT * FROM sqlite_sequence ORDER BY name").all(),
    });
    try {
      fixture.database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("theme", JSON.stringify("light"));
      for (const [index, displayOrder] of orders.entries()) {
        const created = await application.createHabit({
          habit: { ...newHabit, name: `Practice ${index + 1}`, displayOrder },
          resolveDisplayOrderFromStorage: false,
        });
        if (index % 2 === 1) await application.archiveHabit(created.id, FIXED_NOW_MS);
        await application.markDay({ habitId: created.id, date: FIXED_TODAY, status: "done", now: FIXED_NOW_MS });
        await fixture.notes.createNote({
          habitId: created.id, date: FIXED_TODAY, text: "Practice note", isFailureReason: false,
          reasonType: null, createdAt: FIXED_NOW_MS, updatedAt: FIXED_NOW_MS,
        });
      }
      const before = await fixture.habits.readAllHabits();
      const relatedBefore = relatedRows();
      const duplicated = new Set(orders).size !== orders.length;
      const projectWithoutOrder = (rows: Habit[]) => rows.map(({ displayOrder: _order, ...habit }) => habit);
      const checkResult = async () => {
        const after = await fixture.habits.readAllHabits();
        assert.deepEqual(projectWithoutOrder(after), projectWithoutOrder(before),
          "order repair must preserve full row identity, relative ordering, archive history and timestamps");
        assert.deepEqual(after.map((habit) => habit.displayOrder), duplicated
          ? orders.map((_, index) => index)
          : before.map((habit) => habit.displayOrder),
        "only a duplicate dataset may receive new display positions");
        assert.equal(relatedRows(), relatedBefore, "order repair must not change related rows or identity counters");
        normalizeImportData(buildExportJsonFromRows({
          ...await fixture.transfers.readConsistentSnapshot(), exportedAt: new Date(FIXED_NOW_MS).toISOString(),
        }));
      };
      fixture.database.exec("BEGIN");
      fixture.database.exec(migration);
      fixture.database.exec("ROLLBACK");
      assert.deepEqual(await fixture.habits.readAllHabits(), before,
        "a rolled-back repair must restore all original display positions");
      assert.equal(relatedRows(), relatedBefore);
      if (duplicated) {
        fixture.database.exec("CREATE TRIGGER reject_order_repair BEFORE UPDATE OF display_order ON habits WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'Rejected order repair'); END");
        assert.throws(() => fixture.database.exec(migration), /Rejected order repair/);
        assert.deepEqual(await fixture.habits.readAllHabits(), before,
          "a repair failure must not leave preceding rows partly renumbered");
        assert.equal(relatedRows(), relatedBefore);
        fixture.database.exec("DROP TRIGGER reject_order_repair");
      }
      fixture.database.exec("BEGIN");
      fixture.database.exec(migration);
      fixture.database.exec("COMMIT");
      await checkResult();
      fixture.database.exec(migration);
      await checkResult();
    } finally {
      await fixture.runtime.whenIdle();
      fixture.database.close();
    }
  }
}

async function assertNativeMigrationJournal(): Promise<void> {
  const journal = JSON.parse(readFileSync(resolve("drizzle/meta/_journal.json"), "utf8")) as {
    entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
  };
  const bundled = {
    journal,
    migrations: Object.fromEntries(journal.entries.map((entry) => [
      `m${String(entry.idx).padStart(4, "0")}`,
      readFileSync(resolve(`drizzle/${entry.tag}.sql`), "utf8"),
    ])),
  };
  const migrationDb = (database: DatabaseSync) => drizzle({
    prepareSync(sql: string) {
      const statement = database.prepare(sql);
      return {
        executeSync(params: SQLInputValue[]) {
          const result = statement.run(...params);
          return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
        },
        executeForRawResultSync(params: SQLInputValue[]) {
          return { getAllSync: () => statement.all(...params).map((row) => Object.values(row)) };
        },
      };
    },
  } as unknown as Parameters<typeof drizzle>[0]);
  const fresh = new DatabaseSync(":memory:");
  try {
    await migrate(migrationDb(fresh), bundled);
    assert.deepEqual(
      fresh.prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at").all().map((row) => row.created_at),
      journal.entries.map((entry) => entry.when),
      "a fresh native migration run must install and acknowledge every bundled migration",
    );
  } finally {
    fresh.close();
  }

  for (const watermark of [journal.entries[0].when, 1784800000000]) {
    const fixture = loadSqliteRepositoriesForAudit();
    const application = createHabitPersistenceApplication(fixture.habits);
    const { id: _fixtureId, ...newHabit } = createHabitFixture({ name: "Practice" });
    const db = migrationDb(fixture.database);
    try {
      await application.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: false });
      await application.createHabit({ habit: newHabit, resolveDisplayOrderFromStorage: false });
      fixture.database.exec("CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)");
      fixture.database.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run("baseline", watermark);
      const before = await fixture.habits.readAllHabits();
      fixture.database.exec("CREATE TRIGGER reject_native_order_repair BEFORE UPDATE OF display_order ON habits WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'Rejected native order repair'); END");
      await assert.rejects(migrate(db, bundled), (error: unknown) =>
        error instanceof Error && error.cause instanceof Error && /Rejected native order repair/.test(error.cause.message),
        "a pending repair must execute before its marker is acknowledged",
      );
      assert.deepEqual(await fixture.habits.readAllHabits(), before,
        "failed native migration must roll back every modified habit");
      assert.deepEqual(fixture.database.prepare("SELECT hash, created_at FROM __drizzle_migrations").all().map((row) => ({ ...row })), [
        { hash: "baseline", created_at: watermark },
      ], "failed native migration must not acknowledge its journal marker");
      fixture.database.exec("DROP TRIGGER reject_native_order_repair");
      await migrate(db, bundled);
      assert.deepEqual((await fixture.habits.readAllHabits()).map((habit) => habit.displayOrder), [0, 1],
        "the repair marker must sort after every supported database watermark");
      const markers = fixture.database.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all();
      assert.deepEqual(markers.map((row) => row.created_at), [watermark, journal.entries.at(-1)!.when]);
      const repaired = await fixture.habits.readAllHabits();
      await migrate(db, bundled);
      assert.deepEqual(await fixture.habits.readAllHabits(), repaired);
      assert.deepEqual(fixture.database.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at").all(), markers,
        "a completed data repair must not execute or acknowledge again");
    } finally {
      await fixture.runtime.whenIdle();
      fixture.database.close();
    }
  }
}

async function assertSqliteReplacementIdentityLifetime(): Promise<void> {
  const fixture = loadSqliteRepositoriesForAudit();
  const application = createHabitPersistenceApplication(fixture.habits);
  const { id: _modelId, ...habit } = createHabitFixture({ name: "Example" });
  const exportedAt = new Date(FIXED_NOW_MS).toISOString();
  const normalized = (rows: DataTransferRows) =>
    normalizeImportData(buildExportJsonFromRows({ ...rows, exportedAt }));
  const replace = (data: NormalizedImportData) => fixture.transfers.replaceAndVerify(
    data, (restored) => verifyRestoredImportRows(data, restored),
  );
  const sequenceRows = () => {
    const statement = fixture.database.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name");
    statement.setReadBigInts(true);
    return statement.all().map((row) => ({ name: row.name, seq: String(row.seq) }));
  };
  const snapshot = () => JSON.stringify(
    ["habits", "day_records", "notes", "settings", "sqlite_sequence"].map((table) => {
      const statement = fixture.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`);
      statement.setReadBigInts(true);
      return statement.all();
    }),
    (_, value: unknown) => typeof value === "bigint" ? value.toString() : value,
  );
  const note = (habitId: number) => ({
    habitId, date: FIXED_TODAY, text: "Example", isFailureReason: false,
    reasonType: null, createdAt: FIXED_NOW_MS, updatedAt: FIXED_NOW_MS,
  });
  try {
    await application.createHabit({ habit, resolveDisplayOrderFromStorage: false });
    await application.markDay({ habitId: 1, date: FIXED_TODAY, status: "done", now: FIXED_NOW_MS });
    await fixture.notes.createNote(note(1));
    const smallRows = await fixture.transfers.readConsistentSnapshot();
    const small = normalized(smallRows);
    const maximum = Number.MAX_SAFE_INTEGER;
    const high = normalized({
      ...smallRows,
      habits: smallRows.habits.map((row) => ({ ...row, id: maximum })),
      dayRecords: smallRows.dayRecords.map((row) => ({ ...row, id: maximum, habitId: maximum })),
      notes: smallRows.notes.map((row) => ({ ...row, id: maximum, habitId: maximum })),
    });
    await replace(high);
    const exhaustedSequences = sequenceRows();
    assert.deepEqual(exhaustedSequences.map((row) => row.seq), Array(3).fill(String(maximum)));
    const highSnapshot = snapshot();
    await assert.rejects(application.createHabit({ habit, resolveDisplayOrderFromStorage: false }), /returned no row/);
    await assert.rejects(fixture.notes.createNote(note(maximum)), /returned no row/);
    await assert.rejects(application.markDay({ habitId: maximum, date: "2026-07-25", status: "done", now: FIXED_NOW_MS }), /returned no row/);
    assert.equal(snapshot(), highSnapshot);

    await replace(small);
    assert.deepEqual(sequenceRows().map((row) => row.seq), ["1", "1", "1"], "replacement must rebuild all three identity counters from restored rows");
    assert.equal((await application.createHabit({ habit, resolveDisplayOrderFromStorage: false })).id, 2);
    assert.equal((await fixture.notes.createNote(note(1))).id, 2);
    assert.equal((await application.markDay({ habitId: 1, date: "2026-07-25", status: "done", now: FIXED_NOW_MS })).id, 2);

    await replace(high);
    const beforeFailure = snapshot();
    await assert.rejects(fixture.transfers.replaceAndVerify(small, () => {
      throw new Error("Injected replacement verification failure");
    }), /replacement verification failure/);
    assert.equal(snapshot(), beforeFailure, "verification failure after reset must restore all rows and exact prior identity counters");
    await assert.rejects(replace({
      ...small,
      notes: [...small.notes, { ...small.notes[0], id: 2, habitId: 12345 }],
    }), /FOREIGN KEY constraint failed/i);
    assert.equal(snapshot(), beforeFailure, "restoration failure after reset must roll back preceding inserts and all identity counters");

    fixture.database.exec("CREATE TABLE unrelated_ids (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    fixture.database.exec("INSERT INTO unrelated_ids (id) VALUES (77)");
    const empty = normalized({ habits: [], dayRecords: [], notes: [], settings: [] });
    await replace(empty);
    assert.deepEqual(sequenceRows(), [{ name: "unrelated_ids", seq: "77" }], "empty replacement must clear only its three dataset counters");
    assert.equal((await application.createHabit({ habit, resolveDisplayOrderFromStorage: false })).id, 1);
    assert.equal((await fixture.notes.createNote(note(1))).id, 1);
    assert.equal((await application.markDay({ habitId: 1, date: FIXED_TODAY, status: "done", now: FIXED_NOW_MS })).id, 1);

    await replace(high);
    const beforeOrdinaryDelete = sequenceRows();
    await fixture.notes.deleteNote(maximum);
    await application.unmarkDay(maximum, FIXED_TODAY);
    await application.archiveHabit(maximum, FIXED_NOW_MS);
    await application.deleteHabits([maximum]);
    assert.deepEqual(sequenceRows(), beforeOrdinaryDelete, "ordinary delete and archive must retain their existing high-water counters");
  } finally {
    await fixture.runtime.whenIdle();
    fixture.database.close();
  }
}

async function main() {
  await assertScheduleRecordCausality();
  await assertScheduleEquivalence();
  await assertOtherPersistenceProtocols();
  await assertBulkDisplayOrderProtocol();
  assertDisplayOrderProjectionIdentity();
  await assertExactCutoffFence();
  await assertDelayedHabitFenceAdmission();
  await assertSqliteIntegerCapacity();
  await assertConcurrentSqliteCreation();
  await assertDisplayOrderMigration();
  await assertNativeMigrationJournal();
  await assertSqliteReplacementIdentityLifetime();
  await assertLargeSqliteDeletesAreChunked();
  assertOutOfOrderEditablePatchOwnership();
  assertDependencyDirection();
  console.log("Habit persistence audit passed.");
}

async function assertScheduleRecordCausality(): Promise<void> {
  const now = new Date();
  const localDate = (offset: number) => {
    const value = new Date(now);
    value.setDate(value.getDate() + offset);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  };
  const today = localDate(0);
  const tomorrow = localDate(1);
  const yesterday = localDate(-1);
  const deferred = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  };
  const detailSource = readFileSync("src/features/habit-detail/hooks/useHabitDetail.ts", "utf8");
  const renderDetail = (
    store: ReturnType<typeof loadHabitStoreForAudit>["storeModule"]["useHabitStore"],
  ) => {
    const slots: { value?: unknown; current?: unknown; dependencies?: unknown[] }[] = [];
    let cursor = 0;
    let dirty = false;
    let effects: (() => void)[] = [];
    const useState = (initial: unknown) => {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (update: unknown) => {
        const previous = slots[index].value;
        const next = typeof update === "function" ? update(previous) : update;
        if (!Object.is(previous, next)) { slots[index].value = next; dirty = true; }
      }];
    };
    const useRef = (initial: unknown) => {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    };
    const useEffect = (effect: () => void, dependencies: unknown[]) => {
      const index = cursor++;
      const previous = slots[index]?.dependencies;
      if (!previous || previous.length !== dependencies.length ||
        dependencies.some((value, position) => !Object.is(value, previous[position]))) {
        slots[index] = { dependencies };
        effects.push(effect);
      }
    };
    const hook = loadSourceCallableForAudit<typeof import("../src/features/habit-detail/hooks/useHabitDetail").useHabitDetail>(
      detailSource, "useHabitDetail", {
        useState, useRef, useEffect,
        useCallback: (callback: unknown) => callback,
        useMemo: (factory: () => unknown) => factory(),
        useCurrentLocalDate: () => today,
        useHabitStore: Object.assign(
          (select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()),
          { getState: store.getState },
        ),
        getHabitDayRecordsForState: (state: { allDayRecords: DayRecord[] }, habitId: number) =>
          state.allDayRecords.filter((record) => record.habitId === habitId),
        habitsHaveSameVisibleState: loadSourceCallableForAudit(detailSource, "habitsHaveSameVisibleState", { areRepeatSchedulesEqual }),
        calculateStreakStats,
        peekStreakStats: () => null,
        rememberStreakStats: () => {},
      },
    );
    return () => {
      for (let pass = 0; pass < 12; pass += 1) {
        cursor = 0;
        effects = [];
        dirty = false;
        const snapshot = hook(1);
        effects.forEach((effect) => effect());
        if (!dirty) return snapshot;
      }
      throw new Error("Detail projection did not settle");
    };
  };
  const mutation = process.argv.find((argument) => argument.startsWith("--schedule-mutation="))?.split("=")[1];
  const transform = (source: string) => {
    const substitutions: Record<string, [string, string]> = {
      "optimistic-owner": ["if (previewHabit) {", "if (false && previewHabit) {"],
      "predecessor-order": ["await predecessorWrites;", "await Promise.resolve();"],
      "schedule-pin": ["isHabitScheduleWriteRequired(ownership.habitId, ownership.writeSequence)", "false"],
      "destructive-pin": ["retainDestructiveHabitScheduleWrite(ownership.writeSequence);", "void ownership.writeSequence;"],
      "record-rebase": ["const nextAllDayRecords = replaceAllHabitRecords(\n            state.allDayRecords,\n            id,\n            persistedRecords,\n          );", "const nextAllDayRecords = state.allDayRecords;"],
      "durable-validation": ["validateSchedule:\n          scheduleBarrier.hasPendingWrites ||\n          !isHabitScheduleWriteBarrierCurrent(scheduleBarrier)", "validateSchedule: false"],
    };
    if (!mutation) return source;
    assert.ok(substitutions[mutation], "the schedule mutation must be known");
    const [target, replacement] = substitutions[mutation];
    const normalize = (value: string) => value.replace(/\r?\n/g, source.includes("\r\n") ? "\r\n" : "\n");
    assert.equal(source.split(normalize(target)).length - 1, 1, "the schedule mutation target must be unique");
    return source.replace(normalize(target), normalize(replacement));
  };
  const run = async (
    startDate: string,
    test: (context: {
      store: ReturnType<typeof loadHabitStoreForAudit>["storeModule"]["useHabitStore"];
      application: ReturnType<typeof createHabitPersistenceApplication>;
      fixture: ReturnType<typeof loadSqliteRepositoriesForAudit>;
      paints: ReturnType<typeof deferred>[];
    }) => Promise<void>,
  ) => {
    const fixture = loadSqliteRepositoriesForAudit();
    const application = createHabitPersistenceApplication(fixture.habits);
    const paints: ReturnType<typeof deferred>[] = [];
    const loaded = loadHabitStoreForAudit({ habits: [], records: [] }, {
      transform,
      waitForCommitOpportunity: () => paints.shift()?.promise ?? Promise.resolve(),
    });
    Object.assign(loaded.persistence.application, application);
    const { id: _id, ...habit } = createHabitFixture({
      startDate,
      scheduleHistory: [{ effectiveFrom: startDate, startDate, repeatSchedule: { type: "daily" } }],
    });
    await application.createHabit({ habit, resolveDisplayOrderFromStorage: false });
    const store = loaded.storeModule.useHabitStore;
    await store.getState().loadHabits();
    await store.getState().loadAllDayRecords();
    await store.getState().loadDayRecords(today);
    try {
      await test({ store, application: loaded.persistence.application, fixture, paints });
    } finally {
      await fixture.runtime.whenIdle();
      fixture.database.close();
    }
  };

  for (const expanding of [false, true]) {
    await run(expanding ? tomorrow : today, async ({ store, fixture }) => {
      const detail = renderDetail(store);
      detail();
      const entered = deferred();
      const commit = deferred();
      const original = fixture.runtime.transaction;
      let hold = true;
      fixture.runtime.transaction = (task) => original(async (session) => {
        const result = await task(session);
        if (hold) { hold = false; entered.release(); await commit.promise; }
        return result;
      });
      const schedule = store.getState().updateHabit(1, { startDate: expanding ? today : tomorrow });
      await entered.promise;
      const admittedStart = store.getState().habits[0].startDate;
      const mark = store.getState().markDay(1, today, "done");
      const admittedStatus = store.getState().allDayRecords[0]?.status;
      const visible = detail();
      commit.release();
      await schedule;
      assert.equal(admittedStart, expanding ? today : tomorrow,
        "schedule admission must atomically publish the same plan to every consumer before commit");
      if (expanding) {
        assert.equal(admittedStatus, "done",
          "a newly allowed day must accept its optimistic mark before schedule durability");
      }
      assert.equal(visible.habit?.startDate, admittedStart,
        "Detail and Home must render the same admitted schedule version");
      assert.equal(visible.records.some((record) => record.date === today), expanding);
      assert.equal(await mark, expanding);
      assert.equal((await fixture.habits.readDayRecordsForHabit(1)).length, Number(expanding));
      assert.equal(store.getState().allDayRecords.length, Number(expanding));
    });
  }

  await run(yesterday, async ({ store, fixture, paints }) => {
    const paint = deferred();
    paints.push(paint);
    const mark = store.getState().markDay(1, today, "done");
    const isoWeekday = now.getDay() === 0 ? 7 : now.getDay();
    const schedule = store.getState().updateHabit(1, { repeatSchedule: { type: "weekdays", days: [isoWeekday] } });
    paint.release();
    assert.equal(await mark, true);
    await schedule;
    const durable = await fixture.habits.readHabit(1);
    assert.equal(durable?.scheduleHistory?.at(-1)?.effectiveFrom, tomorrow,
      "a previously admitted same-day mark must retain the tomorrow history boundary despite delayed paint");
  });

  await run(tomorrow, async ({ store, application, fixture, paints }) => {
    const paint = deferred();
    paints.push(paint);
    const first = store.getState().updateHabit(1, { startDate: today });
    const mark = store.getState().markDay(1, today, "done");
    const second = store.getState().updateHabit(1, { startDate: yesterday });
    paint.release();
    await Promise.all([first, second]);
    assert.equal(await mark, true, "a dependent mark must pin its accepted schedule version across a newer edit");
    assert.equal((await fixture.habits.readDayRecordsForHabit(1))[0]?.date, today);
    assert.equal((await application.readHabit(1))?.startDate, yesterday);
  });

  await run(tomorrow, async ({ store, application, paints }) => {
    let writes = 0;
    const persist = application.persistScheduleEdit;
    application.persistScheduleEdit = (input) => { writes += 1; return persist(input); };
    const paint = deferred();
    paints.push(paint);
    const first = store.getState().updateHabit(1, { startDate: today });
    const second = store.getState().updateHabit(1, { startDate: yesterday });
    paint.release();
    await Promise.all([first, second]);
    assert.equal(writes, 1, "an unused superseded schedule must still coalesce");
    await store.getState().updateHabit(1, { startDate: today, description: "Practice" });
    assert.equal(store.getState().habits[0].description, "Practice",
      "partitioned mixed edits must not wait on their own parent command");
  });

  for (const failFirst of [false, true]) {
    await run(today, async ({ store, fixture, paints }) => {
      await store.getState().markDay(1, today, "failure", "Practice reason");
      await fixture.notes.createNote({
        habitId: 1,
        date: today,
        text: "Practice entry",
        isFailureReason: false,
        reasonType: null,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      });
      if (failFirst) {
        fixture.database.exec(`CREATE TRIGGER reject_first_schedule BEFORE UPDATE OF start_date ON habits WHEN NEW.start_date = '${tomorrow}' BEGIN SELECT RAISE(ABORT, 'First schedule rejected'); END`);
      }
      const paint = deferred();
      paints.push(paint);
      const first = store.getState().updateHabit(1, { startDate: tomorrow });
      const firstOutcome = first.then(() => null, (error: unknown) => error);
      const second = store.getState().updateHabit(1, { startDate: today });
      paint.release();
      await second;
      assert.equal((await firstOutcome) instanceof Error, failFirst);
      const durableRecords = await fixture.habits.readDayRecordsForHabit(1);
      assert.equal(durableRecords.length, Number(failFirst),
        "accepted destructive edits must persist before a reversal; failed edits must not delete history");
      assert.deepEqual(store.getState().allDayRecords.map((record) => record.date), durableRecords.map((record) => record.date),
        "a no-op successor must rebase records after its predecessor fails");
      assert.equal(store.getState().dayRecords.length, durableRecords.length);
      const notes = await fixture.notes.getNotesForHabit(1);
      assert.equal(notes.filter((note) => note.reasonType === "failure").length, Number(failFirst));
      assert.equal(notes.filter((note) => note.reasonType == null).length, 1,
        "schedule pruning must preserve ordinary notes across both commit and rollback");
    });
  }

  await run(today, async ({ store, fixture, paints }) => {
    await store.getState().markDay(1, today, "done");
    store.setState({ allDayRecords: [], allDayRecordsLoaded: false });
    const paint = deferred();
    paints.push(paint);
    const first = store.getState().updateHabit(1, { startDate: tomorrow });
    const second = store.getState().updateHabit(1, { startDate: today });
    paint.release();
    await Promise.all([first, second]);
    assert.equal((await fixture.habits.readDayRecordsForHabit(1)).length, 0,
      "incomplete history cannot establish that a superseded schedule is non-destructive");
  });

  await run(today, async ({ store, fixture, paints }) => {
    await store.getState().markDay(1, today, "failure", "Initial reason");
    const previousId = (await fixture.habits.readDayRecordsForHabit(1))[0].id;
    const paint = deferred();
    paints.push(paint);
    const first = store.getState().updateHabit(1, { startDate: tomorrow });
    const second = store.getState().updateHabit(1, { startDate: today });
    const mark = store.getState().markDay(1, today, "minimum");
    paint.release();
    await Promise.all([first, second]);
    assert.equal(await mark, true);
    const persisted = await fixture.habits.readDayRecordsForHabit(1);
    assert.equal(persisted[0]?.status, "minimum");
    assert.notEqual(persisted[0]?.id, previousId,
      "a later explicit mark is a new record, not restoration of the pruned record");
    assert.equal(store.getState().allDayRecords[0]?.status, "minimum",
      "an older prune acknowledgement must preserve a newer accepted mark overlay");
    assert.equal((await fixture.notes.getNotesForHabit(1)).length, 0);
  });

  await run(yesterday, async ({ store, fixture, paints }) => {
    await store.getState().markDay(1, today, "done");
    const paint = deferred();
    paints.push(paint);
    const isoWeekday = now.getDay() === 0 ? 7 : now.getDay();
    const schedule = store.getState().updateHabit(1, { repeatSchedule: { type: "weekdays", days: [isoWeekday] } });
    const unmark = store.getState().unmarkDay(1, today);
    paint.release();
    await schedule;
    assert.equal(await unmark, true);
    assert.equal((await fixture.habits.readHabit(1))?.scheduleHistory?.at(-1)?.effectiveFrom, tomorrow,
      "a later unmark must not rewrite the history boundary already accepted by a repeat edit");
    assert.equal((await fixture.habits.readDayRecordsForHabit(1)).length, 0);
    assert.equal(store.getState().allDayRecords.length, 0);
  });

  for (const originalStart of [tomorrow, yesterday]) {
    await run(originalStart, async ({ store, fixture, paints }) => {
      const detail = renderDetail(store);
      detail();
      if (originalStart === yesterday) {
        await store.getState().markDay(1, yesterday, "done");
      }
      fixture.database.exec("CREATE TRIGGER reject_schedule BEFORE UPDATE OF start_date ON habits BEGIN SELECT RAISE(ABORT, 'Schedule rejected'); END");
      const paint = deferred();
      paints.push(paint);
      const schedule = store.getState().updateHabit(1, { startDate: today });
      const failure = schedule.then(() => null, (error: unknown) => error);
      const mark = store.getState().markDay(1, today, "done");
      assert.equal(detail().records.some((record) => record.date === today), true);
      paint.release();
      assert.ok((await failure) instanceof Error);
      assert.equal(await mark, originalStart === yesterday,
        "a dependent mark must be rejected when schedule rollback revokes its day");
      const expectedDates = originalStart === yesterday ? [yesterday, today] : [];
      assert.deepEqual(store.getState().allDayRecords.map((record) => record.date).sort(), expectedDates,
        "schedule failure must reconcile its own pruning without losing a newer valid mark or retaining an invalid one");
      assert.deepEqual((await fixture.habits.readDayRecordsForHabit(1)).map((record) => record.date).sort(), expectedDates);
      assert.equal(store.getState().habits[0].startDate, originalStart);
      assert.deepEqual(detail().records.map((record) => record.date).sort(), expectedDates,
        "a failed dependent mark must leave no private Detail phantom after rollback");
      assert.equal(store.getState().dayRecords.some((record) => record.date === today), originalStart === yesterday,
        "rejected marks must also leave the current date projection without a phantom completion");
    });
  }

  await run(tomorrow, async ({ application, fixture }) => {
    await assert.rejects(application.markDay({ habitId: 1, date: today, status: "failure", reason: "Practice", now: now.getTime(), validateSchedule: true }),
      /no longer available/);
    assert.equal((await fixture.notes.getNotesForHabit(1)).length, 0,
      "durable schedule rejection must not leave a reason note");
  });

  await run(tomorrow, async ({ store, fixture }) => {
    const imported = normalizeImportData(buildExportJsonFromRows({
      ...await fixture.transfers.readConsistentSnapshot(),
      exportedAt: now.toISOString(),
    }));
    const fence = capturePendingHabitWriteFence();
    const schedule = store.getState().updateHabit(1, { startDate: today });
    const mark = store.getState().markDay(1, today, "done");
    try {
      await waitForPendingHabitWritesThrough(fence);
      await fixture.transfers.replaceAndVerify(imported, (rows) => verifyRestoredImportRows(imported, rows));
      store.getState().resetInMemoryCaches();
      await store.getState().loadHabits({ mode: "committed-import" });
      await store.getState().loadAllDayRecords();
    } finally {
      releasePendingHabitWriteFence(fence, { discardPostFence: true });
    }
    await schedule;
    assert.equal(await mark, false);
    assert.equal(store.getState().habits[0].startDate, tomorrow);
    assert.equal(store.getState().allDayRecords.length, 0,
      "an imported same identity must not inherit a dependent old-generation mark");
    assert.equal(captureHabitScheduleWriteBarrier(1).hasPendingWrites, false);
    assert.equal(captureHabitScheduleWriteBarrier(1).revision, 0,
      "replacement must retire schedule revision metadata");
  });

  await run(tomorrow, async ({ store }) => {
    await store.getState().updateHabit(1, { startDate: today });
    assert.ok(captureHabitScheduleWriteBarrier(1).revision > 0);
    await store.getState().deleteHabit(1);
    assert.equal(captureHabitScheduleWriteBarrier(1).revision, 0,
      "permanent deletion must retire schedule revision metadata");
  });
}

let persistenceDeadline: ReturnType<typeof setTimeout>;
const persistenceTimeout = new Promise<never>((_, reject) => {
  persistenceDeadline = setTimeout(() => reject(new Error("Habit persistence audit deadline")), 15000);
});
void Promise.race([main(), persistenceTimeout]).then(
  () => clearTimeout(persistenceDeadline),
  (error) => {
    clearTimeout(persistenceDeadline);
    console.error(error);
    process.exitCode = 1;
  },
);
