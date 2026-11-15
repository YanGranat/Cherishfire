import { createNotesApplication } from "@/application/notes/notes-application";
import { persistenceCommitScheduler } from "@/composition/persistence";
import { sqliteNoteRepository } from "@/data/sqlite/note-repository";
import type { NotesExternalChange } from "@/application/notes/notes-session";

export type {
  NotesPresentationChange,
  NotesSessionNote,
} from "@/application/notes/notes-session";

// Composition root only: application owns behavior; SQLite owns persistence.
export const notesApplication = createNotesApplication(sqliteNoteRepository, {
  waitForCommitOpportunity: () =>
    persistenceCommitScheduler.waitForCommitOpportunity(),
  now: () => new Date(),
});

export const invalidateNotesProjection = (
  habitId: number,
  change?: NotesExternalChange,
): void => {
  notesApplication.invalidate(habitId, change);
};

export const invalidateAllNotesProjections = (): void => {
  notesApplication.invalidateAll();
};
