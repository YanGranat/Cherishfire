import type { Note } from "@/types/note";
import type { NotesExternalChange } from "@/application/notes/notes-session";

const MAX_CACHED_HABITS = 48;
const notesByHabitId = new Map<number, readonly Note[]>();
const generationByHabitId = new Map<number, number>();
const pendingWritesByHabitId = new Map<number, Set<Promise<unknown>>>();
const pendingNotesWritesBySequence = new Map<number, Promise<void>>();
const notesWriteSequenceByPromise = new WeakMap<Promise<unknown>, number>();
const notesWriteFenceByPromise = new WeakMap<
  Promise<unknown>,
  ActiveNotesWriteFence
>();
let cacheEpoch = 0;
let nextCacheGeneration = 0;
let nextNotesWriteSequence = 0;
let nextNotesWriteFenceId = 0;

export interface NotesCacheInvalidation {
  /** `null` means every habit after an authoritative dataset replacement. */
  readonly habitId: number | null;
  readonly epoch: number;
  readonly change?: NotesExternalChange;
}

const cacheInvalidationListeners = new Set<
  (invalidation: NotesCacheInvalidation) => void
>();

export interface PendingNotesWriteFence {
  readonly owner: "notes";
  readonly id: number;
  readonly cutoffSequence: number;
}

export interface PendingNotesWriteFenceRelease {
  /** Import commit discards commands created against the pre-import dataset. */
  discardPostFence?: boolean;
}

interface ActiveNotesWriteFence {
  token: PendingNotesWriteFence;
  released: Promise<boolean>;
  release(discardPostFence: boolean): void;
}

let activeNotesWriteFence: ActiveNotesWriteFence | null = null;

export interface NotesCacheReadToken {
  habitId: number;
  epoch: number;
  generation: number;
}

function advanceGeneration(habitId: number): void {
  generationByHabitId.set(habitId, ++nextCacheGeneration);
}

function storeNotesSnapshot(habitId: number, notes: readonly Note[]): void {
  const snapshot = notes.map((note) => ({ ...note }));
  notesByHabitId.delete(habitId);
  notesByHabitId.set(habitId, snapshot);
  while (notesByHabitId.size > MAX_CACHED_HABITS) {
    const oldestHabitId = notesByHabitId.keys().next().value as
      | number
      | undefined;
    if (oldestHabitId == null) break;
    notesByHabitId.delete(oldestHabitId);
    generationByHabitId.delete(oldestHabitId);
  }
}

function compareNotesChronologically(left: Note, right: Note): number {
  const dateOrder = left.date === right.date ? 0 : left.date < right.date ? -1 : 1;
  return dateOrder || left.createdAt - right.createdAt;
}

/**
 * A valid cache entry is authoritative for this process. While a write is
 * pending, new consumers must wait for SQLite instead of observing the older
 * snapshot. Successful writers update that complete snapshot atomically;
 * failed writers leave it untouched for an exact rollback baseline.
 */
export function getCachedNotes(habitId: number): readonly Note[] | null {
  if ((pendingWritesByHabitId.get(habitId)?.size ?? 0) > 0) return null;
  const notes = notesByHabitId.get(habitId);
  if (!notes) return null;
  notesByHabitId.delete(habitId);
  notesByHabitId.set(habitId, notes);
  return notes;
}

/** Render-safe cache read: unlike `getCachedNotes`, this never mutates LRU order. */
export function peekCachedNotes(habitId: number): readonly Note[] | null {
  if ((pendingWritesByHabitId.get(habitId)?.size ?? 0) > 0) return null;
  return notesByHabitId.get(habitId) ?? null;
}

export function captureNotesCacheReadToken(
  habitId: number,
): NotesCacheReadToken {
  if (!generationByHabitId.has(habitId)) advanceGeneration(habitId);
  return {
    habitId,
    epoch: cacheEpoch,
    generation: generationByHabitId.get(habitId)!,
  };
}

export function isNotesCacheReadTokenCurrent(
  token: NotesCacheReadToken,
): boolean {
  return (
    token.epoch === cacheEpoch &&
    token.generation === generationByHabitId.get(token.habitId)
  );
}

/** Releases generation ownership when a read produced no cache entry. */
export function releaseNotesCacheReadToken(token: NotesCacheReadToken): void {
  if (
    isNotesCacheReadTokenCurrent(token) &&
    !notesByHabitId.has(token.habitId) &&
    (pendingWritesByHabitId.get(token.habitId)?.size ?? 0) === 0
  ) {
    generationByHabitId.delete(token.habitId);
  }
}

export function setCachedNotesIfCurrent(
  token: NotesCacheReadToken,
  notes: readonly Note[],
): boolean {
  if (
    !isNotesCacheReadTokenCurrent(token) ||
    (pendingWritesByHabitId.get(token.habitId)?.size ?? 0) > 0
  ) {
    return false;
  }

  storeNotesSnapshot(token.habitId, notes);
  return true;
}

/**
 * Applies one confirmed persistence row without invalidating and reloading the
 * complete habit snapshot. Missing entries stay missing: one row is not enough
 * to manufacture a trustworthy full-list cache.
 */
export function upsertCachedNote(habitId: number, note: Note): boolean {
  const current = notesByHabitId.get(habitId);
  if (!current) return false;

  const existingIndex = current.findIndex((item) => item.id === note.id);
  if (existingIndex >= 0) {
    const next = current.slice();
    next[existingIndex] = { ...note };
    advanceGeneration(habitId);
    storeNotesSnapshot(habitId, next);
    return true;
  }

  const next = [...current];
  const insertionIndex = next.findIndex(
    (item) => compareNotesChronologically(note, item) < 0,
  );
  next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, {
    ...note,
  });
  advanceGeneration(habitId);
  storeNotesSnapshot(habitId, next);
  return true;
}

/** Removes one confirmed persistence row while preserving all other rows. */
export function removeCachedNote(habitId: number, noteId: number): boolean {
  const current = notesByHabitId.get(habitId);
  if (!current) return false;
  const existingIndex = current.findIndex((note) => note.id === noteId);
  if (existingIndex < 0) return true;

  const next = current.slice();
  next.splice(existingIndex, 1);
  advanceGeneration(habitId);
  storeNotesSnapshot(habitId, next);
  return true;
}

export function trackPendingNotesWrite<T>(
  habitId: number,
  write: Promise<T>,
): Promise<T> {
  if (notesWriteSequenceByPromise.has(write)) return write;
  const sequence = ++nextNotesWriteSequence;
  notesWriteSequenceByPromise.set(write, sequence);
  const capturedFence = activeNotesWriteFence;
  if (
    capturedFence != null &&
    sequence > capturedFence.token.cutoffSequence
  ) {
    // Remember the gate at synchronous command registration. Import may
    // release/clear the global active fence before a task delayed by UI paint
    // or an earlier per-note write reaches `waitForNotesPersistenceTurn`.
    notesWriteFenceByPromise.set(write, capturedFence);
  }
  let settleGlobal!: () => void;
  const globallySettled = new Promise<void>((resolve) => {
    settleGlobal = resolve;
  });
  pendingNotesWritesBySequence.set(sequence, globallySettled);
  let pending = pendingWritesByHabitId.get(habitId);
  if (!pending) {
    pending = new Set();
    pendingWritesByHabitId.set(habitId, pending);
  }
  // Any read that started before this write must not publish its older
  // snapshot after the mutation settles.
  advanceGeneration(habitId);
  pending.add(write);
  const release = () => {
    const current = pendingWritesByHabitId.get(habitId);
    current?.delete(write);
    if (current?.size === 0) {
      pendingWritesByHabitId.delete(habitId);
      if (!notesByHabitId.has(habitId)) {
        generationByHabitId.delete(habitId);
      }
    }
    if (pendingNotesWritesBySequence.get(sequence) === globallySettled) {
      pendingNotesWritesBySequence.delete(sequence);
    }
    settleGlobal();
  };
  void write.then(release, release);
  return write;
}

/** Capture and gate post-cutoff writes in one synchronous operation. */
export function capturePendingNotesWriteFence(): PendingNotesWriteFence {
  if (activeNotesWriteFence != null) {
    throw new Error("A notes write fence is already active");
  }
  const token: PendingNotesWriteFence = {
    owner: "notes",
    id: ++nextNotesWriteFenceId,
    cutoffSequence: nextNotesWriteSequence,
  };
  let release!: (discardPostFence: boolean) => void;
  const released = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  activeNotesWriteFence = { token, released, release };
  return token;
}

/** Wait only writes registered no later than the exact capture cutoff. */
export async function waitForPendingNotesWritesThrough(
  fence: PendingNotesWriteFence,
): Promise<void> {
  const pendingAtCutoff = [...pendingNotesWritesBySequence.entries()]
    .filter(([sequence]) => sequence <= fence.cutoffSequence)
    .map(([, settled]) => settled);
  await Promise.all(pendingAtCutoff);
}

function getNotesWriteSequence(write: Promise<unknown>): number {
  const sequence = notesWriteSequenceByPromise.get(write);
  if (sequence == null) {
    throw new Error("Notes mutation started outside its persistence tracker");
  }
  return sequence;
}

export async function waitForNotesPersistenceTurn(
  write: Promise<unknown>,
): Promise<boolean> {
  const fence = notesWriteFenceByPromise.get(write) ?? activeNotesWriteFence;
  if (!fence || getNotesWriteSequence(write) <= fence.token.cutoffSequence) {
    return true;
  }
  return !(await fence.released);
}

/**
 * Pin an older captured intent only when its visible replacement was created
 * after the cutoff and therefore cannot reach SQLite before the snapshot.
 */
export function isNotesWriteProtectedByFence(
  write: Promise<unknown>,
  supersedingWrite: Promise<unknown> | null = null,
): boolean {
  const fence = activeNotesWriteFence;
  if (!fence) return false;
  const sequence = getNotesWriteSequence(write);
  const supersedingSequence =
    supersedingWrite == null ? null : getNotesWriteSequence(supersedingWrite);
  return (
    sequence <= fence.token.cutoffSequence &&
    (supersedingSequence == null ||
      supersedingSequence > fence.token.cutoffSequence)
  );
}

export function releasePendingNotesWriteFence(
  fence: PendingNotesWriteFence,
  options: PendingNotesWriteFenceRelease = {},
): void {
  const active = activeNotesWriteFence;
  if (!active || active.token !== fence) return;
  activeNotesWriteFence = null;
  active.release(options.discardPostFence === true);
}

export async function waitForPendingNotesWrites(habitId: number): Promise<void> {
  for (;;) {
    const pending = pendingWritesByHabitId.get(habitId);
    if (!pending || pending.size === 0) return;
    await Promise.allSettled([...pending]);
  }
}

export function invalidateCachedNotes(
  habitId: number,
  change?: NotesExternalChange,
): void {
  notesByHabitId.delete(habitId);
  generationByHabitId.delete(habitId);
  const invalidation = { habitId, epoch: cacheEpoch, change } as const;
  for (const listener of [...cacheInvalidationListeners]) {
    listener(invalidation);
  }
}

export function clearCachedNotes(): void {
  cacheEpoch += 1;
  notesByHabitId.clear();
  generationByHabitId.clear();
  const invalidation = { habitId: null, epoch: cacheEpoch } as const;
  for (const listener of [...cacheInvalidationListeners]) {
    listener(invalidation);
  }
}

/**
 * Session projections listen only to explicit authoritative invalidations.
 * Confirmed row writes update the cache through their owning command and must
 * not recursively reset the same optimistic session.
 */
export function subscribeToNotesCacheInvalidation(
  listener: (invalidation: NotesCacheInvalidation) => void,
): () => void {
  cacheInvalidationListeners.add(listener);
  return () => cacheInvalidationListeners.delete(listener);
}
