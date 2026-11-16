import type { ReminderDeferredWorkHandle } from "@/application/reminders/reminder-ports";

export interface DeferredReminderWorkDependencies {
  scheduleAfterUiSettles(task: () => void): ReminderDeferredWorkHandle;
  isAppActive(): boolean;
  runFullSync(includesRecordChanges: boolean): Promise<unknown>;
  runRecordSync(habitIds: readonly number[]): Promise<unknown>;
  runLocalizationRefresh(): Promise<unknown>;
  onError(
    operation: "full-sync" | "record-sync" | "localization-refresh",
    error: unknown,
  ): void;
}

/**
 * Owns only admission and lifetime of deferred native reminder work. The
 * notification implementation remains a platform adapter; import needs this
 * small application owner so every accepted job has one observable terminal
 * boundary even when its UI-settle callback has not fired yet.
 */
export class DeferredReminderWorkCoordinator {
  private fullTask: ReminderDeferredWorkHandle | null = null;
  private fullRequested: "none" | "configuration" | "records" = "none";
  private recordTask: ReminderDeferredWorkHandle | null = null;
  private recordHabitIds = new Set<number>();
  private recordRunActive = false;
  private recordStartRequested = false;
  private localizationTask: ReminderDeferredWorkHandle | null = null;
  private localizationRequested = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly dependencies: DeferredReminderWorkDependencies,
  ) {}

  scheduleFullSync(): void {
    this.fullRequested =
      this.fullRequested === "records" ||
      this.recordRunActive ||
      this.recordHabitIds.size > 0
        ? "records"
        : "configuration";
    // A full read covers pending records and any running batch it preempts.
    // Carry that requirement past the configuration-signature fast path; the
    // application service owns the data, while this owner retains only intent.
    this.recordTask?.cancel();
    this.recordTask = null;
    this.recordHabitIds.clear();
    this.recordStartRequested = false;
    if (this.fullTask) return;
    if (!this.dependencies.isAppActive()) {
      this.startFullSyncNow();
      return;
    }
    this.fullTask = this.dependencies.scheduleAfterUiSettles(() => {
      this.startFullSyncNow();
    });
  }

  scheduleRecordSync(habitId: number): void {
    if (this.fullRequested !== "none") {
      this.fullRequested = "records";
      return;
    }
    this.recordHabitIds.add(habitId);
    if (this.recordRunActive || this.recordTask) return;
    this.schedulePendingRecordSync();
  }

  private schedulePendingRecordSync(): void {
    if (!this.dependencies.isAppActive()) {
      this.startRecordSyncNow();
      return;
    }
    this.recordTask = this.dependencies.scheduleAfterUiSettles(() => {
      this.startRecordSyncNow();
    });
  }

  scheduleLocalizationRefresh(): void {
    this.localizationRequested = true;
    this.localizationTask?.cancel();
    if (!this.dependencies.isAppActive()) {
      this.localizationTask = null;
      this.startLocalizationRefreshNow();
      return;
    }
    this.localizationTask = this.dependencies.scheduleAfterUiSettles(() => {
      this.startLocalizationRefreshNow();
    });
  }

  /**
   * Starts work that was accepted while the app was visible before React
   * Native can suspend frame/idle callbacks in background. The jobs remain
   * tracked by the same owner and import fence; this only changes admission
   * timing, not ordering or replacement semantics.
   */
  startAcceptedWorkNow(): void {
    this.startFullSyncNow();
    this.startRecordSyncNow();
    this.startLocalizationRefreshNow();
  }

  /**
   * Starts callbacks that were deliberately deferred for the response frame,
   * then waits to a fixed point. Work registered by a running job is observed
   * on the next loop instead of escaping behind the import transaction.
   */
  async flushAndWait(onQuiescent?: () => void): Promise<void> {
    for (;;) {
      this.startFullSyncNow();
      this.startRecordSyncNow();
      this.startLocalizationRefreshNow();

      const pending = [...this.pending];
      if (pending.length === 0 && !this.hasAcceptedWork()) {
        // The callback runs in the same JavaScript turn as the final ownership
        // check. Import uses it to close admission without a microtask-sized
        // gap in which a new native reminder job could escape.
        onQuiescent?.();
        return;
      }

      if (pending.length > 0) {
        await Promise.allSettled(pending);
      } else {
        // A scheduled callback can transfer its slot into the pending set in
        // the current turn. Re-read ownership after one microtask.
        await Promise.resolve();
      }
    }
  }

  private track(
    operation: "full-sync" | "record-sync" | "localization-refresh",
    job: Promise<unknown>,
  ): void {
    const tracked = job
      .catch((error) => {
        this.dependencies.onError(operation, error);
      })
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }

  private startFullSyncNow(): void {
    this.fullTask?.cancel();
    this.fullTask = null;
    const requested = this.fullRequested;
    if (requested === "none") return;
    this.fullRequested = "none";
    this.runTracked("full-sync", () =>
      this.dependencies.runFullSync(requested === "records"),
    );
  }

  private startRecordSyncNow(): void {
    this.recordTask?.cancel();
    this.recordTask = null;
    if (this.recordRunActive) {
      // A fired idle/background/import callback has already admitted this
      // batch. Keep its unique habit IDs until the current native batch
      // reaches its terminal boundary instead of growing
      // a second queue behind the platform bridge.
      if (this.recordHabitIds.size > 0) {
        this.recordStartRequested = true;
      }
      return;
    }
    const habitIds = [...this.recordHabitIds];
    this.recordHabitIds.clear();
    if (habitIds.length === 0) return;
    this.recordRunActive = true;
    this.runTracked("record-sync", async () => {
      try {
        await this.dependencies.runRecordSync(habitIds);
      } finally {
        this.recordRunActive = false;
        if (this.recordStartRequested) {
          this.recordStartRequested = false;
          this.startRecordSyncNow();
        } else if (this.recordHabitIds.size > 0) {
          // The next user-driven batch gets its own post-paint/idle admission.
          // Import and background explicitly set recordStartRequested above
          // and therefore retain their immediate fixed-point semantics.
          this.schedulePendingRecordSync();
        }
      }
    });
  }

  private startLocalizationRefreshNow(): void {
    this.localizationTask?.cancel();
    this.localizationTask = null;
    if (!this.localizationRequested) return;
    this.localizationRequested = false;
    this.runTracked("localization-refresh", () =>
      this.dependencies.runLocalizationRefresh(),
    );
  }

  private runTracked(
    operation: "full-sync" | "record-sync" | "localization-refresh",
    run: () => Promise<unknown>,
  ): void {
    let job: Promise<unknown>;
    try {
      job = run();
    } catch (error) {
      job = Promise.reject(error);
    }
    this.track(operation, job);
  }

  private hasAcceptedWork(): boolean {
    return (
      this.fullTask != null ||
      this.fullRequested !== "none" ||
      this.recordTask != null ||
      this.recordHabitIds.size > 0 ||
      this.recordStartRequested ||
      this.localizationTask != null ||
      this.localizationRequested
    );
  }
}
