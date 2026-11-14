export interface NavigationIntentToken {
  readonly generation: number;
  readonly target: string;
}
export interface NavigationIntentGateController {
  acquire(target: string): NavigationIntentToken | null;
  getActive(): NavigationIntentToken | null;
  release(token: NavigationIntentToken): boolean;
  reset(): void;
}
export interface NavigationIntentWatchdogScheduler<THandle> {
  schedule(callback: () => void, delayMs: number): THandle;
  cancel(handle: THandle): void;
}
export interface NavigationIntentWatchdog {
  arm(token: NavigationIntentToken, timeoutMs: number): void;
  clear(): void;
}
/**
 * Owns one in-flight navigation intent for a retained source scene.
 *
 * Tokens are generation-scoped: a late watchdog or cleanup from an older
 * intent cannot release a newer one after focus returns.
 */
export function createNavigationIntentGateController(): NavigationIntentGateController {
  let generation = 0;
  let active: NavigationIntentToken | null = null;
  return {
    acquire(target) {
      if (active != null) return null;
      generation += 1;
      active = { generation, target };
      return active;
    },
    getActive: () => active,
    release(token) {
      if (active?.generation !== token.generation) return false;
      active = null;
      return true;
    },
    reset() {
      generation += 1;
      active = null;
    },
  };
}
/**
 * Owns the delayed "dispatch was silently ignored" decision.
 *
 * A stale timer cannot release a newer generation, and a blurred source cannot
 * release an intent accepted after focus returns.
 */
export function createNavigationIntentWatchdog<THandle>(args: {
  controller: NavigationIntentGateController;
  isSourceFocused: () => boolean;
  scheduler: NavigationIntentWatchdogScheduler<THandle>;
}): NavigationIntentWatchdog {
  let pendingHandle: THandle | null = null;
  const clear = () => {
    if (pendingHandle == null) return;
    args.scheduler.cancel(pendingHandle);
    pendingHandle = null;
  };
  return {
    arm(token, timeoutMs) {
      clear();
      let scheduledHandle: THandle;
      scheduledHandle = args.scheduler.schedule(() => {
        if (pendingHandle !== scheduledHandle) return;
        pendingHandle = null;
        if (!args.isSourceFocused()) return;
        if (!args.controller.release(token)) return;
      }, timeoutMs);
      pendingHandle = scheduledHandle;
    },
    clear,
  };
}
