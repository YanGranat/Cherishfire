/**
 * A durable fence is captured synchronously when the application accepts a
 * single-flight data transfer. Its concrete shape belongs to the mutation
 * owners; this coordinator preserves their ordering contract with the database.
 */
export type DurableMutationFenceOutcome =
  | "export-finished"
  | "import-committed"
  | "import-aborted";

export interface DurableMutationFencePort<Fence> {
  /**
   * The owner must preserve the durable meaning of this cutoff. In
   * particular, a later latest-intent command cannot simply supersede a
   * pre-fence command and then remain queued until after the snapshot; that
   * would make the snapshot contain neither visible intent. Such an owner must
   * protect the pre-fence commit, or ensure the superseding commit is ordered
   * before the snapshot.
   */
  capture(): Fence;
  waitThrough(fence: Fence): Promise<void>;
  release(fence: Fence, outcome: DurableMutationFenceOutcome): void;
}

interface CapturedOwnerFence {
  waitThrough(): Promise<void>;
  release(outcome: DurableMutationFenceOutcome): void;
}

export interface DurableMutationFenceOwnerPort {
  capture(): CapturedOwnerFence;
}

/** Binds an owner's opaque fence type without weakening it to `any`. */
export function bindDurableMutationFenceOwner<Fence>(
  owner: DurableMutationFencePort<Fence>,
): DurableMutationFenceOwnerPort {
  return {
    capture() {
      const fence = owner.capture();
      return {
        waitThrough: () => owner.waitThrough(fence),
        release: (outcome) => owner.release(fence, outcome),
      };
    },
  };
}

interface CompositeDurableMutationFence {
  readonly entries: readonly {
    readonly fence: CapturedOwnerFence;
  }[];
}

/** Captures every durable owner in one JavaScript turn, before any await. */
export function createCompositeDurableMutationFencePort(
  owners: readonly DurableMutationFenceOwnerPort[],
): DurableMutationFencePort<CompositeDurableMutationFence> {
  return {
    capture() {
      const entries: {
        fence: CapturedOwnerFence;
      }[] = [];
      try {
        for (const owner of owners) {
          entries.push({ fence: owner.capture() });
        }
        return { entries };
      } catch (error) {
        // A partial composite fence must never leave an earlier owner blocked.
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          try {
            entries[index].fence.release("import-aborted");
          } catch {
            // Preserve the capture failure that explains why the composite
            // could not be formed; every captured owner still gets a release
            // attempt.
          }
        }
        throw error;
      }
    },
    async waitThrough(composite) {
      await Promise.all(
        composite.entries.map(({ fence }) => fence.waitThrough()),
      );
    },
    release(composite, outcome) {
      // Release in reverse capture order, like nested locks. Each owner owns
      // its own post-cutoff policy; committed import must discard, not replay.
      let firstError: unknown;
      for (let index = composite.entries.length - 1; index >= 0; index -= 1) {
        try {
          composite.entries[index].fence.release(outcome);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
  };
}

export interface ExportSnapshotDependencies<Snapshot> {
  readConsistentSnapshot(): Promise<Snapshot>;
}

export interface ImportReplacementDependencies<Result> {
  waitForApplicationEffects(): Promise<void>;
  enterPlatformReplacementBoundary(): Promise<PlatformReplacementBoundary>;
  replaceAtomically(): Promise<Result>;
  /**
   * Resets old projections and publishes the committed imported snapshot.
   * It must be safe to retry after a partial/failed publication.
   */
  publishCommittedSnapshot(result: Result): Promise<void>;
  reconcileCommittedPlatformState(): Promise<void>;
}

export interface PlatformReplacementBoundary {
  release(outcome: "import-committed" | "import-aborted"): Promise<void>;
}

export interface PublishedImport<Result> {
  readonly status: "published";
  readonly result: Result;
}

export interface BlockedImportPublication<Result> {
  readonly status: "publication-blocked";
  readonly result: Result;
  readonly error: unknown;
  /** Retries only publication; the already committed DB replacement is not repeated. */
  retryPublication(): Promise<void>;
}

export type ImportReplacementOutcome<Result> =
  | PublishedImport<Result>
  | BlockedImportPublication<Result>;

export class DataTransferPublicationBlockedError extends Error {
  constructor() {
    super("A committed import is waiting for in-memory publication recovery");
    this.name = "DataTransferPublicationBlockedError";
  }
}

export class DataTransferBusyError extends Error {
  constructor() {
    super("Another data transfer is already in progress");
    this.name = "DataTransferBusyError";
  }
}

/**
 * One application owner for export/import ordering. A transfer is single-flight
 * because every mutation owner intentionally permits only one active durable
 * fence. A duplicate confirmation is rejected before fence capture instead of
 * forming a partly captured composite or silently moving the export cutoff.
 */
export class DataTransferCoordinator<Fence> {
  private publicationRecoveryActive = false;
  private transferActive = false;

  constructor(
    private readonly durableMutations: DurableMutationFencePort<Fence>,
  ) {}

  private beginTransfer(): void {
    if (this.publicationRecoveryActive) {
      throw new DataTransferPublicationBlockedError();
    }
    if (this.transferActive) throw new DataTransferBusyError();
    this.transferActive = true;
  }

  private endTransfer(): void {
    this.transferActive = false;
  }

  readExportSnapshot<Snapshot>(
    dependencies: ExportSnapshotDependencies<Snapshot>,
  ): Promise<Snapshot> {
    let admitted = false;
    let fence: Fence;
    try {
      this.beginTransfer();
      admitted = true;
      // Capture in the same caller turn as confirmation. No await, file-system
      // import, or queue dispatch is allowed to move this cutoff later.
      fence = this.durableMutations.capture();
    } catch (error) {
      if (admitted) this.endTransfer();
      return Promise.reject(error);
    }

    return readExportSnapshotAtCapturedFence({
      durableMutations: this.durableMutations,
      fence,
      ...dependencies,
    }).finally(() => this.endTransfer());
  }

  async replaceImportedData<Result>(
    dependencies: ImportReplacementDependencies<Result>,
  ): Promise<ImportReplacementOutcome<Result>> {
    this.beginTransfer();
    try {
      const outcome = await replaceImportedDataAtFence({
        durableMutations: this.durableMutations,
        ...dependencies,
      });
      if (outcome.status !== "publication-blocked") return outcome;

      this.publicationRecoveryActive = true;
      let retryInFlight: Promise<void> | null = null;
      let recovered = false;
      return {
        ...outcome,
        retryPublication: () => {
          if (recovered) return Promise.resolve();
          if (retryInFlight) return retryInFlight;
          retryInFlight = outcome
            .retryPublication()
            .then(() => {
              recovered = true;
              this.publicationRecoveryActive = false;
            })
            .finally(() => {
              retryInFlight = null;
            });
          return retryInFlight;
        },
      };
    } finally {
      this.endTransfer();
    }
  }
}

export interface ExportSnapshotAtFenceDependencies<Fence, Snapshot>
  extends ExportSnapshotDependencies<Snapshot> {
  durableMutations: DurableMutationFencePort<Fence>;
}

interface ExportSnapshotAtCapturedFenceDependencies<Fence, Snapshot>
  extends ExportSnapshotAtFenceDependencies<Fence, Snapshot> {
  fence: Fence;
}

async function readExportSnapshotAtCapturedFence<Fence, Snapshot>(
  dependencies: ExportSnapshotAtCapturedFenceDependencies<Fence, Snapshot>,
): Promise<Snapshot> {
  try {
    await dependencies.durableMutations.waitThrough(dependencies.fence);
    return await dependencies.readConsistentSnapshot();
  } finally {
    dependencies.durableMutations.release(
      dependencies.fence,
      "export-finished",
    );
  }
}

/**
 * Captures before the first await in the owned transfer turn. Later mutations
 * must not extend this fence or starve the snapshot.
 */
export async function readExportSnapshotAtFence<Fence, Snapshot>(
  dependencies: ExportSnapshotAtFenceDependencies<Fence, Snapshot>,
): Promise<Snapshot> {
  const fence = dependencies.durableMutations.capture();
  return readExportSnapshotAtCapturedFence({ ...dependencies, fence });
}

export interface ImportReplacementAtFenceDependencies<Fence, Result>
  extends ImportReplacementDependencies<Result> {
  durableMutations: DurableMutationFencePort<Fence>;
}

/**
 * Import ordering is intentionally sequential:
 *
 * 1. settle durable commands accepted before the import cutoff;
 * 2. settle application effects those commands may register;
 * 3. settle and freeze platform work those effects may register;
 * 4. replace and verify every table in one transaction;
 * 5. reset/publish the new in-memory generation;
 * 6. discard old post-cutoff commands and open their persistence gates.
 *
 * Combining stages 1-3 with Promise.all is incorrect because an earlier
 * stage is allowed to register work owned by the next stage.
 */
export async function replaceImportedDataAtFence<Fence, Result>(
  dependencies: ImportReplacementAtFenceDependencies<Fence, Result>,
): Promise<ImportReplacementOutcome<Result>> {
  const fence = dependencies.durableMutations.capture();
  let committed = false;
  let platformBoundary: PlatformReplacementBoundary | null = null;
  try {
    await dependencies.durableMutations.waitThrough(fence);
    await dependencies.waitForApplicationEffects();
    const acquiredPlatformBoundary =
      await dependencies.enterPlatformReplacementBoundary();
    platformBoundary = acquiredPlatformBoundary;
    const result = await dependencies.replaceAtomically();
    committed = true;

    let snapshotPublished = false;
    let durableFenceReleased = false;
    let platformBoundaryReleased = false;
    let platformReconciled = false;
    const completeCommittedPublication = async (): Promise<void> => {
      if (!snapshotPublished) {
        await dependencies.publishCommittedSnapshot(result);
        snapshotPublished = true;
      }
      if (!durableFenceReleased) {
        dependencies.durableMutations.release(fence, "import-committed");
        durableFenceReleased = true;
      }
      if (!platformBoundaryReleased) {
        await acquiredPlatformBoundary.release("import-committed");
        platformBoundaryReleased = true;
      }
      if (!platformReconciled) {
        await dependencies.reconcileCommittedPlatformState();
        platformReconciled = true;
      }
    };

    try {
      await completeCommittedPublication();
    } catch (error) {
      // The imported DB is authoritative now, but old projections still are
      // not. Keep the fence closed so neither old nor new commands can mutate
      // coincidentally reused IDs until publication/finalization succeeds.
      // The closure remembers each completed stage, so a retry never repeats
      // the database replacement or releases an owner twice.
      return {
        status: "publication-blocked",
        result,
        error,
        retryPublication: completeCommittedPublication,
      };
    }
    return { status: "published", result };
  } finally {
    if (!committed) {
      try {
        await platformBoundary?.release("import-aborted");
      } finally {
        dependencies.durableMutations.release(fence, "import-aborted");
      }
    }
  }
}
