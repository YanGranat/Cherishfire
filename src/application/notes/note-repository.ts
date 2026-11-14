import type { Note } from "@/types/note";

export type NewNoteRecord = Omit<Note, "id">;

/** Persistence port implemented by the SQLite adapter at the composition root. */
export interface NoteRepository {
  getNotesForHabit(habitId: number): Promise<Note[]>;
  doesHabitExist(habitId: number): Promise<boolean>;
  createNote(record: NewNoteRecord): Promise<Note>;
  updateNoteText(
    noteId: number,
    text: string,
    updatedAt: number,
  ): Promise<void>;
  deleteNote(noteId: number): Promise<void>;
}
