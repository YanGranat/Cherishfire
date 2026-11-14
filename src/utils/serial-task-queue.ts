export interface SerialTaskQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  whenIdle(): Promise<void>;
}

interface PendingSerialTask {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Runs async tasks in submission order while keeping the queue usable after a
 * rejected task. An explicit FIFO keeps the idle path in the submitting turn;
 * chaining every task from Promise.resolve() would add an avoidable dispatch
 * microtask even when no predecessor exists.
 */
export function createSerialTaskQueue(): SerialTaskQueue {
  const pending: PendingSerialTask[] = [];
  let active = false;
  let idlePromise: Promise<void> = Promise.resolve();
  let resolveIdle: (() => void) | null = null;

  const finishActiveTask = () => {
    const next = pending.shift();
    if (next) {
      execute(next);
      return;
    }

    active = false;
    const resolveCurrentIdle = resolveIdle;
    resolveIdle = null;
    resolveCurrentIdle?.();
  };

  const execute = (entry: PendingSerialTask) => {
    active = true;

    let result: Promise<unknown>;
    try {
      result = Promise.resolve(entry.task());
    } catch (error) {
      entry.reject(error);
      finishActiveTask();
      return;
    }

    result.then(
      (value) => {
        entry.resolve(value);
        finishActiveTask();
      },
      (error) => {
        entry.reject(error);
        finishActiveTask();
      }
    );
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const entry: PendingSerialTask = {
          task,
          resolve: (value) => resolve(value as T),
          reject,
        };

        if (active) {
          pending.push(entry);
          return;
        }

        idlePromise = new Promise<void>((idleResolve) => {
          resolveIdle = idleResolve;
        });
        execute(entry);
      });
    },

    whenIdle(): Promise<void> {
      return idlePromise;
    },
  };
}
