import { format } from "date-fns/format";

import type { NewNoteRecord } from "@/application/notes/note-repository";
import type { Note } from "@/types/note";

const MAX_RETAINED_NOTES_SESSIONS = 48;
const MAX_PRESENTATION_CHANGES = 64;

let nextOptimisticNoteId = -1;
let nextClientMutationSequence = 0;

export type NotesMutationErrorKind = "save" | "delete";
export type NotesExternalChange =
  | { readonly kind: "reason-notes-removed"; readonly dates: readonly string[] }
  | { readonly kind: "habit-deleted" };
export type NotesSessionStatus =
  | "idle"
  | "loading"
  | "ready"
  | "missing"
  | "load-error";

export interface NotesSessionNote extends Note {
  /** Stable React identity; it never changes when SQLite assigns an id. */
  readonly clientMutationId: string;
}

export interface NotesPresentationChange {
  readonly sequence: number;
  readonly kind: "created" | "updated" | "deleted" | "rollback";
  readonly source: "create" | "update" | "delete";
  readonly clientMutationId: string;
  readonly noteId: number;
  readonly expectedPresent: boolean;
  readonly expectedText: string | null;
  readonly expectedUpdatedAt: number | null;
  /** Failed user draft retained until a presentation owner claims it. */
  readonly recoveryText?: string | null;
}

export interface NotesSessionSnapshot {
  readonly revision: number;
  readonly generation: number;
  readonly status: NotesSessionStatus;
  readonly habitExists: boolean | null;
  readonly notes: readonly NotesSessionNote[];
  readonly mutationError: NotesMutationErrorKind | null;
  readonly presentationChanges: readonly NotesPresentationChange[];
}

export interface NotesLoadResult {
  readonly notes: readonly Note[];
  readonly habitExists: boolean;
  readonly staleReadCount: number;
}

export interface NotesSessionGateway {
  getCachedSnapshot(habitId: number): readonly Note[] | null;
  load(
    habitId: number,
    getKnownHabitExists: () => boolean | null,
  ): Promise<NotesLoadResult>;
  isLoadResultCurrent(result: NotesLoadResult): boolean;
  create(record: NewNoteRecord): Promise<Note>;
  update(note: Note): Promise<void>;
  delete(habitId: number, noteId: number): Promise<void>;
  trackPendingWrite<T>(habitId: number, write: Promise<T>): Promise<T>;
  waitForPersistenceTurn(write: Promise<unknown>): Promise<boolean>;
  isWriteProtectedByFence(
    write: Promise<unknown>,
    supersedingWrite?: Promise<unknown> | null,
  ): boolean;
  waitForCommitOpportunity(): Promise<void>;
  now(): Date;
}

export interface NotesMutationSubmission {
  readonly accepted: boolean;
  readonly revision: number;
  readonly clientMutationId: string | null;
}

export interface NotesSession {
  readonly habitId: number;
  getSnapshot(): NotesSessionSnapshot;
  subscribe(listener: () => void): () => void;
  ensureLoaded(getKnownHabitExists: () => boolean | null): Promise<void>;
  reload(getKnownHabitExists: () => boolean | null): Promise<void>;
  create(text: string): NotesMutationSubmission;
  update(noteId: number, text: string): NotesMutationSubmission;
  delete(noteId: number): NotesMutationSubmission;
  acknowledgeRecovery(generation: number, sequence: number): boolean;
  whenIdle(): Promise<void>;
}

function hasUnclaimedRecovery(change: NotesPresentationChange): boolean {
  return change.kind === "rollback" && change.recoveryText != null;
}

function retainPresentationChanges(
  changes: readonly NotesPresentationChange[],
): readonly NotesPresentationChange[] {
  const retained: NotesPresentationChange[] = [];
  let ordinaryCount = 0;
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];
    if (hasUnclaimedRecovery(change)) retained.push(change);
    else if (ordinaryCount < MAX_PRESENTATION_CHANGES) {
      retained.push(change);
      ordinaryCount += 1;
    }
  }
  return retained.reverse();
}

interface NoteEntityState {
  readonly uiId: number;
  readonly clientMutationId: string;
  /** Stable chronological position inside this authoritative session generation. */
  readonly orderOrdinal: number;
  persistedId: number | null;
  persistedIdReady: Promise<number | null>;
  confirmed: Note | null;
  latestRevision: number;
  latestIntent: "confirmed" | "create" | "update" | "delete";
  latestWrite: Promise<void> | null;
  persistenceTail: Promise<void> | null;
}

function createDisplayedNote(
  note: Note,
  uiId: number,
  clientMutationId: string,
): NotesSessionNote {
  return { ...note, id: uiId, clientMutationId };
}

function createPersistedClientMutationId(habitId: number, id: number): string {
  return `persisted:${habitId}:${id}`;
}

function createOptimisticClientMutationId(habitId: number): string {
  nextClientMutationSequence += 1;
  return `optimistic:${habitId}:${nextClientMutationSequence}`;
}

class NotesSessionImpl implements NotesSession {
  readonly habitId: number;

  private readonly listeners = new Set<() => void>();
  private readonly entitiesByUiId = new Map<number, NoteEntityState>();
  private snapshot: NotesSessionSnapshot;
  private generation = 0;
  private revision = 0;
  private changeSequence = 0;
  private nextOrderOrdinal = 0;
  private pendingWriteCount = 0;
  private loadInFlight: Promise<void> | null = null;
  private reloadAfterCurrentLoad: (() => boolean | null) | null = null;
  private idleWaiters = new Set<() => void>();

  constructor(
    habitId: number,
    private readonly gateway: NotesSessionGateway,
    private readonly onActivity: () => void,
  ) {
    this.habitId = habitId;
    const cached = gateway.getCachedSnapshot(habitId);
    const notes = cached ? this.replaceAuthoritativeEntities(cached) : [];
    this.snapshot = {
      revision: 0,
      generation: 0,
      status: cached ? "ready" : "idle",
      habitExists: cached ? true : null,
      notes,
      mutationError: null,
      presentationChanges: [],
    };
  }

  readonly getSnapshot = (): NotesSessionSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.onActivity();
    return () => {
      this.listeners.delete(listener);
      this.onActivity();
    };
  };

  hasSubscribers(): boolean {
    return this.listeners.size > 0;
  }

  hasPendingWork(): boolean {
    return this.pendingWriteCount > 0 || this.loadInFlight != null;
  }

  hasUnclaimedRecovery(): boolean {
    return this.snapshot.presentationChanges.some(hasUnclaimedRecovery);
  }

  acknowledgeRecovery(generation: number, sequence: number): boolean {
    if (generation !== this.generation) return false;
    const recovery = this.snapshot.presentationChanges.find(
      (change) => change.sequence === sequence && hasUnclaimedRecovery(change),
    );
    if (!recovery) return false;
    this.publish({
      presentationChanges: retainPresentationChanges(
        this.snapshot.presentationChanges.map((change) =>
          change === recovery ? { ...change, recoveryText: null } : change,
        ),
      ),
    });
    return true;
  }

  getResourceCounts() {
    return {
      listenerCount: this.listeners.size,
      pendingWriteCount: this.pendingWriteCount,
      loadCount: Number(this.loadInFlight != null),
      entityCount: this.entitiesByUiId.size,
      waiterCount: this.idleWaiters.size,
    };
  }

  invalidateAuthoritativeProjection(
    resetDataset = false,
    change?: NotesExternalChange,
  ): void {
    if (resetDataset || change?.kind === "habit-deleted") {
      this.generation += 1;
      this.entitiesByUiId.clear();
      if (change?.kind === "habit-deleted") this.reloadAfterCurrentLoad = null;
      this.publish({
        status: change?.kind === "habit-deleted" ? "missing" : "idle",
        habitExists: change?.kind === "habit-deleted" ? false : null,
        notes: [],
        mutationError: null,
        presentationChanges: [],
      });
      return;
    }
    // A refresh of the same habit does not revoke accepted note commands or
    // replace the identity of an editor that is still mounted.
    if (change?.kind === "reason-notes-removed") {
      const dates = new Set(change.dates);
      const removedClients = new Set<string>();
      const wasRemoved = (note: Note) =>
        dates.has(note.date) &&
        (note.isFailureReason ||
          note.reasonType === "failure" ||
          note.reasonType === "skipped");
      for (const [id, entity] of this.entitiesByUiId) {
        if (entity.confirmed != null && wasRemoved(entity.confirmed)) {
          removedClients.add(entity.clientMutationId);
          this.entitiesByUiId.delete(id);
        }
      }
      this.publish({
        status: "idle",
        notes: this.snapshot.notes.filter((note) => !wasRemoved(note)),
        presentationChanges: retainPresentationChanges(
          this.snapshot.presentationChanges.map((item) =>
            removedClients.has(item.clientMutationId)
              ? { ...item, recoveryText: null }
              : item,
          ),
        ),
      });
      return;
    }
    this.publish({ status: "idle" });
  }

  ensureLoaded(getKnownHabitExists: () => boolean | null): Promise<void> {
    if (
      this.snapshot.status !== "idle" &&
      this.snapshot.status !== "load-error"
    ) {
      return this.loadInFlight ?? Promise.resolve();
    }
    return this.startLoad(getKnownHabitExists);
  }

  reload(getKnownHabitExists: () => boolean | null): Promise<void> {
    return this.startLoad(getKnownHabitExists, true);
  }

  create(text: string): NotesMutationSubmission {
    const trimmed = text.trim();
    if (!trimmed || this.snapshot.habitExists !== true) {
      return this.rejectedSubmission();
    }

    const now = this.gateway.now();
    const uiId = nextOptimisticNoteId--;
    const clientMutationId = createOptimisticClientMutationId(this.habitId);
    const record: NewNoteRecord = {
      habitId: this.habitId,
      date: format(now, "yyyy-MM-dd"),
      text: trimmed,
      isFailureReason: false,
      reasonType: null,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
    const revision = this.nextRevision();
    let resolvePersistedId!: (id: number | null) => void;
    const persistedIdReady = new Promise<number | null>((resolve) => {
      resolvePersistedId = resolve;
    });
    const entity: NoteEntityState = {
      uiId,
      clientMutationId,
      orderOrdinal: this.nextOrderOrdinal++,
      persistedId: null,
      persistedIdReady,
      confirmed: null,
      latestRevision: revision,
      latestIntent: "create",
      latestWrite: null,
      persistenceTail: null,
    };
    this.entitiesByUiId.set(uiId, entity);
    const optimisticNote = createDisplayedNote(
      { ...record, id: uiId },
      uiId,
      clientMutationId,
    );
    this.publishMutation(
      [...this.snapshot.notes, optimisticNote],
      {
        kind: "created",
        source: "create",
        clientMutationId,
        noteId: uiId,
        expectedPresent: true,
        expectedText: optimisticNote.text,
        expectedUpdatedAt: optimisticNote.updatedAt,
      },
      null,
      revision,
    );

    this.registerWrite(entity, async (write, previousTail) => {
      try {
        const predecessor =
          previousTail?.catch(() => undefined) ?? Promise.resolve();
        const paint = this.gateway.waitForCommitOpportunity();
        await Promise.all([predecessor, paint]);
        const persistenceTurn = this.gateway.waitForPersistenceTurn(write);
        if (!(await persistenceTurn)) {
          resolvePersistedId(null);
          return;
        }
        try {
          const persisted = await this.gateway.create(record);
          resolvePersistedId(persisted.id);
          if (!this.isCurrentEntity(entity)) return;
          entity.persistedId = persisted.id;
          entity.confirmed = persisted;
          if (entity.latestRevision === revision) {
            entity.latestIntent = "confirmed";
          }
        } catch {
          resolvePersistedId(null);
          this.handleCreateFailure(entity, revision);
        }
      } catch {
        resolvePersistedId(null);
        this.handleCreateFailure(entity, revision);
      }
    });
    return {
      accepted: true,
      revision,
      clientMutationId,
    };
  }

  update(noteId: number, text: string): NotesMutationSubmission {
    const trimmed = text.trim();
    const entity = this.entitiesByUiId.get(noteId);
    const current = this.snapshot.notes.find((note) => note.id === noteId);
    if (!trimmed || !entity || !current || entity.latestIntent === "delete") {
      return this.rejectedSubmission();
    }
    if (current.text === trimmed) {
      return {
        accepted: true,
        revision: this.snapshot.revision,
        clientMutationId: entity.clientMutationId,
      };
    }

    const now = this.gateway.now();
    const revision = this.nextRevision();
    entity.latestRevision = revision;
    entity.latestIntent = "update";
    const optimisticNote: NotesSessionNote = {
      ...current,
      text: trimmed,
      updatedAt: now.getTime(),
    };
    this.publishMutation(
      this.snapshot.notes.map((note) =>
        note.id === noteId ? optimisticNote : note,
      ),
      {
        kind: "updated",
        source: "update",
        clientMutationId: entity.clientMutationId,
        noteId,
        expectedPresent: true,
        expectedText: optimisticNote.text,
        expectedUpdatedAt: optimisticNote.updatedAt,
      },
      null,
      revision,
    );

    const capturedGeneration = this.generation;
    this.registerWrite(entity, async (write, previousTail) => {
      try {
        const predecessor =
          previousTail?.catch(() => undefined) ?? Promise.resolve();
        const paint = this.gateway.waitForCommitOpportunity();
        await Promise.all([predecessor, paint]);
        const persistenceTurn = this.gateway.waitForPersistenceTurn(write);
        if (!(await persistenceTurn)) return;
        if (
          entity.latestRevision !== revision &&
          entity.latestIntent !== "delete" &&
          !this.gateway.isWriteProtectedByFence(write, entity.latestWrite)
        ) {
          return;
        }
        const persistedId = await entity.persistedIdReady;
        if (persistedId == null) return;
        const persistedNote: Note = {
          id: persistedId,
          habitId: current.habitId,
          date: current.date,
          text: trimmed,
          isFailureReason: current.isFailureReason,
          reasonType: current.reasonType,
          createdAt: current.createdAt,
          updatedAt: optimisticNote.updatedAt,
        };
        try {
          await this.gateway.update(persistedNote);
          if (
            capturedGeneration === this.generation &&
            this.isCurrentEntity(entity)
          ) {
            entity.persistedId = persistedId;
            entity.confirmed = persistedNote;
            if (entity.latestRevision === revision) {
              entity.latestIntent = "confirmed";
            }
          }
        } catch {
          this.handleUpdateFailure(entity, revision, capturedGeneration);
        }
      } catch {
        this.handleUpdateFailure(entity, revision, capturedGeneration);
      }
    });
    return {
      accepted: true,
      revision,
      clientMutationId: entity.clientMutationId,
    };
  }

  delete(noteId: number): NotesMutationSubmission {
    const entity = this.entitiesByUiId.get(noteId);
    const index = this.snapshot.notes.findIndex((note) => note.id === noteId);
    const previousNote = this.snapshot.notes[index];
    if (!entity || !previousNote || entity.latestIntent === "delete") {
      return this.rejectedSubmission();
    }

    const revision = this.nextRevision();
    entity.latestRevision = revision;
    entity.latestIntent = "delete";
    this.publishMutation(
      this.snapshot.notes.filter((note) => note.id !== noteId),
      {
        kind: "deleted",
        source: "delete",
        clientMutationId: entity.clientMutationId,
        noteId,
        expectedPresent: false,
        expectedText: null,
        expectedUpdatedAt: null,
      },
      null,
      revision,
    );

    const capturedGeneration = this.generation;
    this.registerWrite(entity, async (write, previousTail) => {
      try {
        const predecessor =
          previousTail?.catch(() => undefined) ?? Promise.resolve();
        const paint = this.gateway.waitForCommitOpportunity();
        await Promise.all([predecessor, paint]);
        const persistenceTurn = this.gateway.waitForPersistenceTurn(write);
        if (!(await persistenceTurn)) return;
        const persistedId = await entity.persistedIdReady;
        if (persistedId == null) return;
        try {
          await this.gateway.delete(this.habitId, persistedId);
          if (
            capturedGeneration === this.generation &&
            this.isCurrentEntity(entity) &&
            entity.latestRevision === revision
          ) {
            this.entitiesByUiId.delete(noteId);
          }
        } catch {
          this.handleDeleteFailure(
            entity,
            revision,
            previousNote,
            capturedGeneration,
          );
        }
      } catch {
        this.handleDeleteFailure(
          entity,
          revision,
          previousNote,
          capturedGeneration,
        );
      }
    });
    return {
      accepted: true,
      revision,
      clientMutationId: entity.clientMutationId,
    };
  }

  whenIdle(): Promise<void> {
    if (this.pendingWriteCount === 0 && this.loadInFlight == null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private startLoad(
    getKnownHabitExists: () => boolean | null,
    force = false,
  ): Promise<void> {
    if (this.loadInFlight) {
      // An invalidation can replace the generation while the old SELECT is in
      // flight. A focused consumer that asks again owns the retry; a retained
      // but blurred screen does not race the external transaction that caused
      // the invalidation.
      if (force || this.snapshot.status === "idle") {
        this.reloadAfterCurrentLoad = getKnownHabitExists;
      }
      return this.loadInFlight;
    }
    if (
      !force &&
      this.snapshot.status !== "idle" &&
      this.snapshot.status !== "load-error"
    ) {
      return Promise.resolve();
    }

    const capturedGeneration = this.generation;
    this.publish({
      status: "loading",
    });
    let request!: Promise<void>;
    request = (async () => {
      try {
        for (;;) {
          const loaded = await this.gateway.load(
            this.habitId,
            getKnownHabitExists,
          );
          const isCurrent = this.gateway.isLoadResultCurrent(loaded);
          if (capturedGeneration !== this.generation) {
            return;
          }
          if (!isCurrent) {
            continue;
          }
          const notes = loaded.habitExists
            ? this.replaceAuthoritativeEntities(loaded.notes)
            : [];
          this.publish({
            status: loaded.habitExists ? "ready" : "missing",
            habitExists: loaded.habitExists,
            notes,
            ...(!loaded.habitExists ? { presentationChanges: [] } : {}),
          });
          return;
        }
      } catch {
        if (capturedGeneration !== this.generation) {
          return;
        }
        this.publish({ status: "load-error" });
      }
    })().finally(() => {
      if (this.loadInFlight === request) this.loadInFlight = null;
      const restart = this.reloadAfterCurrentLoad;
      this.reloadAfterCurrentLoad = null;
      if (restart) void this.startLoad(restart, true);
      this.resolveIdleIfNeeded();
      this.onActivity();
    });
    this.loadInFlight = request;
    return request;
  }

  private registerWrite(
    entity: NoteEntityState,
    task: (
      write: Promise<void>,
      previousTail: Promise<void> | null,
    ) => Promise<void>,
  ): void {
    const previousTail = entity.persistenceTail;
    let write!: Promise<void>;
    // The task starts in a microtask, after the exact export/import tracker has
    // synchronously assigned this promise its durable sequence.
    write = Promise.resolve().then(() => task(write, previousTail));
    const tracked = this.gateway.trackPendingWrite(this.habitId, write);
    entity.persistenceTail = tracked;
    entity.latestWrite = tracked;
    this.pendingWriteCount += 1;
    void tracked.finally(() => {
      if (entity.persistenceTail === tracked) entity.persistenceTail = null;
      if (entity.latestWrite === tracked) entity.latestWrite = null;
      this.pendingWriteCount = Math.max(0, this.pendingWriteCount - 1);
      this.resolveIdleIfNeeded();
      this.onActivity();
    });
  }

  private handleCreateFailure(entity: NoteEntityState, revision: number): void {
    if (!this.isCurrentEntity(entity)) return;
    const stillVisible = this.snapshot.notes.some(
      (note) => note.id === entity.uiId,
    );
    // A later delete already reached the desired durable absence. Do not show
    // a stale create error or resurrect the row it intentionally removed.
    if (entity.latestIntent === "delete" && !stillVisible) {
      this.entitiesByUiId.delete(entity.uiId);
      return;
    }
    const failedDraft = this.snapshot.notes.find(
      (note) => note.id === entity.uiId,
    )?.text;
    this.entitiesByUiId.delete(entity.uiId);
    if (!stillVisible) return;
    const rollbackRevision = this.nextRevision();
    this.publishMutation(
      this.snapshot.notes.filter((note) => note.id !== entity.uiId),
      {
        kind: "rollback",
        source: "create",
        clientMutationId: entity.clientMutationId,
        noteId: entity.uiId,
        expectedPresent: false,
        expectedText: null,
        expectedUpdatedAt: null,
        recoveryText: failedDraft ?? null,
      },
      "save",
      Math.max(revision, rollbackRevision),
    );
  }

  private handleUpdateFailure(
    entity: NoteEntityState,
    revision: number,
    capturedGeneration: number,
  ): void {
    if (
      capturedGeneration !== this.generation ||
      !this.isCurrentEntity(entity) ||
      entity.latestRevision !== revision ||
      entity.latestIntent !== "update" ||
      !entity.confirmed
    ) {
      return;
    }
    const failedDraft = this.snapshot.notes.find(
      (note) => note.id === entity.uiId,
    )?.text;
    const restored = createDisplayedNote(
      entity.confirmed,
      entity.uiId,
      entity.clientMutationId,
    );
    const rollbackRevision = this.nextRevision();
    entity.latestRevision = rollbackRevision;
    entity.latestIntent = "confirmed";
    this.publishMutation(
      this.snapshot.notes.map((note) =>
        note.id === entity.uiId ? restored : note,
      ),
      {
        kind: "rollback",
        source: "update",
        clientMutationId: entity.clientMutationId,
        noteId: entity.uiId,
        expectedPresent: true,
        expectedText: restored.text,
        expectedUpdatedAt: restored.updatedAt,
        recoveryText: failedDraft ?? null,
      },
      "save",
      rollbackRevision,
    );
  }

  private handleDeleteFailure(
    entity: NoteEntityState,
    revision: number,
    previousNote: NotesSessionNote,
    capturedGeneration: number,
  ): void {
    if (
      capturedGeneration !== this.generation ||
      !this.isCurrentEntity(entity) ||
      entity.latestRevision !== revision ||
      entity.latestIntent !== "delete"
    ) {
      return;
    }
    const restored = entity.confirmed
      ? createDisplayedNote(
          entity.confirmed,
          entity.uiId,
          entity.clientMutationId,
        )
      : previousNote;
    const recoveryText =
      previousNote.text === restored.text ? null : previousNote.text;
    const notes = this.snapshot.notes.some((note) => note.id === entity.uiId)
      ? this.snapshot.notes
      : this.sortNotesByEntityOrder([...this.snapshot.notes, restored]);
    const rollbackRevision = this.nextRevision();
    entity.latestRevision = rollbackRevision;
    entity.latestIntent = "confirmed";
    this.publishMutation(
      notes,
      {
        kind: "rollback",
        source: "delete",
        clientMutationId: entity.clientMutationId,
        noteId: entity.uiId,
        expectedPresent: true,
        expectedText: restored.text,
        expectedUpdatedAt: restored.updatedAt,
        recoveryText,
      },
      "delete",
      rollbackRevision,
    );
  }

  private replaceAuthoritativeEntities(
    notes: readonly Note[],
  ): readonly NotesSessionNote[] {
    const replace = () => {
      const previousByPersistedId = new Map(
        [...this.entitiesByUiId.values()]
          .filter((entity) => entity.persistedId != null)
          .map((entity) => [entity.persistedId!, entity]),
      );
      this.entitiesByUiId.clear();
      this.nextOrderOrdinal = 0;
      return notes.map((note) => {
        const existing = previousByPersistedId.get(note.id);
        if (existing) {
          const entity: NoteEntityState = {
            ...existing,
            orderOrdinal: this.nextOrderOrdinal++,
            confirmed: { ...note },
            latestIntent: "confirmed",
            latestWrite: null,
            persistenceTail: null,
          };
          this.entitiesByUiId.set(entity.uiId, entity);
          return createDisplayedNote(note, entity.uiId, entity.clientMutationId);
        }
        const clientMutationId = createPersistedClientMutationId(
          this.habitId,
          note.id,
        );
        const entity: NoteEntityState = {
          uiId: note.id,
          clientMutationId,
          orderOrdinal: this.nextOrderOrdinal++,
          persistedId: note.id,
          persistedIdReady: Promise.resolve(note.id),
          confirmed: { ...note },
          latestRevision: 0,
          latestIntent: "confirmed",
          latestWrite: null,
          persistenceTail: null,
        };
        this.entitiesByUiId.set(note.id, entity);
        return createDisplayedNote(note, note.id, clientMutationId);
      });
    };
    return replace();
  }

  private publishMutation(
    notes: readonly NotesSessionNote[],
    change: Omit<NotesPresentationChange, "sequence">,
    mutationError: NotesMutationErrorKind | null,
    revision: number,
  ): void {
    this.changeSequence += 1;
    const presentationChange: NotesPresentationChange = {
      ...change,
      sequence: this.changeSequence,
    };
    const previousChanges = change.kind === "updated" || change.kind === "deleted"
      ? this.snapshot.presentationChanges.map((item) =>
        item.clientMutationId === change.clientMutationId && hasUnclaimedRecovery(item)
          ? { ...item, recoveryText: null }
          : item,
      )
      : this.snapshot.presentationChanges;
    const presentationChanges = retainPresentationChanges([
      ...previousChanges,
      presentationChange,
    ]);
    this.publish({ notes, mutationError, presentationChanges }, revision);
  }

  private sortNotesByEntityOrder(
    notes: readonly NotesSessionNote[],
  ): readonly NotesSessionNote[] {
    return [...notes].sort((left, right) => {
      const leftOrder =
        this.entitiesByUiId.get(left.id)?.orderOrdinal ??
        Number.MAX_SAFE_INTEGER;
      const rightOrder =
        this.entitiesByUiId.get(right.id)?.orderOrdinal ??
        Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
  }

  private publish(
    patch: Partial<Omit<NotesSessionSnapshot, "revision" | "generation">>,
    explicitRevision?: number,
  ): void {
    const publish = () => {
      const revision = explicitRevision ?? this.nextRevision();
      this.snapshot = {
        ...this.snapshot,
        ...patch,
        revision,
        generation: this.generation,
      };
      for (const listener of [...this.listeners]) listener();
      this.onActivity();
    };
    publish();
  }

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  private isCurrentEntity(entity: NoteEntityState): boolean {
    return this.entitiesByUiId.get(entity.uiId) === entity;
  }

  private rejectedSubmission(): NotesMutationSubmission {
    return {
      accepted: false,
      revision: this.snapshot.revision,
      clientMutationId: null,
    };
  }

  private resolveIdleIfNeeded(): void {
    if (this.pendingWriteCount !== 0 || this.loadInFlight != null) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}

export interface NotesSessionRegistry {
  get(habitId: number): NotesSession;
  invalidate(habitId: number | null, change?: NotesExternalChange): void;
  getResourceCounts(): Record<string, number>;
}

export function createNotesSessionRegistry(
  gateway: NotesSessionGateway,
): NotesSessionRegistry {
  const sessions = new Map<number, NotesSessionImpl>();

  const trim = (protectedSession?: NotesSessionImpl) => {
    if (sessions.size <= MAX_RETAINED_NOTES_SESSIONS) return;
    for (const [habitId, session] of sessions) {
      if (sessions.size <= MAX_RETAINED_NOTES_SESSIONS) break;
      // `get` must never return a session that its own LRU cleanup already
      // removed before React can subscribe or a command can register a write.
      if (session === protectedSession) continue;
      if (session.hasSubscribers() || session.hasPendingWork() || session.hasUnclaimedRecovery()) continue;
      sessions.delete(habitId);
    }
  };

  const touch = (habitId: number, session: NotesSessionImpl) => {
    if (sessions.get(habitId) === session) {
      sessions.delete(habitId);
      sessions.set(habitId, session);
    }
    trim(session);
  };

  return {
    getResourceCounts() {
      const totals: Record<string, number> = {
        sessionCount: sessions.size,
        listenerCount: 0,
        pendingWriteCount: 0,
        loadCount: 0,
        entityCount: 0,
        waiterCount: 0,
      };
      for (const session of sessions.values()) {
        for (const [key, count] of Object.entries(session.getResourceCounts()))
          totals[key] += count;
      }
      return totals;
    },
    get(habitId) {
      const existing = sessions.get(habitId);
      if (existing) {
        touch(habitId, existing);
        return existing;
      }
      let session!: NotesSessionImpl;
      session = new NotesSessionImpl(habitId, gateway, () =>
        touch(habitId, session),
      );
      sessions.set(habitId, session);
      trim(session);
      return session;
    },
    invalidate(habitId, change) {
      if (habitId == null) {
        // `invalidateAuthoritativeProjection` publishes and therefore touches
        // the LRU Map. Never iterate that live Map while its entries are being
        // deleted/reinserted by `onActivity`.
        for (const session of [...sessions.values()]) {
          session.invalidateAuthoritativeProjection(true);
        }
      } else {
        sessions.get(habitId)?.invalidateAuthoritativeProjection(false, change);
      }
      trim();
    },
  };
}
