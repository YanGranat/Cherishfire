import type { ArchivePeriod } from "@/types/habit";

export interface ExportIntegrity {
  habits_count: number;
  archived_habits_count: number;
  day_records_count: number;
  notes_count: number;
  settings_count: number;
  day_records_by_date: Record<string, number>;
  notes_by_date: Record<string, number>;
  habits_signature: string;
  day_records_signature: string;
  notes_signature: string;
  settings_signature: string;
  day_records_date_signatures: Record<string, string>;
  notes_date_signatures: Record<string, string>;
}

export interface ExportData {
  version: number;
  exported_at: string;
  habits: unknown[];
  day_records: unknown[];
  notes: unknown[];
  settings: unknown[];
  integrity: ExportIntegrity;
}

export interface ExportedHabitRow {
  id: number;
  name: string;
  description: string | null;
  descriptionVisible: boolean;
  repeatType: "daily" | "weekdays" | "monthly" | "interval";
  repeatConfig: Record<string, unknown>;
  startDate: string;
  reminderEnabled: boolean;
  reminderTime: string | null;
  displayOrder: number;
  isArchived: boolean;
  archivedAt: Date | null;
  archiveHistory: ArchivePeriod[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportedDayRecordRow {
  id: number;
  habitId: number;
  date: string;
  status: "done" | "minimum" | "maximum" | "skipped" | "failure";
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportedNoteRow {
  id: number;
  habitId: number;
  date: string;
  text: string;
  isFailureReason: boolean;
  reasonType: "failure" | "skipped" | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportedSettingRow {
  key: string;
  value: string;
}

export interface NormalizedImportData {
  version: number;
  habits: ExportedHabitRow[];
  day_records: ExportedDayRecordRow[];
  notes: ExportedNoteRow[];
  settings: ExportedSettingRow[];
  integrity: ExportIntegrity;
}

export interface DataTransferRows {
  habits: ExportedHabitRow[];
  dayRecords: ExportedDayRecordRow[];
  notes: ExportedNoteRow[];
  settings: ExportedSettingRow[];
}
