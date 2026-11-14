import { createNotesApplication } from "@/application/notes/notes-application";
import { persistenceCommitScheduler } from "@/composition/persistence";
import { sqliteNoteRepository } from "@/data/sqlite/note-repository";

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

export const invalidateNotesProjection = (habitId: number): void => {
  notesApplication.invalidate(habitId);
};

export const invalidateAllNotesProjections = (): void => {
  notesApplication.invalidateAll();
};
