import type { StatisticsBlockId } from "@/types/settings";

/**
 * A reordered scene still contains the same keyed rows. This identity changes
 * only when a period adds or removes a block, so callers can invalidate drag
 * geometry without remounting the persistent native scene.
 */
export function getStatisticsSceneMembershipKey(
  visibleOrder: readonly StatisticsBlockId[],
): string {
  return [...visibleOrder].sort().join(",");
}

/**
 * A pure reorder keeps both membership and geometry revision. New period or
 * content geometry gets a new presentation identity even when it contains the
 * same block set; the persistent scene uses it for an in-place geometry handoff
 * instead of using it as a React key.
 */
export function getStatisticsScenePresentationKey(
  visibleOrder: readonly StatisticsBlockId[],
  geometryRevision: string | number,
): string {
  return `${getStatisticsSceneMembershipKey(visibleOrder)}|${geometryRevision}`;
}
