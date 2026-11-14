import {
  areStatisticsSourcesEqual,
  type StatisticsPeriodResult,
  type StatisticsSourceSnapshot,
} from "@/application/statistics/statistics-session";
import { getStatisticsPeriodRange } from "@/domain/statistics/statistics-period";
import type { StatisticsPeriod } from "@/types/settings";

export interface StatisticsPreparationTarget {
  period: StatisticsPeriod;
  periodOffset: number;
}

export interface StatisticsPresentationBase
  extends StatisticsPreparationTarget {
  revision: number;
  source: StatisticsSourceSnapshot;
}

export interface StatisticsReadyPresentation
  extends StatisticsPresentationBase {
  state: "ready";
  result: StatisticsPeriodResult;
}

export interface StatisticsLoadingPresentation
  extends StatisticsPresentationBase {
  state: "loading";
}

export interface StatisticsErrorPresentation
  extends StatisticsPresentationBase {
  state: "error";
}

export type StatisticsPresentation =
  | StatisticsReadyPresentation
  | StatisticsLoadingPresentation
  | StatisticsErrorPresentation;

/**
 * The request describes the selector and semantic state. A last ready scene is
 * retained independently so loading or error masking never remounts the
 * ScrollView and its native rows.
 */
export interface StatisticsPresentationEnvelope {
  request: StatisticsPresentation | null;
  retainedReadyScene: StatisticsReadyPresentation | null;
  sceneExposed: boolean;
}

export function createStatisticsPresentationEnvelope(
  initial: StatisticsReadyPresentation | null,
): StatisticsPresentationEnvelope {
  return {
    request: initial,
    retainedReadyScene: initial,
    sceneExposed: initial != null,
  };
}

export function publishStatisticsPresentation(
  current: StatisticsPresentationEnvelope,
  next: StatisticsPresentation,
): StatisticsPresentationEnvelope {
  if (next.state === "ready") {
    return {
      request: next,
      retainedReadyScene: next,
      sceneExposed: true,
    };
  }
  return {
    request: next,
    retainedReadyScene: current.retainedReadyScene,
    sceneExposed: false,
  };
}

export function maskStatisticsPresentation(
  current: StatisticsPresentationEnvelope,
): StatisticsPresentationEnvelope {
  return current.sceneExposed ? { ...current, sceneExposed: false } : current;
}

export function revealStatisticsPresentation(
  current: StatisticsPresentationEnvelope,
  source: StatisticsSourceSnapshot,
  target: StatisticsPreparationTarget,
): StatisticsPresentationEnvelope {
  const request = current.request;
  if (
    request?.state !== "ready" ||
    request !== current.retainedReadyScene ||
    !areStatisticsSourcesEqual(request.source, source) ||
    request.period !== target.period ||
    request.periodOffset !== target.periodOffset
  ) {
    return current;
  }
  return current.sceneExposed ? current : { ...current, sceneExposed: true };
}

export type StatisticsNavigationDirection = "prev" | "next";

export function getStatisticsNavigationTarget(
  current: StatisticsPreparationTarget,
  direction: StatisticsNavigationDirection,
  baseCivilDate: string,
): StatisticsPreparationTarget {
  const normalized = normalizeStatisticsTargetForBase(current, baseCivilDate);
  const periodOffset =
    direction === "next"
      ? Math.min(0, normalized.periodOffset + 1)
      : normalized.periodOffset - 1;
  if (
    !Number.isSafeInteger(periodOffset) ||
    getStatisticsPeriodRange(normalized.period, periodOffset, baseCivilDate) ==
      null
  ) {
    return normalized;
  }
  return { period: normalized.period, periodOffset };
}

export function canNavigateStatisticsForward(
  requestedTarget: StatisticsPreparationTarget,
  baseCivilDate: string,
): boolean {
  const normalized = normalizeStatisticsTargetForBase(
    requestedTarget,
    baseCivilDate,
  );
  const next = getStatisticsNavigationTarget(normalized, "next", baseCivilDate);
  return next.periodOffset !== normalized.periodOffset;
}

export function canNavigateStatisticsBackward(
  requestedTarget: StatisticsPreparationTarget,
  baseCivilDate: string,
): boolean {
  const normalized = normalizeStatisticsTargetForBase(
    requestedTarget,
    baseCivilDate,
  );
  const previous = getStatisticsNavigationTarget(
    normalized,
    "prev",
    baseCivilDate,
  );
  return previous.periodOffset !== normalized.periodOffset;
}

export function normalizeStatisticsTargetForBase(
  requestedTarget: StatisticsPreparationTarget,
  baseCivilDate: string,
): StatisticsPreparationTarget {
  const periodOffset =
    Number.isSafeInteger(requestedTarget.periodOffset) &&
    requestedTarget.periodOffset <= 0
      ? requestedTarget.periodOffset
      : 0;
  const candidate = { period: requestedTarget.period, periodOffset };
  if (
    getStatisticsPeriodRange(
      candidate.period,
      candidate.periodOffset,
      baseCivilDate,
    ) != null
  ) {
    return candidate;
  }
  if (getStatisticsPeriodRange(candidate.period, 0, baseCivilDate) == null) {
    throw new RangeError("Statistics base date is outside the supported range");
  }

  let invalidOffset = candidate.periodOffset;
  let validOffset = 0;
  while (validOffset - invalidOffset > 1) {
    const midpoint =
      invalidOffset + Math.floor((validOffset - invalidOffset) / 2);
    if (
      getStatisticsPeriodRange(candidate.period, midpoint, baseCivilDate) ==
      null
    ) {
      invalidOffset = midpoint;
    } else {
      validOffset = midpoint;
    }
  }
  return { period: candidate.period, periodOffset: validOffset };
}

export interface StatisticsPreparationToken {
  revision: number;
  source: StatisticsSourceSnapshot;
  target: StatisticsPreparationTarget;
}

/**
 * Last-intent-wins gate. A completed calculation may publish only when its
 * revision, immutable source value and complete target are still current.
 */
export function isLatestStatisticsPreparation(params: {
  candidate: StatisticsPreparationToken;
  latestRevision: number;
  latestSource: StatisticsSourceSnapshot;
  latestTarget: StatisticsPreparationTarget;
}): boolean {
  const { candidate, latestRevision, latestSource, latestTarget } = params;
  return (
    candidate.revision === latestRevision &&
    areStatisticsSourcesEqual(candidate.source, latestSource) &&
    candidate.target.period === latestTarget.period &&
    candidate.target.periodOffset === latestTarget.periodOffset
  );
}
