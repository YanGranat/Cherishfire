import { runtimeDb } from "@/db/runtime";
import {
  mapNoteDatabaseRow,
  NOTE_COLUMNS,
  type RawNoteDatabaseRow,
} from "@/db/rows";
import type {
  NewNoteRecord,
  NoteRepository,
} from "@/application/notes/note-repository";
import type { Note } from "@/types/note";
import { generatedIdCapacitySql } from "@/data/sqlite/generated-id-capacity";

function mapNoteRow(row: RawNoteDatabaseRow): Note {
  const mapped = mapNoteDatabaseRow(row);
  return {
    id: mapped.id,
    habitId: mapped.habitId,
    date: mapped.date,
    text: mapped.text,
    isFailureReason: mapped.isFailureReason,
    reasonType: mapped.reasonType,
    createdAt: mapped.createdAt.getTime(),
    updatedAt: mapped.updatedAt.getTime(),
  };
}

async function getNotesForHabit(habitId: number): Promise<Note[]> {
  const rows = await runtimeDb.getAll<RawNoteDatabaseRow>(
    `SELECT ${NOTE_COLUMNS}
     FROM notes
     WHERE habit_id = ?
     ORDER BY date ASC, created_at ASC`,
    [habitId],
  );
  return rows.map(mapNoteRow);
}

/**
 * Notes needs this fallback only when the in-memory habit index has not loaded
 * yet. Keeping the lookup here prevents the route from owning SQLite details.
 */
async function doesHabitExist(habitId: number): Promise<boolean> {
  const row = await runtimeDb.getFirst<{ id: number }>(
    "SELECT id FROM habits WHERE id = ? LIMIT 1",
    [habitId],
  );
  return row != null;
}

async function createNote(record: NewNoteRecord): Promise<Note> {
  const row = await runtimeDb.getFirst<{ id: number }>(
    `INSERT INTO notes (
       habit_id, date, text, is_failure_reason, reason_type,
       created_at, updated_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE ${generatedIdCapacitySql("notes")}
     RETURNING id`,
    [
      record.habitId,
      record.date,
      record.text,
      record.isFailureReason ? 1 : 0,
      record.reasonType,
      record.createdAt,
      record.updatedAt,
    ],
  );
  if (!row) throw new Error("Note insert returned no row");
  return { ...record, id: row.id };
}

async function updateNoteText(
  noteId: number,
  text: string,
  updatedAt: number,
): Promise<void> {
  await runtimeDb.run(
    "UPDATE notes SET text = ?, updated_at = ? WHERE id = ?",
    [text, updatedAt, noteId],
  );
}

async function deleteNote(noteId: number): Promise<void> {
  await runtimeDb.run("DELETE FROM notes WHERE id = ?", [noteId]);
}

export const sqliteNoteRepository: NoteRepository = {
  getNotesForHabit,
  doesHabitExist,
  createNote,
  updateNoteText,
  deleteNote,
};
