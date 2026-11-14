import type {
  DayRecordRow,
  HabitRow,
  NoteRow,
  SettingRow,
} from "./schema";

type RawHabitDatabaseRow = {
  id: number;
  name: string;
  description: string | null;
  description_visible: number;
  repeat_type: HabitRow["repeatType"];
  repeat_config: string;
  start_date: string;
  reminder_enabled: number;
  reminder_time: string | null;
  display_order: number;
  is_archived: number;
  archived_at: number | null;
  archive_history: string;
  created_at: number;
  updated_at: number;
};

type RawDayRecordDatabaseRow = {
  id: number;
  habit_id: number;
  date: string;
  status: DayRecordRow["status"];
  created_at: number;
  updated_at: number;
};

type RawNoteDatabaseRow = {
  id: number;
  habit_id: number;
  date: string;
  text: string;
  is_failure_reason: number;
  reason_type: NoteRow["reasonType"];
  created_at: number;
  updated_at: number;
};

export type RawSettingDatabaseRow = SettingRow;

export const HABIT_COLUMNS = `
  id, name, description, description_visible, repeat_type, repeat_config,
  start_date, reminder_enabled, reminder_time, display_order, is_archived,
  archived_at, archive_history, created_at, updated_at
`;

export const DAY_RECORD_COLUMNS = `
  id, habit_id, date, status, created_at, updated_at
`;

export const NOTE_COLUMNS = `
  id, habit_id, date, text, is_failure_reason, reason_type, created_at, updated_at
`;

function parseRequiredJson<T>(value: string, field: string, rowId: number): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Invalid ${field} JSON in habit ${rowId}`, {
      cause: error,
    });
  }
}

export function mapHabitDatabaseRow(row: RawHabitDatabaseRow): HabitRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    descriptionVisible: row.description_visible !== 0,
    repeatType: row.repeat_type,
    repeatConfig: parseRequiredJson<Record<string, unknown>>(
      row.repeat_config,
      "repeat_config",
      row.id
    ),
    startDate: row.start_date,
    reminderEnabled: row.reminder_enabled !== 0,
    reminderTime: row.reminder_time,
    displayOrder: row.display_order,
    isArchived: row.is_archived !== 0,
    archivedAt:
      row.archived_at == null ? null : new Date(row.archived_at),
    archiveHistory: parseRequiredJson<HabitRow["archiveHistory"]>(
      row.archive_history,
      "archive_history",
      row.id
    ),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapDayRecordDatabaseRow(
  row: RawDayRecordDatabaseRow
): DayRecordRow {
  return {
    id: row.id,
    habitId: row.habit_id,
    date: row.date,
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function mapNoteDatabaseRow(row: RawNoteDatabaseRow): NoteRow {
  return {
    id: row.id,
    habitId: row.habit_id,
    date: row.date,
    text: row.text,
    isFailureReason: row.is_failure_reason !== 0,
    reasonType: row.reason_type,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export type { RawHabitDatabaseRow, RawDayRecordDatabaseRow, RawNoteDatabaseRow };
