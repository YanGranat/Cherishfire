import {
  captureNotesCacheReadToken,
  clearCachedNotes,
  getCachedNotes,
  invalidateCachedNotes,
  isNotesCacheReadTokenCurrent,
  isNotesWriteProtectedByFence,
  peekCachedNotes,
  releaseNotesCacheReadToken,
  removeCachedNote,
  setCachedNotesIfCurrent,
  subscribeToNotesCacheInvalidation,
  trackPendingNotesWrite,
  upsertCachedNote,
  waitForNotesPersistenceTurn,
  waitForPendingNotesWrites,
  type NotesCacheReadToken,
} from "@/application/notes/notes-cache";
import type {
  NewNoteRecord,
  NoteRepository,
} from "@/application/notes/note-repository";
import {
  createNotesSessionRegistry,
  type NotesExternalChange,
  type NotesLoadResult,
  type NotesSession,
  type NotesSessionGateway,
} from "@/application/notes/notes-session";
import type { Note } from "@/types/note";

export interface NotesApplicationDependencies {
  waitForCommitOpportunity(): Promise<void>;
  now(): Date;
}

export interface NotesApplication {
  /** One application-owned optimistic projection per real habit. */
  getSession(habitId: number): NotesSession;
  prewarm(habitId: number): Promise<void>;
  invalidate(habitId: number, change?: NotesExternalChange): void;
  invalidateAll(): void;
  getResourceCounts(): Record<string, number>;
}

/**
 * Owns the complete Notes interaction pipeline: the stable visible projection,
 * optimistic commands, conditional rollback, exact transfer fences and the
 * confirmed SQLite/cache baseline. Screens subscribe to a session and retain
 * only transient editor/keyboard/layout state.
 */
export function createNotesApplication(
  repository: NoteRepository,
  dependencies: NotesApplicationDependencies,
): NotesApplication {
  const loadTokens = new WeakMap<NotesLoadResult, NotesCacheReadToken>();

  const load = async (
    habitId: number,
    getKnownHabitExists: () => boolean | null,
  ): Promise<NotesLoadResult> => {
    let staleReadCount = 0;
    for (;;) {
      await waitForPendingNotesWrites(habitId);
      const cacheReadToken = captureNotesCacheReadToken(habitId);
      const knownHabitExists = getKnownHabitExists();
      let notes: Note[];
      let habitExistsInDatabase: boolean | null;
      try {
        [notes, habitExistsInDatabase] = await Promise.all([
          repository.getNotesForHabit(habitId),
          knownHabitExists == null
            ? repository.doesHabitExist(habitId)
            : Promise.resolve(null),
        ]);
      } catch (error) {
        releaseNotesCacheReadToken(cacheReadToken);
        throw error;
      }
      const habitExists = knownHabitExists ?? habitExistsInDatabase === true;
      const readIsCurrent = habitExists
        ? setCachedNotesIfCurrent(cacheReadToken, notes)
        : isNotesCacheReadTokenCurrent(cacheReadToken);
      if (!readIsCurrent) {
        releaseNotesCacheReadToken(cacheReadToken);
        staleReadCount += 1;
        continue;
      }
      const result = { notes, habitExists, staleReadCount };
      loadTokens.set(result, cacheReadToken);
      return result;
    }
  };

  const gateway: NotesSessionGateway = {
    getCachedSnapshot: peekCachedNotes,
    load,
    isLoadResultCurrent(result) {
      const token = loadTokens.get(result);
      if (token == null) return false;
      loadTokens.delete(result);
      const isCurrent = isNotesCacheReadTokenCurrent(token);
      releaseNotesCacheReadToken(token);
      return isCurrent;
    },
    async create(record: NewNoteRecord): Promise<Note> {
      const persistedNote = await repository.createNote(record);
      upsertCachedNote(record.habitId, persistedNote);
      return persistedNote;
    },
    async update(note: Note): Promise<void> {
      await repository.updateNoteText(note.id, note.text, note.updatedAt);
      upsertCachedNote(note.habitId, note);
    },
    async delete(habitId: number, noteId: number): Promise<void> {
      await repository.deleteNote(noteId);
      removeCachedNote(habitId, noteId);
    },
    trackPendingWrite: trackPendingNotesWrite,
    waitForPersistenceTurn: waitForNotesPersistenceTurn,
    isWriteProtectedByFence: isNotesWriteProtectedByFence,
    waitForCommitOpportunity: dependencies.waitForCommitOpportunity,
    now: dependencies.now,
  };
  const sessions = createNotesSessionRegistry(gateway);

  // Explicit invalidation means an authoritative source outside the Notes
  // session changed (habit schedule/delete or committed import). Successful
  // Notes commands update their own projection and therefore do not emit it.
  subscribeToNotesCacheInvalidation(({ habitId, change }) => {
    sessions.invalidate(habitId, change);
  });

  const prewarm = async (habitId: number): Promise<void> => {
    if (!Number.isSafeInteger(habitId) || habitId <= 0) return;
    if (getCachedNotes(habitId) != null) return;

    await waitForPendingNotesWrites(habitId);
    if (getCachedNotes(habitId) != null) return;
    const token = captureNotesCacheReadToken(habitId);
    try {
      const notes = await repository.getNotesForHabit(habitId);
      setCachedNotesIfCurrent(token, notes);
    } finally {
      releaseNotesCacheReadToken(token);
    }
  };

  return {
    getSession: sessions.get,
    getResourceCounts: sessions.getResourceCounts,
    prewarm,
    invalidate: invalidateCachedNotes,
    invalidateAll: clearCachedNotes,
  };
}
