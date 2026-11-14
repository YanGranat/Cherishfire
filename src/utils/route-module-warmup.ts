import { runWhenUiIsIdle, type ScheduledUiTask } from "@/utils/ui-scheduling";
export interface RouteModuleWarmupEntry {
  route: string;
  load: () => Promise<unknown>;
  /** Data/cache warmups must run again on later focus after invalidation. */
  repeatable?: boolean;
}
const warmedRoutes = new Set<string>();
const pendingRoutes = new Map<string, Promise<void>>();
/**
 * Evaluates likely next route modules and fills small route-owned caches only
 * while the current screen is already correct and idle. This never asks the
 * router to mount a hidden scene. Entries are deliberately serialized so
 * several cold tasks cannot form one long blocking burst.
 */
export function warmRouteModulesSequentially(
  entries: readonly RouteModuleWarmupEntry[],
): ScheduledUiTask {
  let cancelled = false;
  let scheduledTask: ScheduledUiTask | null = null;
  let nextIndex = 0;
  const scheduleNext = () => {
    if (cancelled) return;
    while (
      nextIndex < entries.length &&
      !entries[nextIndex].repeatable &&
      warmedRoutes.has(entries[nextIndex].route)
    ) {
      nextIndex += 1;
    }
    if (nextIndex >= entries.length) return;
    const entry = entries[nextIndex];
    nextIndex += 1;
    const existing = pendingRoutes.get(entry.route);
    if (existing) {
      void existing.finally(scheduleNext);
      return;
    }
    scheduledTask = runWhenUiIsIdle(() => {
      scheduledTask = null;
      if (cancelled || (!entry.repeatable && warmedRoutes.has(entry.route))) {
        scheduleNext();
        return;
      }
      let load: Promise<unknown>;
      try {
        load = entry.load();
      } catch {
        scheduleNext();
        return;
      }
      let completion!: Promise<void>;
      completion = load
        .then(() => {
          if (!entry.repeatable) warmedRoutes.add(entry.route);
        })
        .catch((error) => {})
        .finally(() => {
          if (pendingRoutes.get(entry.route) === completion) {
            pendingRoutes.delete(entry.route);
          }
          scheduleNext();
        });
      pendingRoutes.set(entry.route, completion);
    });
  };
  scheduleNext();
  return {
    cancel() {
      cancelled = true;
      scheduledTask?.cancel();
      scheduledTask = null;
    },
  };
}
