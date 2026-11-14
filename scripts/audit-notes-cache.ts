import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureNotesCacheReadToken,
  capturePendingNotesWriteFence,
  clearCachedNotes,
  getCachedNotes,
  invalidateCachedNotes,
  isNotesWriteProtectedByFence,
  peekCachedNotes,
  releaseNotesCacheReadToken,
  releasePendingNotesWriteFence,
  removeCachedNote,
  setCachedNotesIfCurrent,
  trackPendingNotesWrite,
  upsertCachedNote,
  waitForNotesPersistenceTurn,
  waitForPendingNotesWritesThrough,
  waitForPendingNotesWrites,
} from "../src/application/notes/notes-cache";
import { createNotesApplication } from "../src/application/notes/notes-application";
import type { NoteRepository } from "../src/application/notes/note-repository";
import { parseHabitRouteId } from "../src/domain/habits/route-id";
import { mergeRecoveredDraft } from "../src/utils/recovered-draft";
import type { Note } from "../src/types/note";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}
function note(id: number, habitId = id): Note {
  return {
    id,
    habitId,
    date: "2026-08-29",
    text: `note-${id}`,
    isFailureReason: false,
    reasonType: null,
    createdAt: id,
    updatedAt: id,
  };
}
async function main() {
  assert.equal(mergeRecoveredDraft("failed", "", ""), "failed");
  assert.equal(
    mergeRecoveredDraft("failed", "confirmed", "confirmed"),
    "failed",
  );
  assert.equal(
    mergeRecoveredDraft("failed", "newer", "confirmed"),
    "failed\n\nnewer",
  );
  assert.equal(
    mergeRecoveredDraft("failed", "failed + continued", "confirmed", "failed"),
    "failed + continued",
    "a draft continued from the failed optimistic value must not duplicate its base",
  );
  assert.equal(
    mergeRecoveredDraft("failed", "", "confirmed", "failed"),
    "",
    "deleting a draft continued from the failed optimistic value is a newer user decision",
  );
  for (const invalidRouteId of [
    undefined,
    null,
    ["1"],
    "",
    "0",
    "-1",
    "01",
    "1abc",
    "1.5",
    "9007199254740992",
  ]) {
    assert.equal(
      parseHabitRouteId(invalidRouteId),
      null,
      `invalid habit route id must be rejected: ${String(invalidRouteId)}`,
    );
  }
  assert.equal(parseHabitRouteId("1"), 1);
  assert.equal(
    parseHabitRouteId(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER,
  );
  clearCachedNotes();
  const currentToken = captureNotesCacheReadToken(1);
  assert.equal(setCachedNotesIfCurrent(currentToken, [note(1)]), true);
  assert.deepEqual(getCachedNotes(1), [note(1)]);
  assert.equal(upsertCachedNote(1, note(2, 1)), true);
  assert.deepEqual(
    getCachedNotes(1)?.map((item) => item.id),
    [1, 2],
    "confirmed create must append without reloading the complete list",
  );
  const editedNote = {
    ...note(1),
    text: "edited",
    updatedAt: 20,
  };
  assert.equal(upsertCachedNote(1, editedNote), true);
  assert.deepEqual(
    getCachedNotes(1),
    [editedNote, note(2, 1)],
    "confirmed update must replace exactly one cached row",
  );
  assert.equal(removeCachedNote(1, 2), true);
  assert.deepEqual(
    getCachedNotes(1),
    [editedNote],
    "confirmed delete must preserve every other cached row",
  );
  const earlier = { ...note(31, 3), date: "2026-08-27", createdAt: 30 };
  const middle = { ...note(32, 3), date: "2026-08-28", createdAt: 20 };
  const later = { ...note(33, 3), date: "2026-08-29", createdAt: 10 };
  const chronologicalToken = captureNotesCacheReadToken(3);
  assert.equal(
    setCachedNotesIfCurrent(chronologicalToken, [earlier, later]),
    true,
  );
  assert.equal(upsertCachedNote(3, middle), true);
  assert.deepEqual(
    getCachedNotes(3)?.map((item) => item.id),
    [31, 32, 33],
    "confirmed rows must stay ordered by date and then creation time",
  );
  const dateKeys = [
    "0001-01-01",
    "0099-12-31",
    "0100-01-01",
    "1900-02-28",
    "2000-02-29",
    "2011-12-30",
    "9999-12-31",
  ];
  const chronologicalRows = dateKeys.map((date, index) => ({
    ...note(100 + index, 4),
    date,
  }));
  const rangeToken = captureNotesCacheReadToken(4);
  assert.equal(
    setCachedNotesIfCurrent(
      rangeToken,
      chronologicalRows.filter((_, index) => index % 2 === 0),
    ),
    true,
  );
  for (const row of chronologicalRows.filter((_, index) => index % 2 === 1))
    upsertCachedNote(4, row);
  assert.deepEqual(
    getCachedNotes(4)?.map((item) => item.date),
    dateKeys,
    "canonical civil keys must retain chronological order throughout the supported range",
  );
  const cacheSource = readFileSync(
    resolve("src/application/notes/notes-cache.ts"),
    "utf8",
  );
  const comparison = "left.date < right.date";
  assert.equal(cacheSource.split(comparison).length, 2);
  const reversedComparator = loadSourceCallableForAudit<
    (left: Note, right: Note) => number
  >(
    cacheSource.replace(comparison, "left.date > right.date"),
    "compareNotesChronologically",
    {},
  );
  assert.throws(
    () =>
      assert.deepEqual(
        [...chronologicalRows]
          .reverse()
          .sort(reversedComparator)
          .map((item) => item.date),
        dateKeys,
      ),
    assert.AssertionError,
    "a reversed date-key comparison must violate the actual chronology contract",
  );
  assert.equal(upsertCachedNote(404, note(4, 404)), false);
  assert.equal(removeCachedNote(404, 4), false);
  assert.equal(
    getCachedNotes(404),
    null,
    "one mutation row must never manufacture an incomplete list cache",
  );
  const staleToken = captureNotesCacheReadToken(1);
  invalidateCachedNotes(1);
  assert.equal(setCachedNotesIfCurrent(staleToken, [note(2, 1)]), false);
  assert.equal(getCachedNotes(1), null);
  const clearedToken = captureNotesCacheReadToken(2);
  clearCachedNotes();
  assert.equal(setCachedNotesIfCurrent(clearedToken, [note(2)]), false);
  const evictedToken = captureNotesCacheReadToken(1);
  assert.equal(setCachedNotesIfCurrent(evictedToken, [note(1)]), true);
  for (let habitId = 2; habitId <= 49; habitId += 1) {
    const token = captureNotesCacheReadToken(habitId);
    assert.equal(setCachedNotesIfCurrent(token, [note(habitId)]), true);
  }
  assert.equal(getCachedNotes(1), null, "LRU must evict the oldest habit");
  assert.ok(getCachedNotes(49));
  const reloadedEvictedToken = captureNotesCacheReadToken(1);
  assert.equal(
    setCachedNotesIfCurrent(evictedToken, [note(101, 1)]),
    false,
    "an evicted generation must never become current again after reload",
  );
  assert.equal(
    setCachedNotesIfCurrent(reloadedEvictedToken, [note(102, 1)]),
    true,
  );
  const missingReadToken = captureNotesCacheReadToken(50000);
  releaseNotesCacheReadToken(missingReadToken);
  const nextMissingReadToken = captureNotesCacheReadToken(50000);
  assert.equal(
    setCachedNotesIfCurrent(missingReadToken, []),
    false,
    "a released missing-row read token must not retain or regain ownership",
  );
  releaseNotesCacheReadToken(nextMissingReadToken);
  clearCachedNotes();
  for (let habitId = 1; habitId <= 48; habitId += 1) {
    const token = captureNotesCacheReadToken(habitId);
    assert.equal(setCachedNotesIfCurrent(token, [note(habitId)]), true);
  }
  assert.ok(peekCachedNotes(1));
  const purePeekEvictionToken = captureNotesCacheReadToken(49);
  assert.equal(
    setCachedNotesIfCurrent(purePeekEvictionToken, [note(49)]),
    true,
  );
  assert.equal(
    peekCachedNotes(1),
    null,
    "render-safe peek must not mutate LRU order",
  );
  let releaseCapturedWrite!: () => void;
  let capturedWrite!: Promise<void>;
  let postFenceWrite!: Promise<void>;
  let persistedFenceValue = "initial";
  const capturedStart = new Promise<void>((resolve) => {
    releaseCapturedWrite = resolve;
  });
  capturedWrite = (async () => {
    await capturedStart;
    if (await waitForNotesPersistenceTurn(capturedWrite)) {
      if (isNotesWriteProtectedByFence(capturedWrite, postFenceWrite)) {
        persistedFenceValue = "captured";
      }
    }
  })();
  trackPendingNotesWrite(500, capturedWrite);
  const exportFence = capturePendingNotesWriteFence();
  postFenceWrite = (async () => {
    await Promise.resolve();
    if (await waitForNotesPersistenceTurn(postFenceWrite)) {
      persistedFenceValue = "post-fence";
    }
  })();
  trackPendingNotesWrite(500, postFenceWrite);
  releaseCapturedWrite();
  await waitForPendingNotesWritesThrough(exportFence);
  assert.equal(
    persistedFenceValue,
    "captured",
    "a superseded pre-cutoff intent must still reach persistence",
  );
  releasePendingNotesWriteFence(exportFence);
  await postFenceWrite;
  assert.equal(persistedFenceValue, "post-fence");
  let discardWrite!: Promise<void>;
  const importFence = capturePendingNotesWriteFence();
  discardWrite = (async () => {
    await Promise.resolve();
    if (await waitForNotesPersistenceTurn(discardWrite)) {
      persistedFenceValue = "must-not-replay";
    }
  })();
  trackPendingNotesWrite(500, discardWrite);
  await waitForPendingNotesWritesThrough(importFence);
  releasePendingNotesWriteFence(importFence, { discardPostFence: true });
  await discardWrite;
  assert.notEqual(persistedFenceValue, "must-not-replay");
  const singleFence = capturePendingNotesWriteFence();
  assert.throws(
    capturePendingNotesWriteFence,
    /already active/,
    "overlapping transfer fences must fail fast",
  );
  releasePendingNotesWriteFence(singleFence);
  let releaseFirst!: () => void;
  const pendingToken = captureNotesCacheReadToken(77);
  assert.equal(setCachedNotesIfCurrent(pendingToken, [note(77)]), true);
  const firstWrite = new Promise<void>((resolve) => {
    releaseFirst = () => {
      upsertCachedNote(77, {
        ...note(77),
        text: "confirmed",
        updatedAt: 78,
      });
      resolve();
    };
  });
  const readStartedBeforeWrite = captureNotesCacheReadToken(77);
  trackPendingNotesWrite(77, firstWrite);
  assert.equal(
    getCachedNotes(77),
    null,
    "a pending write must hide the older first-frame snapshot",
  );
  assert.equal(
    setCachedNotesIfCurrent(readStartedBeforeWrite, [note(770, 77)]),
    false,
    "a read started before a write must not publish stale rows",
  );
  let habitBarrierSettled = false;
  const habitBarrier = waitForPendingNotesWrites(77).then(() => {
    habitBarrierSettled = true;
  });
  await Promise.resolve();
  assert.equal(habitBarrierSettled, false);
  releaseFirst();
  await habitBarrier;
  assert.equal(habitBarrierSettled, true);
  assert.equal(
    getCachedNotes(77)?.[0]?.text,
    "confirmed",
    "the confirmed row must become visible only after the pending write",
  );
  const failedWriteToken = captureNotesCacheReadToken(78);
  assert.equal(setCachedNotesIfCurrent(failedWriteToken, [note(78)]), true);
  let rejectFailedWrite!: (reason?: unknown) => void;
  const failedWrite = new Promise<void>((_resolve, reject) => {
    rejectFailedWrite = reject;
  });
  trackPendingNotesWrite(78, failedWrite);
  assert.equal(getCachedNotes(78), null);
  rejectFailedWrite(new Error("expected test failure"));
  await waitForPendingNotesWrites(78);
  assert.deepEqual(
    getCachedNotes(78),
    [note(78)],
    "a failed write must expose the untouched confirmed rollback baseline",
  );
  const rapidToken = captureNotesCacheReadToken(79);
  assert.equal(setCachedNotesIfCurrent(rapidToken, [note(79)]), true);
  let releaseOlderUpdate!: () => void;
  const olderUpdate = new Promise<void>((resolve) => {
    releaseOlderUpdate = () => {
      upsertCachedNote(79, {
        ...note(79),
        text: "older-confirmed",
        updatedAt: 80,
      });
      resolve();
    };
  });
  const latestUpdate = olderUpdate.then(() => {
    upsertCachedNote(79, {
      ...note(79),
      text: "latest-confirmed",
      updatedAt: 81,
    });
  });
  trackPendingNotesWrite(79, olderUpdate);
  trackPendingNotesWrite(79, latestUpdate);
  releaseOlderUpdate();
  await waitForPendingNotesWrites(79);
  assert.equal(
    getCachedNotes(79)?.[0]?.text,
    "latest-confirmed",
    "serialized rapid edits must leave the latest confirmed text in cache",
  );
  const createDeleteToken = captureNotesCacheReadToken(80);
  assert.equal(setCachedNotesIfCurrent(createDeleteToken, []), true);
  let releaseCreate!: () => void;
  const createWrite = new Promise<void>((resolve) => {
    releaseCreate = () => {
      upsertCachedNote(80, note(800, 80));
      resolve();
    };
  });
  const deleteAfterCreate = createWrite.then(() => {
    removeCachedNote(80, 800);
  });
  trackPendingNotesWrite(80, createWrite);
  trackPendingNotesWrite(80, deleteAfterCreate);
  releaseCreate();
  await waitForPendingNotesWrites(80);
  assert.deepEqual(
    getCachedNotes(80),
    [],
    "create followed immediately by delete must not resurrect the created row",
  );
  // A freshly created note can be edited before SQLite returns its real id.
  // The UPDATE then waits behind the INSERT, while export may be requested in
  // the meantime. The exact cutoff must not expose the row between those two
  // writes, because that snapshot would contain the original note text.
  let releaseDeferredInsert!: () => void;
  let persistedText = "not-inserted";
  const deferredInsert = new Promise<void>((resolve) => {
    releaseDeferredInsert = () => {
      persistedText = "created text";
      resolve();
    };
  });
  const deferredUpdate = deferredInsert.then(() => {
    persistedText = "final edited text";
  });
  trackPendingNotesWrite(99, deferredInsert);
  trackPendingNotesWrite(99, deferredUpdate);
  let exportedText: string | null = null;
  const chainedWriteFence = capturePendingNotesWriteFence();
  const deferredExport = waitForPendingNotesWritesThrough(
    chainedWriteFence,
  ).then(() => {
    exportedText = persistedText;
  });
  await Promise.resolve();
  assert.equal(
    exportedText,
    null,
    "export must not read a newly inserted note before its chained edit",
  );
  releaseDeferredInsert();
  await deferredExport;
  releasePendingNotesWriteFence(chainedWriteFence);
  assert.equal(
    exportedText,
    "final edited text",
    "export must observe the final text after deferred INSERT and UPDATE",
  );
  clearCachedNotes();
  const repositoryRows = new Map<number, Note[]>([[501, [note(5011, 501)]]]);
  const existingHabits = new Set<number>([501]);
  const createGates: Deferred<void>[] = [];
  const updateGates: Deferred<void>[] = [];
  const deleteGates: Deferred<void>[] = [];
  const readGates = new Map<number, Deferred<Note[]>[]>();
  const updateCalls: {
    noteId: number;
    text: string;
  }[] = [];
  const deleteCalls: number[] = [];
  let createCallCount = 0;
  let existenceReadCount = 0;
  let nextRepositoryId = 6000;
  let clock = Date.UTC(2026, 7, 29, 12);
  const repository: NoteRepository = {
    async getNotesForHabit(habitId) {
      const gate = readGates.get(habitId)?.shift();
      if (gate) return (await gate.promise).map((item) => ({ ...item }));
      return (repositoryRows.get(habitId) ?? []).map((item) => ({ ...item }));
    },
    async doesHabitExist(habitId) {
      existenceReadCount += 1;
      return existingHabits.has(habitId);
    },
    async createNote(record) {
      createCallCount += 1;
      const gate = createGates.shift();
      if (gate) await gate.promise;
      const persisted = { ...record, id: nextRepositoryId++ };
      repositoryRows.set(record.habitId, [
        ...(repositoryRows.get(record.habitId) ?? []),
        persisted,
      ]);
      existingHabits.add(record.habitId);
      return persisted;
    },
    async updateNoteText(noteId, text, updatedAt) {
      updateCalls.push({ noteId, text });
      const gate = updateGates.shift();
      if (gate) await gate.promise;
      for (const [habitId, rows] of repositoryRows) {
        const index = rows.findIndex((item) => item.id === noteId);
        if (index < 0) continue;
        const next = rows.slice();
        next[index] = { ...next[index], text, updatedAt };
        repositoryRows.set(habitId, next);
        return;
      }
    },
    async deleteNote(noteId) {
      deleteCalls.push(noteId);
      const gate = deleteGates.shift();
      if (gate) await gate.promise;
      for (const [habitId, rows] of repositoryRows) {
        repositoryRows.set(
          habitId,
          rows.filter((item) => item.id !== noteId),
        );
      }
    },
  };
  const application = createNotesApplication(repository, {
    waitForCommitOpportunity: () => Promise.resolve(),
    now: () => new Date(clock++),
  });
  const loadedSession = application.getSession(501);
  assert.equal(
    loadedSession.getSnapshot(),
    loadedSession.getSnapshot(),
    "useSyncExternalStore snapshots must remain referentially stable between publications",
  );
  await loadedSession.ensureLoaded(() => true);
  assert.equal(loadedSession.getSnapshot().status, "ready");
  assert.deepEqual(
    loadedSession.getSnapshot().notes.map((item) => item.id),
    [5011],
  );
  assert.equal(existenceReadCount, 0, "known habits must skip fallback SELECT");
  assert.equal(
    application.getSession(501),
    loadedSession,
    "one habit must retain one application-owned NotesSession",
  );
  const seedEmptySession = (habitId: number) => {
    existingHabits.add(habitId);
    repositoryRows.set(habitId, []);
    const token = captureNotesCacheReadToken(habitId);
    assert.equal(setCachedNotesIfCurrent(token, []), true);
    return application.getSession(habitId);
  };
  // Create -> edit before INSERT returns: visible identity must stay stable and
  // UPDATE must wait for the real id instead of remounting the React row.
  const createEditSession = seedEmptySession(502);
  const delayedCreate = deferred<void>();
  createGates.push(delayedCreate);
  const createSubmission = createEditSession.create("created");
  assert.equal(createSubmission.accepted, true);
  const optimistic = createEditSession.getSnapshot().notes[0];
  assert.ok(optimistic.id < 0);
  assert.match(optimistic.clientMutationId, /^optimistic:502:/);
  const stableKey = optimistic.clientMutationId;
  assert.equal(
    application.getSession(502).getSnapshot().notes[0]?.clientMutationId,
    stableKey,
    "unmount/remount while INSERT is pending must retain the same optimistic key",
  );
  assert.equal(
    createEditSession.update(optimistic.id, "edited").accepted,
    true,
  );
  assert.equal(createEditSession.getSnapshot().notes[0]?.text, "edited");
  await flushMicrotasks();
  assert.equal(createCallCount, 1);
  assert.equal(
    updateCalls.some((call) => call.text === "edited"),
    false,
  );
  delayedCreate.resolve();
  await createEditSession.whenIdle();
  assert.equal(
    createEditSession.getSnapshot().notes[0]?.clientMutationId,
    stableKey,
  );
  assert.equal(createEditSession.getSnapshot().notes[0]?.id, optimistic.id);
  assert.equal(repositoryRows.get(502)?.[0]?.text, "edited");
  // More protected sessions than the soft LRU limit must not make `get`
  // return an instance that it immediately evicted before React can subscribe.
  const pressureSessions: {
    habitId: number;
    session: ReturnType<typeof application.getSession>;
    gate: Deferred<void>;
  }[] = [];
  for (let index = 0; index < 49; index += 1) {
    const habitId = 700 + index;
    const session = seedEmptySession(habitId);
    const gate = deferred<void>();
    createGates.push(gate);
    session.create(`retained-${index}`);
    pressureSessions.push({ habitId, session, gate });
  }
  for (const { habitId, session } of pressureSessions) {
    assert.equal(
      application.getSession(habitId),
      session,
      "a returned/pending session must survive LRU pressure for remount",
    );
  }
  for (const { gate } of pressureSessions) gate.resolve();
  await Promise.all(pressureSessions.map(({ session }) => session.whenIdle()));
  // Create -> delete before INSERT returns must serialize INSERT/DELETE and
  // must never resurrect the removed optimistic row.
  const createDeleteSession = seedEmptySession(503);
  const delayedCreateForDelete = deferred<void>();
  createGates.push(delayedCreateForDelete);
  createDeleteSession.create("temporary");
  const temporaryId = createDeleteSession.getSnapshot().notes[0]?.id;
  assert.ok(temporaryId != null && temporaryId < 0);
  createDeleteSession.delete(temporaryId);
  assert.deepEqual(createDeleteSession.getSnapshot().notes, []);
  delayedCreateForDelete.resolve();
  await createDeleteSession.whenIdle();
  assert.deepEqual(repositoryRows.get(503), []);
  // A failed INSERT after a newer delete is already visible must remain
  // absent and must not publish a stale save error or rollback row.
  const failedCreateDeleteSession = seedEmptySession(504);
  const failedCreate = deferred<void>();
  createGates.push(failedCreate);
  failedCreateDeleteSession.create("will fail");
  const failedCreateId = failedCreateDeleteSession.getSnapshot().notes[0]?.id;
  failedCreateDeleteSession.delete(failedCreateId);
  failedCreate.reject(new Error("expected create failure"));
  await failedCreateDeleteSession.whenIdle();
  assert.deepEqual(failedCreateDeleteSession.getSnapshot().notes, []);
  assert.equal(failedCreateDeleteSession.getSnapshot().mutationError, null);
  const failedCreateOnlySession = seedEmptySession(590);
  const failedCreateOnly = deferred<void>();
  createGates.push(failedCreateOnly);
  failedCreateOnlySession.create("exact failed create draft");
  failedCreateOnly.reject(new Error("expected standalone create failure"));
  await failedCreateOnlySession.whenIdle();
  assert.equal(
    failedCreateOnlySession.getSnapshot().presentationChanges.at(-1)
      ?.recoveryText,
    "exact failed create draft",
    "create rollback must retain the exact submitted composer draft",
  );
  // Older success followed by newer failure rolls back only to the durable A
  // baseline; an older failure after newer intent must never erase B.
  repositoryRows.set(505, [note(5051, 505)]);
  existingHabits.add(505);
  const token505 = captureNotesCacheReadToken(505);
  assert.equal(setCachedNotesIfCurrent(token505, [note(5051, 505)]), true);
  const updateSession = application.getSession(505);
  const updateA = deferred<void>();
  const updateB = deferred<void>();
  updateGates.push(updateA, updateB);
  updateSession.update(5051, "A");
  await flushMicrotasks();
  assert.equal(updateCalls.at(-1)?.text, "A");
  updateSession.update(5051, "B");
  updateA.resolve();
  await flushMicrotasks();
  assert.equal(updateCalls.at(-1)?.text, "B");
  updateB.reject(new Error("expected B failure"));
  await updateSession.whenIdle();
  assert.equal(updateSession.getSnapshot().notes[0]?.text, "A");
  assert.equal(updateSession.getSnapshot().mutationError, "save");
  assert.equal(
    updateSession.getSnapshot().presentationChanges.at(-1)?.recoveryText,
    "B",
    "update rollback must retain the exact failed editor draft",
  );
  repositoryRows.set(506, [note(5061, 506)]);
  existingHabits.add(506);
  const token506 = captureNotesCacheReadToken(506);
  assert.equal(setCachedNotesIfCurrent(token506, [note(5061, 506)]), true);
  const staleFailureSession = application.getSession(506);
  const failingA = deferred<void>();
  const succeedingB = deferred<void>();
  updateGates.push(failingA, succeedingB);
  staleFailureSession.update(5061, "A-fails");
  await flushMicrotasks();
  staleFailureSession.update(5061, "B-wins");
  failingA.reject(new Error("expected stale A failure"));
  await flushMicrotasks();
  assert.equal(
    staleFailureSession.getSnapshot().notes[0]?.text,
    "B-wins",
    "an old failure must not roll back a newer visible intent",
  );
  succeedingB.resolve();
  await staleFailureSession.whenIdle();
  assert.equal(repositoryRows.get(506)?.[0]?.text, "B-wins");
  // Delete rollback restores exactly the same stable row and index.
  repositoryRows.set(507, [note(5071, 507), note(5072, 507)]);
  existingHabits.add(507);
  const token507 = captureNotesCacheReadToken(507);
  assert.equal(
    setCachedNotesIfCurrent(token507, [note(5071, 507), note(5072, 507)]),
    true,
  );
  const deleteSession = application.getSession(507);
  const deletedKey = deleteSession.getSnapshot().notes[0]?.clientMutationId;
  const failingDelete = deferred<void>();
  deleteGates.push(failingDelete);
  deleteSession.delete(5071);
  assert.deepEqual(
    deleteSession.getSnapshot().notes.map((item) => item.id),
    [5072],
  );
  failingDelete.reject(new Error("expected delete failure"));
  await deleteSession.whenIdle();
  assert.deepEqual(
    deleteSession.getSnapshot().notes.map((item) => item.id),
    [5071, 5072],
  );
  assert.equal(
    deleteSession.getSnapshot().notes[0]?.clientMutationId,
    deletedKey,
  );
  // A DELETE is ordered after the latest visible UPDATE. If DELETE then fails,
  // rollback must restore that durable edited text instead of the older row.
  repositoryRows.set(514, [note(5141, 514)]);
  existingHabits.add(514);
  const token514 = captureNotesCacheReadToken(514);
  assert.equal(setCachedNotesIfCurrent(token514, [note(5141, 514)]), true);
  const editedDeleteSession = application.getSession(514);
  const succeedingEditBeforeDelete = deferred<void>();
  const failingDeleteAfterEdit = deferred<void>();
  updateGates.push(succeedingEditBeforeDelete);
  deleteGates.push(failingDeleteAfterEdit);
  editedDeleteSession.update(5141, "edited-before-delete");
  editedDeleteSession.delete(5141);
  await flushMicrotasks();
  assert.equal(
    updateCalls.at(-1)?.text,
    "edited-before-delete",
    "delete must not supersede the update needed for a correct rollback",
  );
  succeedingEditBeforeDelete.resolve();
  await flushMicrotasks();
  failingDeleteAfterEdit.reject(
    new Error("expected delete after edit failure"),
  );
  await editedDeleteSession.whenIdle();
  assert.equal(
    editedDeleteSession.getSnapshot().notes[0]?.text,
    "edited-before-delete",
    "failed delete must restore the latest durably edited text",
  );
  assert.equal(repositoryRows.get(514)?.[0]?.text, "edited-before-delete");
  // If both the prerequisite UPDATE and the following DELETE fail, the
  // durable row must remain authoritative while the user's edited text is
  // emitted as a recoverable editor draft instead of being lost or presented
  // as falsely persisted.
  repositoryRows.set(515, [note(5151, 515)]);
  existingHabits.add(515);
  const token515 = captureNotesCacheReadToken(515);
  assert.equal(setCachedNotesIfCurrent(token515, [note(5151, 515)]), true);
  const failedEditDeleteSession = application.getSession(515);
  const failingEditBeforeDelete = deferred<void>();
  const failingDeleteAfterFailedEdit = deferred<void>();
  updateGates.push(failingEditBeforeDelete);
  deleteGates.push(failingDeleteAfterFailedEdit);
  failedEditDeleteSession.update(5151, "recover-this-edit");
  failedEditDeleteSession.delete(5151);
  await flushMicrotasks();
  failingEditBeforeDelete.reject(
    new Error("expected edit before delete failure"),
  );
  await flushMicrotasks();
  failingDeleteAfterFailedEdit.reject(
    new Error("expected delete after failed edit failure"),
  );
  await failedEditDeleteSession.whenIdle();
  assert.equal(
    failedEditDeleteSession.getSnapshot().notes[0]?.text,
    "note-5151",
    "failed delete must restore the actual durable row after a failed edit",
  );
  const failedEditDeleteRecovery = failedEditDeleteSession
    .getSnapshot()
    .presentationChanges.at(-1);
  assert.equal(failedEditDeleteRecovery?.source, "delete");
  assert.equal(
    failedEditDeleteRecovery?.recoveryText,
    "recover-this-edit",
    "the edited text must survive both failures as an explicit recovery draft",
  );
  assert.equal(repositoryRows.get(515)?.[0]?.text, "note-5151");
  // Independent DELETEs can fail in any order. Rollback must restore the
  // authoritative chronology, not splice against an index captured before
  // the other optimistic removal changed the visible list.
  repositoryRows.set(513, [note(5131, 513), note(5132, 513), note(5133, 513)]);
  existingHabits.add(513);
  const token513 = captureNotesCacheReadToken(513);
  assert.equal(
    setCachedNotesIfCurrent(token513, [
      note(5131, 513),
      note(5132, 513),
      note(5133, 513),
    ]),
    true,
  );
  const concurrentDeleteSession = application.getSession(513);
  const failingDeleteA = deferred<void>();
  const failingDeleteB = deferred<void>();
  deleteGates.push(failingDeleteA, failingDeleteB);
  concurrentDeleteSession.delete(5131);
  concurrentDeleteSession.delete(5132);
  await flushMicrotasks();
  assert.deepEqual(
    concurrentDeleteSession.getSnapshot().notes.map((item) => item.id),
    [5133],
  );
  failingDeleteA.reject(new Error("expected first delete failure first"));
  await flushMicrotasks();
  assert.deepEqual(
    concurrentDeleteSession.getSnapshot().notes.map((item) => item.id),
    [5131, 5133],
  );
  failingDeleteB.reject(new Error("expected second delete failure second"));
  await concurrentDeleteSession.whenIdle();
  assert.deepEqual(
    concurrentDeleteSession.getSnapshot().notes.map((item) => item.id),
    [5131, 5132, 5133],
    "out-of-order delete failures must not invert the chronological list",
  );
  // An in-flight stale SELECT retries after a synchronously registered write.
  repositoryRows.set(508, [note(5082, 508)]);
  existingHabits.add(508);
  const staleRead = deferred<Note[]>();
  readGates.set(508, [staleRead]);
  const staleReadSession = application.getSession(508);
  const staleLoad = staleReadSession.ensureLoaded(() => true);
  await flushMicrotasks();
  const publicationGapWrite = trackPendingNotesWrite(508, Promise.resolve());
  staleRead.resolve([note(5081, 508)]);
  await publicationGapWrite;
  await staleLoad;
  assert.deepEqual(
    staleReadSession.getSnapshot().notes.map((item) => item.id),
    [5082],
    "a superseded SELECT must retry before publishing its projection",
  );
  // If an external owner invalidates while a SELECT is in flight, the old
  // generation must never win. A focused consumer's second load request is
  // retained and restarted after the obsolete request finishes.
  repositoryRows.set(512, [note(5122, 512)]);
  existingHabits.add(512);
  const invalidatedRead = deferred<Note[]>();
  readGates.set(512, [invalidatedRead]);
  const invalidatedLoadSession = application.getSession(512);
  const obsoleteLoad = invalidatedLoadSession.ensureLoaded(() => true);
  await flushMicrotasks();
  invalidateCachedNotes(512);
  repositoryRows.set(512, [note(5123, 512)]);
  void invalidatedLoadSession.ensureLoaded(() => true);
  invalidatedRead.resolve([note(5121, 512)]);
  await obsoleteLoad;
  await invalidatedLoadSession.whenIdle();
  assert.deepEqual(
    invalidatedLoadSession.getSnapshot().notes.map((item) => item.id),
    [5123],
    "an invalidated load must restart only for the consumer that requested it",
  );
  const missingSession = application.getSession(999);
  await missingSession.ensureLoaded(() => null);
  assert.equal(missingSession.getSnapshot().status, "missing");
  assert.equal(
    existenceReadCount,
    1,
    "unknown habits need one fallback lookup",
  );
  // Export captures every accepted pre-cutoff session command because command
  // registration is synchronous, before its persistence microtask can run.
  repositoryRows.set(509, [note(5091, 509)]);
  existingHabits.add(509);
  const token509 = captureNotesCacheReadToken(509);
  assert.equal(setCachedNotesIfCurrent(token509, [note(5091, 509)]), true);
  const fencedSession = application.getSession(509);
  const fencedUpdate = deferred<void>();
  updateGates.push(fencedUpdate);
  fencedSession.update(5091, "captured");
  const sessionExportFence = capturePendingNotesWriteFence();
  let sessionFenceSettled = false;
  const waitSessionFence = waitForPendingNotesWritesThrough(
    sessionExportFence,
  ).then(() => {
    sessionFenceSettled = true;
  });
  await flushMicrotasks();
  assert.equal(sessionFenceSettled, false);
  fencedUpdate.resolve();
  await waitSessionFence;
  releasePendingNotesWriteFence(sessionExportFence);
  assert.equal(repositoryRows.get(509)?.[0]?.text, "captured");
  // A committed import clears every live projection exactly once even though
  // each publication touches the registry's LRU Map. Post-cutoff commands are
  // discarded and an old completion cannot republish the replaced dataset.
  const importedA = seedEmptySession(510);
  const importedB = seedEmptySession(511);
  let invalidationsA = 0;
  let invalidationsB = 0;
  const unsubscribeA = importedA.subscribe(() => {
    invalidationsA += 1;
  });
  const unsubscribeB = importedB.subscribe(() => {
    invalidationsB += 1;
  });
  const postCutoffFence = capturePendingNotesWriteFence();
  const postCutoffCreateCount = createCallCount;
  importedA.create("discard me");
  repositoryRows.set(510, [note(5109, 510)]);
  repositoryRows.set(511, [note(5119, 511)]);
  const invalidationsABeforeReset = invalidationsA;
  const invalidationsBBeforeReset = invalidationsB;
  clearCachedNotes();
  assert.equal(invalidationsA - invalidationsABeforeReset, 1);
  assert.equal(invalidationsB - invalidationsBBeforeReset, 1);
  unsubscribeA();
  unsubscribeB();
  releasePendingNotesWriteFence(postCutoffFence, { discardPostFence: true });
  await importedA.whenIdle();
  assert.equal(createCallCount, postCutoffCreateCount);
  await Promise.all([
    importedA.ensureLoaded(() => true),
    importedB.ensureLoaded(() => true),
  ]);
  assert.deepEqual(
    importedA.getSnapshot().notes.map((item) => item.id),
    [5109],
  );
  assert.deepEqual(
    importedB.getSnapshot().notes.map((item) => item.id),
    [5119],
  );
  const notesScreenSource = readFileSync(
    resolve(process.cwd(), "app/habit/[id]/notes.tsx"),
    "utf8",
  );
  const habitRouteIdSource = readFileSync(
    resolve(process.cwd(), "src/domain/habits/route-id.ts"),
    "utf8",
  );
  const noteInputSource = readFileSync(
    resolve(process.cwd(), "src/features/notes/components/NoteInput.tsx"),
    "utf8",
  );
  const noteCardSource = readFileSync(
    resolve(process.cwd(), "src/features/notes/components/NoteCard.tsx"),
    "utf8",
  );
  const noteRepositorySource = readFileSync(
    resolve(process.cwd(), "src/data/sqlite/note-repository.ts"),
    "utf8",
  );
  const notesApplicationSource = readFileSync(
    resolve(process.cwd(), "src/application/notes/notes-application.ts"),
    "utf8",
  );
  const notesSessionSource = readFileSync(
    resolve(process.cwd(), "src/application/notes/notes-session.ts"),
    "utf8",
  );
  const notesCompositionSource = readFileSync(
    resolve(process.cwd(), "src/composition/notes.ts"),
    "utf8",
  );
  const habitStoreSource = readFileSync(
    resolve(process.cwd(), "src/stores/habit-store.ts"),
    "utf8",
  );
  const dataTransferServiceSource = readFileSync(
    resolve(
      process.cwd(),
      "src/application/data-transfer/data-transfer-service.ts",
    ),
    "utf8",
  );
  const dataTransferCompositionSource = readFileSync(
    resolve(process.cwd(), "src/composition/data-transfer.ts"),
    "utf8",
  );
  const dataTransferCoordinatorSource = readFileSync(
    resolve(
      process.cwd(),
      "src/application/data-transfer/data-transfer-coordinator.ts",
    ),
    "utf8",
  );
  const assertOrdered = (
    source: string,
    earlier: string,
    later: string,
    message: string,
    fromIndex = 0,
  ) => {
    const earlierIndex = source.indexOf(earlier, fromIndex);
    const laterIndex = source.indexOf(later, Math.max(fromIndex, earlierIndex));
    assert.ok(earlierIndex >= fromIndex, `${message}: missing ${earlier}`);
    assert.ok(laterIndex > earlierIndex, `${message}: invalid order`);
    return laterIndex;
  };
  for (const forbidden of [
    "@/data/sqlite",
    "@/application/notes/notes-cache",
    "runtimeDb.",
    "NOTE_COLUMNS",
    "RawNoteDatabaseRow",
    "mapNoteDatabaseRow",
    "INSERT INTO notes",
    "UPDATE notes",
    "DELETE FROM notes",
    "SELECT id FROM habits",
  ]) {
    assert.ok(
      !notesScreenSource.includes(forbidden),
      `Notes UI must not own SQLite or database-row mapping: ${forbidden}`,
    );
  }
  assert.match(
    notesScreenSource,
    /import \{[\s\S]{0,100}notesApplication[\s\S]{0,100}\} from "@\/composition\/notes"/,
    "Notes UI must depend only on the configured application-facing API",
  );
  assert.match(
    notesScreenSource,
    /useSyncExternalStore\([\s\S]{0,180}notesSession\.subscribe[\s\S]{0,180}notesSession\.getSnapshot/,
    "Notes UI must render the application-owned immutable session snapshot",
  );
  assert.match(
    notesScreenSource,
    /notesApplication\.getSession\(habitId\)/,
    "the route must acquire one per-habit NotesSession",
  );
  assert.match(
    notesScreenSource,
    /const noteKeyExtractor = \(item: NotesSessionNote\) => item\.clientMutationId/,
    "React keys must not change when an optimistic note receives its SQLite id",
  );
  for (const forbiddenOwner of [
    "setNoteList",
    "nextOptimisticNoteIdRef",
    "noteWriteTokensRef",
    "latestNotePersistenceRef",
    "confirmedNoteStatesRef",
    "notePersistenceIdsRef",
    "pendingCreateCommitRef",
    "pendingUpdateCommitRef",
    "pendingDeleteCommitRef",
    "pendingMutationRollbackRef",
    "resolvePersistedNoteId",
    "persistenceCommitScheduler",
    "notesApplication.trackPendingWrite",
    "notesApplication.waitForPersistenceTurn",
    "notesApplication.isWriteProtectedByFence",
  ]) {
    assert.ok(
      !notesScreenSource.includes(forbiddenOwner),
      `screen must not retain duplicate Notes data/concurrency ownership: ${forbiddenOwner}`,
    );
  }
  assert.match(
    notesScreenSource,
    /const habitId = parseHabitRouteId\(id\);[\s\S]{0,100}if \(habitId == null\) return <MissingNotesRoute \/>;[\s\S]{0,500}<NotesScreen[\s\S]{0,80}habitId=\{habitId\}/,
    "malformed dynamic ids must become a safe missing route before application/SQLite",
  );
  assert.match(
    habitRouteIdSource,
    /\^\[1-9\]\\d\*\$[\s\S]{0,120}Number\.isSafeInteger/,
  );
  assert.doesNotMatch(
    notesApplicationSource,
    /@\/data\/|@\/db\/|runtimeDb|NOTE_COLUMNS|\b(?:SELECT|INSERT|UPDATE|DELETE)\b/,
    "Notes application rules must depend on a repository port, not SQLite",
  );
  assert.match(
    notesApplicationSource,
    /await waitForPendingNotesWrites\(habitId\)[\s\S]{0,160}captureNotesCacheReadToken\(habitId\)[\s\S]{0,500}setCachedNotesIfCurrent/,
    "load must drain writes and guard every repository read with one generation token",
  );
  assert.match(
    notesApplicationSource,
    /if \(!readIsCurrent\) \{[\s\S]{0,100}staleReadCount \+= 1;[\s\S]{0,100}continue;/,
    "a stale read must retry instead of publishing an old snapshot",
  );
  assert.match(
    notesSessionSource,
    /for \(;;\) \{[\s\S]{0,500}gateway\.load[\s\S]{0,350}!this\.gateway\.isLoadResultCurrent\(loaded\)[\s\S]{0,100}continue/,
    "the session must close the final promise gap before publishing a loaded snapshot",
  );
  assert.match(
    notesApplicationSource,
    /const prewarm = async[\s\S]{0,700}repository\.getNotesForHabit\(habitId\)[\s\S]{0,100}setCachedNotesIfCurrent/,
    "prewarm must use the same repository port and generation-checked cache",
  );
  assert.match(
    notesCompositionSource,
    /createNotesApplication\(sqliteNoteRepository, \{[\s\S]*waitForCommitOpportunity[\s\S]*now:/,
    "the composition root must wire SQLite, paint scheduling and clock ports",
  );
  assert.doesNotMatch(
    notesCompositionSource,
    /runtimeDb|NOTE_COLUMNS|\b(?:SELECT|INSERT|UPDATE|DELETE)\b|new Map|useState|setNoteList/,
    "the composition root must not become a second behavior or state owner",
  );
  for (const repositoryContract of [
    "async function getNotesForHabit",
    "async function doesHabitExist",
    "async function createNote",
    "async function updateNoteText",
    "async function deleteNote",
    "export const sqliteNoteRepository: NoteRepository",
    "mapNoteDatabaseRow",
    "INSERT INTO notes",
    "UPDATE notes SET text = ?, updated_at = ? WHERE id = ?",
    "DELETE FROM notes WHERE id = ?",
  ]) {
    assert.ok(
      noteRepositorySource.includes(repositoryContract),
      `note repository must own ${repositoryContract}`,
    );
  }
  assert.match(
    notesApplicationSource,
    /getCachedSnapshot: peekCachedNotes/,
    "the render initializer must use the cache's pure peek",
  );
  assert.match(
    notesApplicationSource,
    /const sessions = createNotesSessionRegistry\(gateway\)[\s\S]{0,1500}getSession: sessions\.get/,
    "application must expose one real session owner instead of low-level mutation pieces",
  );
  assert.ok(
    !existsSync(
      resolve(process.cwd(), "src/features/notes/utils/note-list-state.ts"),
    ),
    "the retired presentation-owned rollback/id helper must be deleted",
  );
  for (const ownershipMarker of [
    "private readonly entitiesByUiId",
    "private snapshot: NotesSessionSnapshot",
    "nextOptimisticNoteId--",
    "clientMutationId",
    "persistedIdReady",
    "confirmed: Note | null",
    "latestRevision",
    "latestIntent",
    "registerWrite(",
    "handleCreateFailure(",
    "handleUpdateFailure(",
    "handleDeleteFailure(",
  ]) {
    assert.ok(
      notesSessionSource.includes(ownershipMarker),
      `NotesSession must own ${ownershipMarker}`,
    );
  }
  assert.match(
    notesScreenSource,
    /change\.source === "create"[\s\S]{0,180}noteInputRef\.current\?\.restoreDraft\(recovery\)/,
    "create rollback must restore its draft through the mounted composer owner",
  );
  assert.match(
    notesScreenSource,
    /change\.source === "update" \|\|[\s\S]{0,100}change\.source === "delete"[\s\S]{0,220}setNoteRecoveryDrafts/,
    "a failed delete after a failed edit must reopen the preserved editor draft",
  );
  assert.match(
    notesSessionSource,
    /readonly getSnapshot = \(\): NotesSessionSnapshot => this\.snapshot/,
    "useSyncExternalStore must receive a cached immutable snapshot reference",
  );
  assert.match(
    notesSessionSource,
    /for \(const session of \[\.\.\.sessions\.values\(\)\]\)/,
    "global import invalidation must not iterate a live LRU Map that publish mutates",
  );
  const createStart = notesSessionSource.indexOf("  create(text:");
  const createOptimisticCommit = assertOrdered(
    notesSessionSource,
    "this.publishMutation(",
    "this.registerWrite(entity",
    "create must publish its optimistic row before deferred persistence",
    createStart,
  );
  const createGate = assertOrdered(
    notesSessionSource,
    "this.gateway.waitForCommitOpportunity()",
    "this.gateway.waitForPersistenceTurn(write)",
    "create must keep foreground paint and transfer ordering before persistence",
    createOptimisticCommit,
  );
  assertOrdered(
    notesSessionSource,
    "this.gateway.waitForPersistenceTurn(write)",
    "this.gateway.create(record)",
    "create must not reach persistence before its durable gate",
    createGate,
  );
  assertOrdered(
    notesApplicationSource,
    "const persistedNote = await repository.createNote(record);",
    "upsertCachedNote(record.habitId, persistedNote);",
    "the application service must update cache only after confirmed create",
  );
  assertOrdered(
    notesSessionSource,
    "write = Promise.resolve().then(() => task(write, previousTail));",
    "this.gateway.trackPendingWrite(this.habitId, write)",
    "every command must enter the exact export barrier synchronously before its task microtask",
    notesSessionSource.indexOf("  private registerWrite("),
  );
  const updateStart = notesSessionSource.indexOf("  update(");
  const updateOptimisticCommit = assertOrdered(
    notesSessionSource,
    "this.publishMutation(",
    "this.registerWrite(entity",
    "note update must leave editing with optimistic text before persistence",
    updateStart,
  );
  assertOrdered(
    notesSessionSource,
    "this.gateway.waitForPersistenceTurn(write)",
    "entity.latestRevision !== revision",
    "a superseded rapid edit must be resolved after the transfer gate",
    updateOptimisticCommit,
  );
  assertOrdered(
    notesSessionSource,
    "this.gateway.isWriteProtectedByFence(",
    "const persistedId = await entity.persistedIdReady",
    "only the latest captured intent, or a required pre-cutoff intent, may reach SQLite",
    updateOptimisticCommit,
  );
  assertOrdered(
    notesApplicationSource,
    "await repository.updateNoteText(note.id, note.text, note.updatedAt);",
    "upsertCachedNote(note.habitId, note);",
    "the application service must update cache only after confirmed text",
  );
  const deleteStart = notesSessionSource.indexOf("  delete(noteId:");
  const deleteOptimisticCommit = assertOrdered(
    notesSessionSource,
    "this.publishMutation(",
    "this.registerWrite(entity",
    "note delete must disappear before persistence",
    deleteStart,
  );
  assertOrdered(
    notesSessionSource,
    "this.gateway.waitForPersistenceTurn(write)",
    "this.gateway.delete(this.habitId, persistedId)",
    "note delete must not start SQLite before its paint/background and transfer gates",
    deleteOptimisticCommit,
  );
  assertOrdered(
    notesApplicationSource,
    "await repository.deleteNote(noteId);",
    "removeCachedNote(habitId, noteId);",
    "the application service must update cache only after confirmed delete",
  );
  assertOrdered(
    habitStoreSource,
    "if (changesSchedule) invalidateNotesProjection(id);",
    "habitPersistence.persistScheduleEdit({",
    "schedule cleanup must invalidate before the atomic application protocol",
  );
  assertOrdered(
    habitStoreSource,
    "invalidateNotesProjection(habitId);",
    "persisted = await habitPersistence.markDay({",
    "reason-note creation must invalidate before the atomic application protocol",
    habitStoreSource.indexOf("async markDay"),
  );
  assertOrdered(
    habitStoreSource,
    "invalidateNotesProjection(id);",
    "await habitPersistence.deleteHabits(deletedIdList);",
    "habit deletion must invalidate before the application-owned cascade",
    habitStoreSource.indexOf("async deleteHabits"),
  );
  assert.match(
    dataTransferCompositionSource,
    /capturePendingNotesWriteFence[\s\S]*waitForPendingNotesWritesThrough[\s\S]*releasePendingNotesWriteFence/,
    "the composite transfer fence must include Notes capture/wait/release",
  );
  assert.match(
    dataTransferCompositionSource,
    /discardPostFence: outcome === "import-committed"/,
    "committed import must discard old-generation Notes commands",
  );
  assert.match(
    dataTransferCoordinatorSource,
    /readExportSnapshot<Snapshot>[\s\S]{0,500}this\.beginTransfer\(\);[\s\S]{0,500}fence = this\.durableMutations\.capture\(\);[\s\S]{0,500}readExportSnapshotAtCapturedFence/,
    "the accepted export must capture its fence synchronously",
  );
  assert.match(
    dataTransferCoordinatorSource,
    /readExportSnapshotAtCapturedFence[\s\S]{0,500}waitThrough\(dependencies\.fence\)[\s\S]{0,250}dependencies\.readConsistentSnapshot\(\)/,
    "export must snapshot only after waiting through the exact captured cutoff",
  );
  assert.match(
    dataTransferCoordinatorSource,
    /replaceImportedDataAtFence[\s\S]*waitThrough\(fence\)[\s\S]*replaceAtomically\(\)[\s\S]*publishCommittedSnapshot\(result\)[\s\S]*release\(fence, "import-committed"\)/,
    "import must replace, publish, then discard old post-cutoff commands",
  );
  assert.match(
    dataTransferServiceSource,
    /exportAllData\([\s\S]{0,900}const snapshotRequest = this\.dependencies\.readConsistentSnapshot\(\);[\s\S]{0,300}this\.completeExport/,
    "the export use case must synchronously request its exact cutoff before asynchronous codec/platform work",
  );
  assert.match(
    dataTransferCompositionSource,
    /readConsistentDataTransferSnapshot[\s\S]{0,160}dataTransferCoordinator\.readExportSnapshot/,
    "the composition boundary must delegate the snapshot protocol to the application coordinator",
  );
  clearCachedNotes();
  console.log("Notes cache audit passed.");
}
void main();
