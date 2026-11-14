export interface CurrentLocalDateStoreDependencies<TTimer> {
  readLocalDate(): string;
  millisecondsUntilNextLocalDay(): number;
  setTimer(callback: () => void, delayMs: number): TTimer;
  clearTimer(timer: TTimer): void;
  subscribeToAppActive(onActive: () => void): () => void;
}
export interface CurrentLocalDateStore {
  getSnapshot(): string;
  subscribe(listener: () => void): () => void;
}
/**
 * One external-store owner for the device's local calendar date. The owner is
 * shared by every React consumer, while lifecycle listeners and the midnight
 * timer exist only while at least one consumer is subscribed.
 */
export function createCurrentLocalDateStore<TTimer>(
  dependencies: CurrentLocalDateStoreDependencies<TTimer>,
): CurrentLocalDateStore {
  let currentDate = dependencies.readLocalDate();
  let midnightTimer: TTimer | null = null;
  let unsubscribeAppActive: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const scheduleNextMidnight = () => {
    if (midnightTimer != null) dependencies.clearTimer(midnightTimer);
    midnightTimer = dependencies.setTimer(
      refresh,
      dependencies.millisecondsUntilNextLocalDay(),
    );
  };
  const refresh = () => {
    const nextDate = dependencies.readLocalDate();
    if (nextDate !== currentDate) {
      currentDate = nextDate;
      for (const listener of [...listeners]) listener();
    }
    scheduleNextMidnight();
  };
  const startOwner = () => {
    if (unsubscribeAppActive != null) return;
    unsubscribeAppActive = dependencies.subscribeToAppActive(refresh);
    refresh();
  };
  const stopOwner = () => {
    unsubscribeAppActive?.();
    unsubscribeAppActive = null;
    if (midnightTimer != null) dependencies.clearTimer(midnightTimer);
    midnightTimer = null;
  };
  return {
    getSnapshot() {
      // Before the first subscriber, or between mounted scenes, read the
      // device clock directly so an initial render can never use yesterday.
      if (listeners.size === 0) currentDate = dependencies.readLocalDate();
      return currentDate;
    },
    subscribe(listener) {
      listeners.add(listener);
      startOwner();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopOwner();
      };
    },
  };
}
