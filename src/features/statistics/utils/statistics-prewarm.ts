import {
  getStatisticsPeriod,
  type StatisticsPeriodTarget,
  type StatisticsSourceSnapshot,
} from "@/application/statistics/statistics-session";
import { runWhenUiIsIdle, type ScheduledUiTask } from "@/utils/ui-scheduling";
function uniqueTargets(
  targets: readonly StatisticsPeriodTarget[],
): StatisticsPeriodTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.period}:${target.periodOffset}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/**
 * Presentation-side orchestration: it chooses when optional work may run,
 * while the application statistics service owns what is calculated. Keeping
 * the scheduler here prevents application/domain code from
 * depending on React Native's frame and idle primitives.
 */
export function scheduleStatisticsPeriodsPrewarm(
  source: StatisticsSourceSnapshot,
  targets: readonly StatisticsPeriodTarget[],
  onComplete?: () => void,
): ScheduledUiTask {
  const pendingTargets = uniqueTargets(targets);
  let cancelled = false;
  let targetIndex = 0;
  let scheduledTask: ScheduledUiTask | null = null;
  const scheduleNextIdleSlot = () => {
    scheduledTask = runWhenUiIsIdle(() => {
      if (cancelled) return;
      while (!cancelled && targetIndex < pendingTargets.length) {
        const target = pendingTargets[targetIndex];
        targetIndex += 1;
        const result = getStatisticsPeriod(
          source,
          target.period,
          target.periodOffset,
        );
        if (!result.cacheHit) break;
      }
      if (!cancelled && targetIndex < pendingTargets.length) {
        scheduleNextIdleSlot();
      } else if (!cancelled) {
        onComplete?.();
      }
    });
  };
  if (pendingTargets.length > 0) scheduleNextIdleSlot();
  else onComplete?.();
  return {
    cancel() {
      cancelled = true;
      scheduledTask?.cancel();
    },
  };
}
