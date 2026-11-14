import type { SQLiteBindValue } from "expo-sqlite";
import {
  runtimeDb,
  type AsyncDatabaseExecutor,
} from "@/db/runtime";
import {
  DAY_RECORD_COLUMNS,
  HABIT_COLUMNS,
  mapHabitDatabaseRow,
  type RawDayRecordDatabaseRow,
  type RawHabitDatabaseRow,
} from "@/db/rows";
import type { HabitRow } from "@/db/schema";
import type { DayRecord, DayStatus, Habit } from "@/types/habit";
import {
  fromRepeatSchedule,
  toRepeatSchedule,
  toScheduleHistory,
} from "@/types/habit";
import { normalizeArchiveHistory } from "@/domain/habits/archive-periods";
import type {
  HabitPatch,
  HabitPersistenceRepository,
  HabitPersistenceSession,
  NewPersistedHabit,
  PersistedReasonNote,
} from "@/application/habits/habit-persistence";
import { deleteSqliteRowsByValues } from "@/data/sqlite/chunked-delete";
import { patchHabitDisplayOrders } from "@/data/sqlite/bulk-display-order-update";
import { generatedIdCapacitySql } from "@/data/sqlite/generated-id-capacity";
import { assertValidDisplayOrder } from "@/domain/habits/display-order";

type HabitStoragePatch = Partial<{
  name: string;
  description: string | null;
  descriptionVisible: boolean;
  repeatType: HabitRow["repeatType"];
  repeatConfig: Record<string, unknown>;
  startDate: string;
  reminderEnabled: boolean;
  reminderTime: string | null;
  displayOrder: number;
  isArchived: boolean;
  archivedAt: number | null;
  archiveHistory: HabitRow["archiveHistory"];
  updatedAt: number;
}>;

const HABIT_PATCH_COLUMNS: Record<keyof HabitStoragePatch, string> = {
  name: "name",
  description: "description",
  descriptionVisible: "description_visible",
  repeatType: "repeat_type",
  repeatConfig: "repeat_config",
  startDate: "start_date",
  reminderEnabled: "reminder_enabled",
  reminderTime: "reminder_time",
  displayOrder: "display_order",
  isArchived: "is_archived",
  archivedAt: "archived_at",
  archiveHistory: "archive_history",
  updatedAt: "updated_at",
};

function toStoragePatch(patch: HabitPatch): HabitStoragePatch {
  const { schedule, ...fields } = patch;
  if (!schedule) return fields;
  const { repeatType, repeatConfig } = fromRepeatSchedule(
    schedule.repeatSchedule,
    schedule.scheduleHistory,
  );
  return {
    ...fields,
    repeatType: repeatType as HabitStoragePatch["repeatType"],
    repeatConfig,
    startDate: schedule.startDate,
  };
}

function toDatabaseValue(
  key: keyof HabitStoragePatch,
  value: HabitStoragePatch[keyof HabitStoragePatch],
): SQLiteBindValue {
  if (
    key === "descriptionVisible" ||
    key === "reminderEnabled" ||
    key === "isArchived"
  ) {
    return value ? 1 : 0;
  }
  if (key === "repeatConfig" || key === "archiveHistory") {
    return JSON.stringify(value);
  }
  return value as SQLiteBindValue;
}

function mapHabitPersistenceRow(row: HabitRow): Habit {
  const repeatConfig = row.repeatConfig as Record<string, unknown>;
  const repeatSchedule = toRepeatSchedule(row.repeatType, repeatConfig);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    descriptionVisible: row.descriptionVisible,
    repeatSchedule,
    scheduleHistory: toScheduleHistory(
      repeatConfig,
      repeatSchedule,
      row.startDate,
    ),
    startDate: row.startDate,
    reminderEnabled: row.reminderEnabled,
    reminderTime: row.reminderTime,
    displayOrder: row.displayOrder,
    isArchived: row.isArchived,
    archivedAt: row.archivedAt == null ? null : row.archivedAt.getTime(),
    archiveHistory: normalizeArchiveHistory(row.archiveHistory),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function mapRawHabitRow(row: RawHabitDatabaseRow): Habit {
  return mapHabitPersistenceRow(mapHabitDatabaseRow(row));
}

function mapRawDayRecordRow(row: RawDayRecordDatabaseRow): DayRecord {
  return {
    id: row.id,
    habitId: row.habit_id,
    date: row.date,
    status: row.status as DayStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readHabit(
  executor: AsyncDatabaseExecutor,
  habitId: number,
): Promise<Habit | null> {
  const row = await executor.getFirst<RawHabitDatabaseRow>(
    `SELECT ${HABIT_COLUMNS} FROM habits WHERE id = ? LIMIT 1`,
    [habitId],
  );
  return row ? mapRawHabitRow(row) : null;
}

async function readDayRecordsForHabitOrderedByDate(
  executor: AsyncDatabaseExecutor,
  habitId: number,
): Promise<DayRecord[]> {
  const rows = await executor.getAll<RawDayRecordDatabaseRow>(
    `SELECT ${DAY_RECORD_COLUMNS}
     FROM day_records
     WHERE habit_id = ?
     ORDER BY date ASC`,
    [habitId],
  );
  return rows.map(mapRawDayRecordRow);
}

async function patchHabit(
  executor: AsyncDatabaseExecutor,
  habitId: number,
  patch: HabitPatch,
): Promise<void> {
  const storagePatch = toStoragePatch(patch);
  if (storagePatch.displayOrder !== undefined) {
    assertValidDisplayOrder(storagePatch.displayOrder);
  }
  const entries = Object.entries(storagePatch) as [
    keyof HabitStoragePatch,
    HabitStoragePatch[keyof HabitStoragePatch],
  ][];
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${HABIT_PATCH_COLUMNS[key]} = ?`);
  const values = entries.map(([key, value]) => toDatabaseValue(key, value));
  await executor.run(
    `UPDATE habits SET ${assignments.join(", ")} WHERE id = ?`,
    [...values, habitId],
  );
}

async function deleteIdsInChunks(
  executor: AsyncDatabaseExecutor,
  table: "day_records" | "notes",
  ids: readonly number[],
): Promise<void> {
  await deleteSqliteRowsByValues(executor, { table, column: "id" }, ids);
}

async function upsertDayRecord(
  executor: AsyncDatabaseExecutor,
  input: {
    habitId: number;
    date: string;
    status: DayStatus;
    createdAt: number;
    updatedAt: number;
  },
): Promise<DayRecord> {
  const rawPersisted = await executor.getFirst<RawDayRecordDatabaseRow>(
    `WITH existing AS (
       SELECT id FROM day_records WHERE habit_id = ? AND date = ?
     )
     INSERT INTO day_records (
       id, habit_id, date, status, created_at, updated_at
     )
     SELECT (SELECT id FROM existing), ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM existing)
       OR ${generatedIdCapacitySql("day_records")}
     ON CONFLICT(habit_id, date) DO UPDATE SET
       status = excluded.status,
       updated_at = excluded.updated_at
     RETURNING ${DAY_RECORD_COLUMNS}`,
    [
      input.habitId,
      input.date,
      input.habitId,
      input.date,
      input.status,
      input.createdAt,
      input.updatedAt,
    ],
  );
  if (!rawPersisted) {
    throw new Error("Day record upsert returned no row");
  }
  return mapRawDayRecordRow(rawPersisted);
}

function createSqliteHabitSession(
  executor: AsyncDatabaseExecutor,
): HabitPersistenceSession {
  return {
    readHabit: (habitId) => readHabit(executor, habitId),
    readDayRecordsForHabitOrderedByDate: (habitId) =>
      readDayRecordsForHabitOrderedByDate(executor, habitId),
    async readArchivedDisplayOrders() {
      return executor.getAll<{ id: number; displayOrder: number }>(
        `SELECT id, display_order AS displayOrder
         FROM habits
         WHERE is_archived = 1`,
      );
    },
    patchHabit: (habitId, patch) => patchHabit(executor, habitId, patch),
    patchHabitDisplayOrders: (assignments) =>
      patchHabitDisplayOrders(executor, assignments),
    deleteDayRecordsByIds: (recordIds) =>
      deleteIdsInChunks(executor, "day_records", recordIds),
    async deleteReasonNotesForDates(habitId, dates) {
      const reasonRows = await executor.getAll<{ id: number; date: string }>(
        `SELECT id, date
         FROM notes
         WHERE habit_id = ?
           AND (is_failure_reason = 1 OR reason_type IN ('failure', 'skipped'))`,
        [habitId],
      );
      const removedReasonIds = reasonRows
        .filter((note) => dates.has(note.date))
        .map((note) => note.id);
      await deleteIdsInChunks(executor, "notes", removedReasonIds);
    },
    async deleteSettingsByKeys(keys) {
      await deleteSqliteRowsByValues(
        executor,
        { table: "settings", column: "key" },
        keys,
      );
    },
    async deleteHabitsByIds(habitIds) {
      await deleteSqliteRowsByValues(
        executor,
        { table: "habits", column: "id" },
        habitIds,
      );
    },
    upsertDayRecord: (input) => upsertDayRecord(executor, input),
    async insertReasonNote(note: PersistedReasonNote) {
      const result = await executor.run(
        `INSERT INTO notes (
           habit_id, date, text, is_failure_reason, reason_type,
           created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE ${generatedIdCapacitySql("notes")}`,
        [
          note.habitId,
          note.date,
          note.text,
          note.isFailureReason ? 1 : 0,
          note.reasonType,
          note.createdAt,
          note.updatedAt,
        ],
      );
      if (result.changes !== 1) {
        throw new Error("Note identity capacity exhausted");
      }
    },
  };
}

const directSession = createSqliteHabitSession(runtimeDb);

export const sqliteHabitRepository: HabitPersistenceRepository = {
  ...directSession,
  transaction<T>(task: (session: HabitPersistenceSession) => Promise<T>) {
    return runtimeDb.transaction((executor) =>
      task(createSqliteHabitSession(executor)),
    );
  },
  async readAllHabits() {
    const rows = await runtimeDb.getAll<RawHabitDatabaseRow>(
      `SELECT ${HABIT_COLUMNS}
       FROM habits
       ORDER BY display_order ASC, id ASC`,
    );
    return rows.map(mapRawHabitRow);
  },
  async readDayRecordsForHabit(habitId) {
    const rows = await runtimeDb.getAll<RawDayRecordDatabaseRow>(
      `SELECT ${DAY_RECORD_COLUMNS} FROM day_records WHERE habit_id = ?`,
      [habitId],
    );
    return rows.map(mapRawDayRecordRow);
  },
  async readAllDayRecords() {
    const rows = await runtimeDb.getAll<RawDayRecordDatabaseRow>(
      `SELECT ${DAY_RECORD_COLUMNS} FROM day_records`,
    );
    return rows.map(mapRawDayRecordRow);
  },
  async readDayRecordsInDateRange(startDate, endDate) {
    const rows = await runtimeDb.getAll<RawDayRecordDatabaseRow>(
      `SELECT ${DAY_RECORD_COLUMNS}
       FROM day_records
       WHERE date >= ? AND date <= ?`,
      [startDate, endDate],
    );
    return rows.map(mapRawDayRecordRow);
  },
  async readMaxDisplayOrder() {
    const row = await runtimeDb.getFirst<{ value: number | null }>(
      "SELECT MAX(display_order) AS value FROM habits",
    );
    return row?.value ?? null;
  },
  async insertHabit(habit: NewPersistedHabit) {
    assertValidDisplayOrder(habit.displayOrder);
    const { repeatType, repeatConfig } = fromRepeatSchedule(
      habit.repeatSchedule,
      habit.scheduleHistory,
    );
    const rawRow = await runtimeDb.getFirst<RawHabitDatabaseRow>(
      `INSERT INTO habits (
         name, description, description_visible, repeat_type, repeat_config,
         start_date, reminder_enabled, reminder_time, display_order,
         is_archived, archived_at, archive_history, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${generatedIdCapacitySql("habits")}
       RETURNING ${HABIT_COLUMNS}`,
      [
        habit.name,
        habit.description,
        habit.descriptionVisible ? 1 : 0,
        repeatType,
        JSON.stringify(repeatConfig),
        habit.startDate,
        habit.reminderEnabled ? 1 : 0,
        habit.reminderTime,
        habit.displayOrder,
        habit.isArchived ? 1 : 0,
        habit.archivedAt,
        JSON.stringify(habit.archiveHistory),
        habit.createdAt,
        habit.updatedAt,
      ],
    );
    if (!rawRow) throw new Error("Habit insert returned no row");
    return mapRawHabitRow(rawRow);
  },
  async deleteDayRecord(habitId, date) {
    await runtimeDb.run(
      "DELETE FROM day_records WHERE habit_id = ? AND date = ?",
      [habitId, date],
    );
  },
};
