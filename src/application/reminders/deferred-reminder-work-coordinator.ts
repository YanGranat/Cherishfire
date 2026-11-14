import type { ReminderDeferredWorkHandle } from "@/application/reminders/reminder-ports";

export interface DeferredReminderWorkDependencies<Snapshot> {
  scheduleAfterUiSettles(task: () => void): ReminderDeferredWorkHandle;
  isAppActive(): boolean;
  runFullSync(snapshot: Snapshot): Promise<unknown>;
  runRecordSync(
    snapshot: Snapshot,
    habitIds: readonly number[],
  ): Promise<unknown>;
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
export class DeferredReminderWorkCoordinator<Snapshot> {
  private fullTask: ReminderDeferredWorkHandle | null = null;
  private fullSnapshot: Snapshot | null = null;
  private recordTask: ReminderDeferredWorkHandle | null = null;
  private recordSnapshot: Snapshot | null = null;
  private recordHabitIds = new Set<number>();
  private recordRunActive = false;
  private recordStartRequested = false;
  private localizationTask: ReminderDeferredWorkHandle | null = null;
  private localizationRequested = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly dependencies: DeferredReminderWorkDependencies<Snapshot>,
  ) {}

  scheduleFullSync(snapshot: Snapshot): void {
    this.fullSnapshot = snapshot;
    if (this.fullTask) return;
    if (!this.dependencies.isAppActive()) {
      this.startFullSyncNow();
      return;
    }
    this.fullTask = this.dependencies.scheduleAfterUiSettles(() => {
      this.startFullSyncNow();
    });
  }

  scheduleRecordSync(snapshot: Snapshot, habitId: number): void {
    this.recordSnapshot = snapshot;
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
    const snapshot = this.fullSnapshot;
    this.fullSnapshot = null;
    if (snapshot == null) return;
    this.runTracked("full-sync", () => this.dependencies.runFullSync(snapshot));
  }

  private startRecordSyncNow(): void {
    this.recordTask?.cancel();
    this.recordTask = null;
    if (this.recordRunActive) {
      // A fired idle/background/import callback has already admitted this
      // batch. Keep only its latest snapshot and unique habit IDs until the
      // current native batch reaches its terminal boundary instead of growing
      // a second queue behind the platform bridge.
      if (this.recordSnapshot != null && this.recordHabitIds.size > 0) {
        this.recordStartRequested = true;
      }
      return;
    }
    const snapshot = this.recordSnapshot;
    const habitIds = [...this.recordHabitIds];
    this.recordSnapshot = null;
    this.recordHabitIds.clear();
    if (snapshot == null || habitIds.length === 0) return;
    this.recordRunActive = true;
    this.runTracked("record-sync", async () => {
      try {
        await this.dependencies.runRecordSync(snapshot, habitIds);
      } finally {
        this.recordRunActive = false;
        if (this.recordStartRequested) {
          this.recordStartRequested = false;
          this.startRecordSyncNow();
        } else if (
          this.recordSnapshot != null &&
          this.recordHabitIds.size > 0
        ) {
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
      this.fullSnapshot != null ||
      this.recordTask != null ||
      this.recordSnapshot != null ||
      this.recordHabitIds.size > 0 ||
      this.recordStartRequested ||
      this.localizationTask != null ||
      this.localizationRequested
    );
  }
}
