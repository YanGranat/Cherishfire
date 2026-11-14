import type { StatisticsBlockId } from "@/types/settings";

export type StatisticsScenePhase =
  "ready" | "preparing-visible" | "preparing-hidden" | "overlap";

export interface StatisticsScenePresentation {
  sourceRevision: string | number;
  revision: string;
  attempt: number;
  nativeOrder: StatisticsBlockId[];
  phase: StatisticsScenePhase;
}

export interface StatisticsScenePresentationRequest {
  sourceRevision: string | number;
  revision: string;
  targetOrder: readonly StatisticsBlockId[];
  nativeLayoutDirty: boolean;
  transformedOrderKey: string | null;
  overlayVisible: boolean;
}

export function areStatisticsBlockOrdersEqual(
  left: readonly StatisticsBlockId[],
  right: readonly StatisticsBlockId[],
): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

export function getStatisticsBlockOrderKey(
  order: readonly StatisticsBlockId[],
): string {
  return order.join("|");
}

export function getStatisticsSceneRevision(
  geometryRevision: string | number,
  targetOrder: readonly StatisticsBlockId[],
): string {
  return JSON.stringify([geometryRevision, ...targetOrder]);
}

/**
 * A clean scene visually owns its normal-flow native order. After a drop, the
 * same native rows visually own the latest transformed order instead. This
 * distinction lets the optimistic store commit reuse the tuned drag scene,
 * while a rollback or an external order update still starts a safe rebase.
 */
export function doesStatisticsSceneMatchTarget(
  nativeOrder: readonly StatisticsBlockId[],
  targetOrder: readonly StatisticsBlockId[],
  nativeLayoutDirty: boolean,
  transformedOrderKey: string | null,
): boolean {
  return nativeLayoutDirty
    ? transformedOrderKey === getStatisticsBlockOrderKey(targetOrder)
    : areStatisticsBlockOrdersEqual(nativeOrder, targetOrder);
}

export function doesStatisticsPendingSceneMatchTarget(
  sourceRevision: string | number,
  targetSourceRevision: string | number,
  nativeOrder: readonly StatisticsBlockId[],
  targetOrder: readonly StatisticsBlockId[],
  isPreparing: boolean,
): boolean {
  return (
    isPreparing &&
    sourceRevision === targetSourceRevision &&
    areStatisticsBlockOrdersEqual(nativeOrder, targetOrder)
  );
}

export interface StatisticsCommittedDropRebaseState {
  nativeLayoutDirty: boolean;
  overlayVisible: boolean;
  sceneReady: boolean;
  geometryChanged: boolean;
  transformedOrderKey: string | null;
  targetOrder: readonly StatisticsBlockId[];
}

/**
 * A successful drag initially keeps the old native row order and expresses the
 * accepted order with UI-thread transforms. Once its overlay has fully settled,
 * immediately rebase those same keyed rows into normal Yoga flow instead of
 * carrying dirty transforms into the next period presentation.
 */
export function shouldRebaseCommittedStatisticsDrop({
  nativeLayoutDirty,
  overlayVisible,
  sceneReady,
  geometryChanged,
  transformedOrderKey,
  targetOrder,
}: StatisticsCommittedDropRebaseState): boolean {
  return (
    nativeLayoutDirty &&
    !overlayVisible &&
    sceneReady &&
    !geometryChanged &&
    transformedOrderKey === getStatisticsBlockOrderKey(targetOrder)
  );
}

export function isStatisticsSceneRevisionCurrent(
  latestRevision: string | number,
  candidateRevision: string | number,
): boolean {
  return latestRevision === candidateRevision;
}

export interface StatisticsPresentationLayoutSample {
  revision: string | number;
  height: number;
}

export type StatisticsPresentationLayoutSamples = Partial<
  Record<StatisticsBlockId, StatisticsPresentationLayoutSample>
>;

/**
 * Resolves one presentation only from revision-tagged React Native layout
 * events. No native view lookup is involved, so a row removed by a rapid
 * week/month/year switch cannot leave a stale ShadowNode to measure.
 */
export function resolveStatisticsPresentationHeights(
  targetOrder: readonly StatisticsBlockId[],
  revision: string | number,
  nativeSamples: StatisticsPresentationLayoutSamples,
  fallbackSamples: StatisticsPresentationLayoutSamples | null,
  tolerance: number,
): number[] | null {
  if (
    targetOrder.length === 0 ||
    !Number.isFinite(tolerance) ||
    tolerance < 0
  ) {
    return null;
  }

  const heights: number[] = [];
  for (const id of targetOrder) {
    const nativeSample = nativeSamples[id];
    if (
      nativeSample?.revision !== revision ||
      !Number.isFinite(nativeSample.height) ||
      nativeSample.height <= 0
    ) {
      return null;
    }

    if (fallbackSamples != null) {
      const fallbackSample = fallbackSamples[id];
      if (
        fallbackSample?.revision !== revision ||
        !Number.isFinite(fallbackSample.height) ||
        fallbackSample.height <= 0 ||
        Math.abs(fallbackSample.height - nativeSample.height) > tolerance
      ) {
        return null;
      }
    }

    heights.push(nativeSample.height);
  }

  return heights;
}

/**
 * A clean scene owns no non-zero idle transforms, so React may reorder the
 * persistent keyed rows directly in ordinary Yoga flow while drag geometry is
 * proved. Only a scene left transformed by a completed drop needs the exact
 * target-flow fallback during its in-place rebase.
 */
export function requiresStatisticsSceneFallback(
  nativeLayoutDirty: boolean,
): boolean {
  return nativeLayoutDirty;
}

/**
 * Resolves the next atomic scene presentation, or null when the current scene
 * already owns the requested target. The caller may use the result for a
 * conditional same-component render adjustment: React retries that component
 * before rendering its children, so a clean target row tree is reconciled once
 * instead of once before and once after a layout-effect state update.
 */
export function resolveNextStatisticsScenePresentation(
  current: StatisticsScenePresentation,
  request: StatisticsScenePresentationRequest,
): StatisticsScenePresentation | null {
  const geometryChanged = current.sourceRevision !== request.sourceRevision;
  const targetMatchesCurrentScene = doesStatisticsSceneMatchTarget(
    current.nativeOrder,
    request.targetOrder,
    request.nativeLayoutDirty,
    request.transformedOrderKey,
  );
  const postDropRebaseRequired = shouldRebaseCommittedStatisticsDrop({
    nativeLayoutDirty: request.nativeLayoutDirty,
    overlayVisible: request.overlayVisible,
    sceneReady: current.phase === "ready",
    geometryChanged,
    transformedOrderKey: request.transformedOrderKey,
    targetOrder: request.targetOrder,
  });
  const alreadyPreparingTarget = doesStatisticsPendingSceneMatchTarget(
    current.sourceRevision,
    request.sourceRevision,
    current.nativeOrder,
    request.targetOrder,
    current.phase !== "ready",
  );

  if (
    alreadyPreparingTarget ||
    (!geometryChanged && targetMatchesCurrentScene && !postDropRebaseRequired)
  ) {
    return null;
  }

  const attempt = current.attempt + 1;
  return {
    sourceRevision: request.sourceRevision,
    revision: JSON.stringify([request.revision, attempt]),
    attempt,
    nativeOrder: request.targetOrder.slice(),
    phase: requiresStatisticsSceneFallback(request.nativeLayoutDirty)
      ? "preparing-hidden"
      : "preparing-visible",
  };
}
