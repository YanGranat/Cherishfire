interface PendingHabitWrite {
  sequence: number;
  settled: Promise<void>;
  capturedFence: ActiveHabitWriteFence | null;
  scheduleHabitId: number | null;
  recordHabitId: number | null;
  scheduleDependency: number;
  mustPersistSchedule: boolean;
}

export interface PendingHabitWriteFence {
  readonly owner: "habit";
  readonly id: number;
  readonly cutoffSequence: number;
}

export interface PendingHabitWriteFenceRelease {
  /** Import commit discards commands created against the pre-import dataset. */
  discardPostFence?: boolean;
}

export class DiscardedHabitWriteError extends Error {
  constructor() {
    super("Habit write was discarded after committed import");
    this.name = "DiscardedHabitWriteError";
  }
}

interface ActiveHabitWriteFence {
  token: PendingHabitWriteFence;
  released: Promise<boolean>;
  release(discardPostFence: boolean): void;
}

const pendingHabitWrites = new Map<number, PendingHabitWrite>();
const activeHabitWriteFences = new Map<number, ActiveHabitWriteFence>();
const scheduleRevisionByHabitId = new Map<number, number>();
let nextHabitWriteSequence = 0;
let nextHabitWriteFenceId = 0;
let currentStartingHabitWriteSequence: number | null = null;

export interface HabitReadBarrier {
  readonly revision: number;
  readonly settled: Promise<void>;
}

export interface HabitScheduleWriteBarrier extends HabitReadBarrier {
  readonly habitId: number;
  readonly hasPendingWrites: boolean;
}

/** Captures only predecessor schedule commands, never this record command. */
export function captureHabitScheduleWriteBarrier(
  habitId: number,
): HabitScheduleWriteBarrier {
  const writes = [...pendingHabitWrites.values()].filter(
    (write) => write.scheduleHabitId === habitId,
  );
  return {
    habitId,
    revision: scheduleRevisionByHabitId.get(habitId) ?? 0,
    hasPendingWrites: writes.length > 0,
    settled: Promise.all(writes.map((write) => write.settled)).then(() => undefined),
  };
}

export function isHabitScheduleWriteBarrierCurrent(
  barrier: HabitScheduleWriteBarrier,
): boolean {
  return barrier.revision === (scheduleRevisionByHabitId.get(barrier.habitId) ?? 0);
}

export function capturePredecessorHabitDataWrites(habitId: number): Promise<void> {
  const sequence = getCurrentHabitWriteSequence();
  return Promise.all(
    [...pendingHabitWrites.values()]
      .filter(
        (write) =>
          write.sequence < sequence &&
          (write.scheduleHabitId === habitId || write.recordHabitId === habitId),
      )
      .map((write) => write.settled),
  ).then(() => undefined);
}

/** A record admitted against this version must not lose its prerequisite. */
export function isHabitScheduleWriteRequired(
  habitId: number,
  sequence: number,
): boolean {
  return (
    pendingHabitWrites.get(sequence)?.mustPersistSchedule === true ||
    [...pendingHabitWrites.values()].some(
      (write) =>
        write.recordHabitId === habitId && write.scheduleDependency === sequence,
    )
  );
}

/** Accepted record pruning is irreversible; later edits cannot cancel it. */
export function retainDestructiveHabitScheduleWrite(sequence: number): void {
  const write = pendingHabitWrites.get(sequence);
  if (write?.scheduleHabitId != null) write.mustPersistSchedule = true;
}

export function forgetHabitScheduleWriteRevisions(
  habitIds: Iterable<number>,
): void {
  for (const habitId of habitIds) scheduleRevisionByHabitId.delete(habitId);
}

export function resetHabitScheduleWriteRevisions(): void {
  scheduleRevisionByHabitId.clear();
}

/** Observes accepted writes without creating or extending a transfer fence. */
export function captureHabitReadBarrier(): HabitReadBarrier {
  return {
    revision: nextHabitWriteSequence,
    settled: Promise.all(
      [...pendingHabitWrites.values()].map((write) => write.settled),
    ).then(() => undefined),
  };
}

export function isHabitReadBarrierCurrent(barrier: HabitReadBarrier): boolean {
  return barrier.revision === nextHabitWriteSequence;
}

function registerPendingHabitWriteSequence(
  sequence: number,
  scheduleHabitId: number | null,
  recordHabitId: number | null,
): () => void {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const capturedFence =
    [...activeHabitWriteFences.values()].find(
      ({ token }) => sequence > token.cutoffSequence,
    ) ?? null;
  pendingHabitWrites.set(sequence, {
    sequence,
    settled,
    capturedFence,
    scheduleHabitId,
    recordHabitId,
    mustPersistSchedule: false,
    scheduleDependency:
      recordHabitId == null ? 0 : (scheduleRevisionByHabitId.get(recordHabitId) ?? 0),
  });
  if (scheduleHabitId != null) {
    scheduleRevisionByHabitId.set(scheduleHabitId, sequence);
  }
  return () => {
    if (pendingHabitWrites.get(sequence)?.settled === settled) {
      pendingHabitWrites.delete(sequence);
    }
    settle();
  };
}

export function withPendingHabitWriteTracking<
  TArgs extends readonly unknown[],
  TResult,
>(
  action: (...args: TArgs) => Promise<TResult>,
  getScheduleHabitId?: (...args: TArgs) => number | null,
  getRecordHabitId?: (...args: TArgs) => number | null,
): (...args: TArgs) => Promise<TResult> {
  return (...args) => {
    const sequence = ++nextHabitWriteSequence;
    // Register before invoking presentation/state code. A synchronous store
    // subscriber can start export/import while the action is still applying
    // its optimistic state; that fence must already see this write.
    const settle = registerPendingHabitWriteSequence(
      sequence,
      getScheduleHabitId?.(...args) ?? null,
      getRecordHabitId?.(...args) ?? null,
    );
    const previousStartingSequence = currentStartingHabitWriteSequence;
    currentStartingHabitWriteSequence = sequence;
    let operation: Promise<TResult>;
    try {
      operation = action(...args);
    } catch (error) {
      operation = Promise.reject(error);
    } finally {
      currentStartingHabitWriteSequence = previousStartingSequence;
    }
    void operation.then(settle, settle);
    return operation;
  };
}

/** Capture synchronously at action entry, before its first await. */
export function getCurrentHabitWriteSequence(): number {
  if (currentStartingHabitWriteSequence == null) {
    throw new Error("Habit mutation started outside its persistence tracker");
  }
  return currentStartingHabitWriteSequence;
}

/** Create the exact cutoff and post-cutoff persistence gate atomically. */
export function capturePendingHabitWriteFence(): PendingHabitWriteFence {
  if (activeHabitWriteFences.size > 0) {
    throw new Error("A habit write fence is already active");
  }
  const token: PendingHabitWriteFence = {
    owner: "habit",
    id: ++nextHabitWriteFenceId,
    cutoffSequence: nextHabitWriteSequence,
  };
  let release!: (discardPostFence: boolean) => void;
  const released = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  activeHabitWriteFences.set(token.id, { token, released, release });
  return token;
}

/** Wait only operations registered at the exact capture cutoff. */
export async function waitForPendingHabitWritesThrough(
  fence: PendingHabitWriteFence,
): Promise<void> {
  const pendingAtCutoff = [...pendingHabitWrites.values()]
    .filter((write) => write.sequence <= fence.cutoffSequence)
    .map((write) => write.settled);
  await Promise.all(pendingAtCutoff);
}

/**
 * Called after the optimistic UI paint and before SQLite. `false` means a
 * committed import replaced the dataset, so the old command must disappear.
 */
export async function waitForHabitPersistenceTurn(
  writeSequence: number,
): Promise<boolean> {
  // Retain the gate observed at admission even when paint is delayed until
  // after its release. A committed import must still discard that old write.
  const capturedFence = pendingHabitWrites.get(writeSequence)?.capturedFence;
  const fences = new Set(activeHabitWriteFences.values());
  if (capturedFence) fences.add(capturedFence);
  const blockers = [...fences].filter(
    ({ token }) => writeSequence > token.cutoffSequence,
  );
  if (blockers.length === 0) return true;
  const outcomes = await Promise.all(blockers.map((fence) => fence.released));
  return outcomes.every((discarded) => !discarded);
}

/**
 * A pre-cutoff write only needs pinning when the visible intent that replaced
 * it was created after the cutoff. If both intents were captured, the newer
 * captured intent is sufficient and remains the sole persistence owner.
 */
export function isHabitWriteProtectedByFence(
  writeSequence: number,
  supersedingWriteSequence: number | null = null,
): boolean {
  return [...activeHabitWriteFences.values()].some(
    ({ token }) =>
      writeSequence <= token.cutoffSequence &&
      (supersedingWriteSequence == null ||
        supersedingWriteSequence > token.cutoffSequence),
  );
}

export function releasePendingHabitWriteFence(
  fence: PendingHabitWriteFence,
  options: PendingHabitWriteFenceRelease = {},
): void {
  const active = activeHabitWriteFences.get(fence.id);
  if (!active || active.token !== fence) return;
  activeHabitWriteFences.delete(fence.id);
  active.release(options.discardPostFence === true);
}
