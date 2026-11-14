import type { SQLiteBindValue } from "expo-sqlite";

import type { DataTransferRepository } from "@/application/data-transfer/data-transfer-repository-port";
import type { DataTransferRows } from "@/application/data-transfer/data-transfer-model";
import {
  DAY_RECORD_COLUMNS,
  HABIT_COLUMNS,
  NOTE_COLUMNS,
  mapDayRecordDatabaseRow,
  mapHabitDatabaseRow,
  mapNoteDatabaseRow,
  type RawDayRecordDatabaseRow,
  type RawHabitDatabaseRow,
  type RawNoteDatabaseRow,
  type RawSettingDatabaseRow,
} from "@/db/rows";
import { runtimeDb, type AsyncDatabaseExecutor } from "@/db/runtime";

const IMPORT_INSERT_CHUNK_SIZE = 50;

async function insertRowsInChunks<T>(
  tx: AsyncDatabaseExecutor,
  table: "habits" | "day_records" | "notes" | "settings",
  columns: readonly string[],
  rows: readonly T[],
  toValues: (row: T) => SQLiteBindValue[],
  chunkSize = IMPORT_INSERT_CHUNK_SIZE,
): Promise<void> {
  if (rows.length === 0) return;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
    await tx.run(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${chunk
        .map(() => rowPlaceholder)
        .join(", ")}`,
      chunk.flatMap(toValues),
    );
  }
}

async function readRows(tx: AsyncDatabaseExecutor): Promise<DataTransferRows> {
  const rawHabits = await tx.getAll<RawHabitDatabaseRow>(
    `SELECT ${HABIT_COLUMNS} FROM habits`,
  );
  const rawRecords = await tx.getAll<RawDayRecordDatabaseRow>(
    `SELECT ${DAY_RECORD_COLUMNS} FROM day_records`,
  );
  const rawNotes = await tx.getAll<RawNoteDatabaseRow>(
    `SELECT ${NOTE_COLUMNS} FROM notes`,
  );
  const settings = await tx.getAll<RawSettingDatabaseRow>(
    "SELECT key, value FROM settings",
  );
  return {
    habits: rawHabits.map(mapHabitDatabaseRow),
    dayRecords: rawRecords.map(mapDayRecordDatabaseRow),
    notes: rawNotes.map(mapNoteDatabaseRow),
    settings,
  };
}

export const sqliteDataTransferRepository: DataTransferRepository = {
  readConsistentSnapshot: () => runtimeDb.transaction(readRows),

  replaceAndVerify(data, verifyRestoredRows) {
    return runtimeDb.transaction(async (tx) => {
      await tx.run("DELETE FROM day_records");
      await tx.run("DELETE FROM notes");
      await tx.run("DELETE FROM habits");
      await tx.run("DELETE FROM settings");
      await tx.run(
        "DELETE FROM sqlite_sequence WHERE name IN ('habits', 'day_records', 'notes')",
      );

      await insertRowsInChunks(
        tx,
        "habits",
        [
          "id",
          "name",
          "description",
          "description_visible",
          "repeat_type",
          "repeat_config",
          "start_date",
          "reminder_enabled",
          "reminder_time",
          "display_order",
          "is_archived",
          "archived_at",
          "archive_history",
          "created_at",
          "updated_at",
        ],
        data.habits,
        (row) => [
          row.id,
          row.name,
          row.description,
          row.descriptionVisible ? 1 : 0,
          row.repeatType,
          JSON.stringify(row.repeatConfig),
          row.startDate,
          row.reminderEnabled ? 1 : 0,
          row.reminderTime,
          row.displayOrder,
          row.isArchived ? 1 : 0,
          row.archivedAt?.getTime() ?? null,
          JSON.stringify(row.archiveHistory),
          row.createdAt.getTime(),
          row.updatedAt.getTime(),
        ],
      );
      await insertRowsInChunks(
        tx,
        "day_records",
        ["id", "habit_id", "date", "status", "created_at", "updated_at"],
        data.day_records,
        (row) => [
          row.id,
          row.habitId,
          row.date,
          row.status,
          row.createdAt.getTime(),
          row.updatedAt.getTime(),
        ],
      );
      await insertRowsInChunks(
        tx,
        "notes",
        [
          "id",
          "habit_id",
          "date",
          "text",
          "is_failure_reason",
          "reason_type",
          "created_at",
          "updated_at",
        ],
        data.notes,
        (row) => [
          row.id,
          row.habitId,
          row.date,
          row.text,
          row.isFailureReason ? 1 : 0,
          row.reasonType,
          row.createdAt.getTime(),
          row.updatedAt.getTime(),
        ],
      );
      await insertRowsInChunks(
        tx,
        "settings",
        ["key", "value"],
        data.settings,
        (row) => [row.key, row.value],
      );

      // Verification runs inside the same transaction; any mismatch throws
      // before commit and restores the complete previous dataset.
      verifyRestoredRows(await readRows(tx));
    });
  },
};
