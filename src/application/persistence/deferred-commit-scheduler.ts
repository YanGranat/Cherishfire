export interface PersistenceCommitVisibilityPort {
  isAppActive(): boolean;
  waitForUiPaint(): Promise<void>;
  subscribeToAppState(listener: (isActive: boolean) => void): () => void;
  scheduleFallback(listener: () => void, delayMs: number): () => void;
}

export interface PersistenceCommitScheduler {
  /**
   * Preserve the foreground two-frame optimistic paint, but never make a
   * durable write depend on RAF callbacks that can stop in background.
   */
  waitForCommitOpportunity(): Promise<void>;
}

export function createPersistenceCommitScheduler(
  visibility: PersistenceCommitVisibilityPort,
  maxPaintWaitMs = 100,
): PersistenceCommitScheduler {
  return {
    waitForCommitOpportunity() {
      if (!visibility.isAppActive()) return Promise.resolve();

      return new Promise<void>((resolve) => {
        let settled = false;
        let unsubscribe = () => {};
        let cancelFallback = () => {};
        const finish = () => {
          if (settled) return;
          settled = true;
          unsubscribe();
          cancelFallback();
          resolve();
        };

        let registeredUnsubscribe: () => void;
        try {
          registeredUnsubscribe = visibility.subscribeToAppState(
            (isActive) => {
              if (!isActive) finish();
            },
          );
        } catch {
          // AppState observation is a durability safeguard, not a prerequisite
          // for persistence. A broken adapter must fall through immediately.
          finish();
          return;
        }
        unsubscribe = registeredUnsubscribe;
        // A synchronous subscriber or an AppState change between the first
        // read and subscription must not leak the listener.
        if (settled) {
          unsubscribe();
          return;
        }
        if (!visibility.isAppActive()) {
          finish();
          return;
        }

        let registeredCancelFallback: () => void;
        try {
          registeredCancelFallback = visibility.scheduleFallback(
            finish,
            maxPaintWaitMs,
          );
        } catch {
          // A missing frame signal must never become an unbounded durability
          // wait. If even the fallback scheduler is unavailable, write now.
          finish();
          return;
        }
        cancelFallback = registeredCancelFallback;
        if (settled) {
          cancelFallback();
          return;
        }

        try {
          void visibility.waitForUiPaint().then(finish, finish);
        } catch {
          // A scheduling adapter must never be able to strand durability.
          finish();
        }
      });
    },
  };
}
