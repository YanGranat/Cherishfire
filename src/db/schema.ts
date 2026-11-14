import { sql } from "drizzle-orm";
import { sqliteTable, integer, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ArchivePeriod } from "@/types/habit";

// Habit entity - central entity for all tracking
export const habits = sqliteTable(
  "habits",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    descriptionVisible: integer("description_visible", { mode: "boolean" })
      .notNull()
      .default(true),
    repeatType: text("repeat_type", {
      enum: ["daily", "weekdays", "monthly", "interval"],
    }).notNull(),
    repeatConfig: text("repeat_config", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>(),
    startDate: text("start_date").notNull(), // ISO YYYY-MM-DD
    reminderEnabled: integer("reminder_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    reminderTime: text("reminder_time"), // HH:MM | JSON array of HH:MM | null
    displayOrder: integer("display_order").notNull(),
    isArchived: integer("is_archived", { mode: "boolean" })
      .notNull()
      .default(false),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    archiveHistory: text("archive_history", { mode: "json" })
      .notNull()
      .$type<ArchivePeriod[]>()
      .default(sql`'[]'`),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    archivedIdx: index("idx_habits_archived").on(table.isArchived),
    orderIdx: index("idx_habits_order").on(table.displayOrder),
  })
);

// Day record - one per habit per day, absence = unmarked
export const dayRecords = sqliteTable(
  "day_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    habitId: integer("habit_id")
      .notNull()
      .references(() => habits.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // ISO YYYY-MM-DD
    status: text("status", {
      enum: ["done", "minimum", "maximum", "skipped", "failure"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    habitDateUnique: uniqueIndex("idx_records_habit_date").on(
      table.habitId,
      table.date
    ),
    dateIdx: index("idx_records_date").on(table.date),
  })
);

// Note - text entries linked to a habit
export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    habitId: integer("habit_id")
      .notNull()
      .references(() => habits.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // ISO YYYY-MM-DD
    text: text("text").notNull(),
    isFailureReason: integer("is_failure_reason", { mode: "boolean" })
      .notNull()
      .default(false),
    reasonType: text("reason_type", { enum: ["failure", "skipped"] }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    habitDateIdx: index("idx_notes_habit_date").on(table.habitId, table.date),
  })
);

// Settings - key-value store for app preferences
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON-encoded
});

// Inferred types for use in application code
export type HabitRow = typeof habits.$inferSelect;
export type NewHabitRow = typeof habits.$inferInsert;
export type DayRecordRow = typeof dayRecords.$inferSelect;
export type NewDayRecordRow = typeof dayRecords.$inferInsert;
export type NoteRow = typeof notes.$inferSelect;
export type NewNoteRow = typeof notes.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
