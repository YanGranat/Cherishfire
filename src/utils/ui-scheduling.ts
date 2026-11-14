import { InteractionManager } from "react-native";
export type ScheduledUiTask = {
  cancel(): void;
};
type IdleCapableGlobal = typeof globalThis & {
  requestIdleCallback?: (
    callback: (deadline: {
      didTimeout?: boolean;
      timeRemaining?: () => number;
    }) => void,
    options?: {
      timeout?: number;
    },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};
// Optional, non-preemptible work must not start in the last sliver of an idle
// callback. Eight milliseconds is one complete 120 Hz frame budget; if the
// host cannot offer that much time, the task can safely wait for another idle
// slot because runWhenUiIsIdle deliberately has no eventual-execution promise.
const MIN_SPECULATIVE_IDLE_BUDGET_MS = 8;
/**
 * Gives the requested state one frame to commit and a second frame to reach
 * the native surface before starting non-visual work. This is intentionally
 * not a one-frame response primitive.
 */
export function runAfterUiPaint(task: () => void): ScheduledUiTask {
  let cancelled = false;
  let firstFrame = 0;
  let secondFrame = 0;
  firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => {
      if (!cancelled) task();
    });
  });
  return {
    cancel() {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    },
  };
}
/**
 * Resolves only after React has had one frame to commit requested state and a
 * second frame to publish it to the native surface. Use this before starting
 * synchronous persistence/CPU work that must not compete with the visible
 * optimistic response.
 */
export function waitForUiPaint(): Promise<void> {
  return new Promise((resolve) => {
    runAfterUiPaint(resolve);
  });
}
/**
 * Runs non-visual work after the requested state has painted and the JS thread
 * becomes idle. The timeout guarantees eventual execution on a busy device.
 */
export function runAfterUiSettles(
  task: () => void,
  timeoutMs = 1500,
): ScheduledUiTask {
  let cancelled = false;
  let idleHandle: number | null = null;
  let interactionTask: ReturnType<
    typeof InteractionManager.runAfterInteractions
  > | null = null;
  const runtimeGlobal = globalThis as IdleCapableGlobal;
  const frameTask = runAfterUiPaint(() => {
    if (cancelled) return;
    if (typeof runtimeGlobal.requestIdleCallback === "function") {
      idleHandle = runtimeGlobal.requestIdleCallback(
        () => {
          idleHandle = null;
          if (!cancelled) task();
        },
        { timeout: timeoutMs },
      );
      return;
    }
    interactionTask = InteractionManager.runAfterInteractions(() => {
      interactionTask = null;
      if (!cancelled) task();
    });
  });
  return {
    cancel() {
      cancelled = true;
      frameTask.cancel();
      if (
        idleHandle != null &&
        typeof runtimeGlobal.cancelIdleCallback === "function"
      ) {
        runtimeGlobal.cancelIdleCallback(idleHandle);
      }
      interactionTask?.cancel();
    },
  };
}
/**
 * Runs speculative work only during genuine idle time. Unlike
 * runAfterUiSettles this deliberately has no timeout: a cold dynamic import is
 * non-preemptible in a release bundle, so optional warmup must never be forced
 * into the middle of a user's interaction merely to guarantee eventual work.
 */
export function runWhenUiIsIdle(task: () => void): ScheduledUiTask {
  let cancelled = false;
  let idleHandle: number | null = null;
  let interactionTask: ReturnType<
    typeof InteractionManager.runAfterInteractions
  > | null = null;
  const runtimeGlobal = globalThis as IdleCapableGlobal;
  const frameTask = runAfterUiPaint(() => {
    if (cancelled) return;
    if (typeof runtimeGlobal.requestIdleCallback === "function") {
      const requestIdleSlot = () => {
        idleHandle =
          runtimeGlobal.requestIdleCallback?.((deadline) => {
            idleHandle = null;
            if (cancelled) return;
            const remainingMs =
              typeof deadline?.timeRemaining === "function"
                ? deadline.timeRemaining()
                : Number.POSITIVE_INFINITY;
            if (remainingMs < MIN_SPECULATIVE_IDLE_BUDGET_MS) {
              requestIdleSlot();
              return;
            }
            task();
          }) ?? null;
      };
      requestIdleSlot();
      return;
    }
    interactionTask = InteractionManager.runAfterInteractions(() => {
      interactionTask = null;
      if (!cancelled) task();
    });
  });
  return {
    cancel() {
      cancelled = true;
      frameTask.cancel();
      if (
        idleHandle != null &&
        typeof runtimeGlobal.cancelIdleCallback === "function"
      ) {
        runtimeGlobal.cancelIdleCallback(idleHandle);
      }
      interactionTask?.cancel();
    },
  };
}
