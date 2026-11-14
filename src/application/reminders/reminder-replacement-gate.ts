export type ReminderReplacementOutcome =
  | "import-committed"
  | "import-aborted";

interface BufferedReminderWork {
  readonly run: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export interface ReminderReplacementBoundary {
  readonly id: number;
}

/**
 * Prevents native reminder mutations from crossing an imported database
 * replacement. Work already running is observed; work accepted after the
 * boundary is buffered and is either replayed after an aborted import or
 * discarded after a committed import followed by an authoritative rebuild.
 */
export class ReminderReplacementGate {
  private nextBoundaryId = 0;
  private activeBoundary: {
    readonly token: ReminderReplacementBoundary;
    readonly buffered: BufferedReminderWork[];
  } | null = null;
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly onUnhandledError: (error: unknown) => void,
    private readonly onImportCommitted: () => void = () => undefined,
  ) {}

  run(task: () => Promise<void>): Promise<void> {
    const boundary = this.activeBoundary;
    if (boundary) {
      return new Promise<void>((resolve, reject) => {
        boundary.buffered.push({ run: task, resolve, reject });
      });
    }
    return this.start(task);
  }

  schedule(task: () => Promise<void>): void {
    void this.run(task).catch(this.onUnhandledError);
  }

  enter(): ReminderReplacementBoundary {
    if (this.activeBoundary) {
      throw new Error("A reminder replacement boundary is already active");
    }
    const token = { id: ++this.nextBoundaryId };
    this.activeBoundary = { token, buffered: [] };
    return token;
  }

  async waitForRunning(): Promise<void> {
    // Jobs that started before enter() may synchronously start another tracked
    // job before their next await. Re-read to a fixed point.
    for (;;) {
      const pending = [...this.running];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  async release(
    token: ReminderReplacementBoundary,
    outcome: ReminderReplacementOutcome,
  ): Promise<void> {
    const boundary = this.activeBoundary;
    if (!boundary || boundary.token !== token) {
      throw new Error("Unknown reminder replacement boundary");
    }

    if (outcome === "import-committed") this.onImportCommitted();

    // Open admission before replay so replayed tasks run instead of buffering
    // themselves behind the boundary being released.
    this.activeBoundary = null;
    if (outcome === "import-committed") {
      for (const work of boundary.buffered) work.resolve();
      return;
    }

    // Preserve acceptance order on abort. Native notification mutations are
    // intentionally sequential elsewhere, so parallel replay would violate
    // the same platform contract.
    for (const work of boundary.buffered) {
      try {
        await this.start(work.run);
        work.resolve();
      } catch (error) {
        work.reject(error);
      }
    }
  }

  private start(task: () => Promise<void>): Promise<void> {
    let started: Promise<void>;
    try {
      // Admission must be synchronous. Deferred reminder schedulers register
      // ownership before returning; postponing task() to a microtask would let
      // an import observe an empty queue and overtake that accepted work.
      started = task();
    } catch (error) {
      started = Promise.reject(error);
    }
    let tracked!: Promise<void>;
    tracked = started.finally(() => {
        this.running.delete(tracked);
      });
    this.running.add(tracked);
    return tracked;
  }
}
