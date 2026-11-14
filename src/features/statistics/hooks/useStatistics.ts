import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useFocusEffect } from "@react-navigation/native";
import { scheduleStatisticsPeriodsPrewarm } from "@/features/statistics/utils/statistics-prewarm";
import {
  canNavigateStatisticsBackward,
  canNavigateStatisticsForward,
  createStatisticsPresentationEnvelope,
  getStatisticsNavigationTarget,
  isLatestStatisticsPreparation,
  maskStatisticsPresentation,
  normalizeStatisticsTargetForBase,
  publishStatisticsPresentation,
  revealStatisticsPresentation,
  type StatisticsPresentation,
  type StatisticsPresentationEnvelope,
  type StatisticsPreparationTarget,
  type StatisticsReadyPresentation,
} from "@/application/statistics/statistics-preparation";
import {
  areStatisticsSourcesEqual,
  CURRENT_STATISTICS_PERIOD_TARGETS,
  EMPTY_STATISTICS_PERIOD_STATS,
  getStatisticsPeriod,
  peekPreparedStatisticsPeriod,
  type StatisticsSourceSnapshot,
} from "@/application/statistics/statistics-session";
import { getStatisticsPeriodRange } from "@/domain/statistics/statistics-period";
import {
  getCurrentLocalDateSnapshot,
  useCurrentLocalDate,
} from "@/hooks/useCurrentLocalDate";
import { useHabitStore } from "@/stores/habit-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { StatisticsPeriod } from "@/types/settings";
import { runAfterUiPaint, type ScheduledUiTask } from "@/utils/ui-scheduling";
type Period = StatisticsPeriod;
type StatisticsErrorKind = "source" | null;
interface StatisticsStoreSnapshot {
  showArchivedHabitsInStatistics: boolean;
  allHabits: ReturnType<typeof useHabitStore.getState>["allHabits"];
  allHabitsLoaded: boolean;
  allRecords: ReturnType<typeof useHabitStore.getState>["allDayRecords"];
  allDayRecordsLoaded: boolean;
}
function readStatisticsStoreSnapshot(): StatisticsStoreSnapshot {
  const habitState = useHabitStore.getState();
  return {
    showArchivedHabitsInStatistics:
      useSettingsStore.getState().showArchivedHabitsInStatistics,
    allHabits: habitState.allHabits,
    allHabitsLoaded: habitState.allHabitsLoaded,
    allRecords: habitState.allDayRecords,
    allDayRecordsLoaded: habitState.allDayRecordsLoaded,
  };
}
function statisticsStoreSnapshotChanged(
  previous: StatisticsStoreSnapshot,
  current: StatisticsStoreSnapshot,
): boolean {
  return (
    previous.showArchivedHabitsInStatistics !==
      current.showArchivedHabitsInStatistics ||
    previous.allHabits !== current.allHabits ||
    previous.allHabitsLoaded !== current.allHabitsLoaded ||
    previous.allRecords !== current.allRecords ||
    previous.allDayRecordsLoaded !== current.allDayRecordsLoaded
  );
}
let cachedStatisticsStoreSnapshot: StatisticsStoreSnapshot | null = null;
function getStatisticsStoreSnapshot(): StatisticsStoreSnapshot {
  const current = readStatisticsStoreSnapshot();
  if (
    cachedStatisticsStoreSnapshot != null &&
    !statisticsStoreSnapshotChanged(cachedStatisticsStoreSnapshot, current)
  ) {
    return cachedStatisticsStoreSnapshot;
  }
  cachedStatisticsStoreSnapshot = current;
  return current;
}
function readCurrentStatisticsSource(): {
  store: StatisticsStoreSnapshot;
  source: StatisticsSourceSnapshot;
} {
  const store = readStatisticsStoreSnapshot();
  return {
    store,
    source: {
      allHabits: store.allHabits,
      allRecords: store.allRecords,
      showArchivedHabitsInStatistics: store.showArchivedHabitsInStatistics,
      todayStr: getCurrentLocalDateSnapshot(),
    },
  };
}
/** Keeps a retained Statistics scene current before Back can reveal it. */
function useLiveStatisticsStoreSnapshot(): StatisticsStoreSnapshot {
  const subscribe = useCallback((notify: () => void) => {
    const unsubscribeHabits = useHabitStore.subscribe((state, previous) => {
      if (
        state.allHabits !== previous.allHabits ||
        state.allHabitsLoaded !== previous.allHabitsLoaded ||
        state.allDayRecords !== previous.allDayRecords ||
        state.allDayRecordsLoaded !== previous.allDayRecordsLoaded
      ) {
        notify();
      }
    });
    const unsubscribeSettings = useSettingsStore.subscribe(
      (state, previous) => {
        if (
          state.showArchivedHabitsInStatistics !==
          previous.showArchivedHabitsInStatistics
        ) {
          notify();
        }
      },
    );
    return () => {
      unsubscribeHabits();
      unsubscribeSettings();
    };
  }, []);
  return useSyncExternalStore(
    subscribe,
    getStatisticsStoreSnapshot,
    getStatisticsStoreSnapshot,
  );
}
type StatisticsTarget = StatisticsPreparationTarget;
type StatisticsPreparationMode = "deferred" | "immediate";
function targetsEqual(
  left: StatisticsTarget,
  right: StatisticsTarget,
): boolean {
  return (
    left.period === right.period && left.periodOffset === right.periodOffset
  );
}
function getPreparedPresentation(
  source: StatisticsSourceSnapshot,
  target: StatisticsTarget,
): Omit<StatisticsReadyPresentation, "revision"> | null {
  const result = peekPreparedStatisticsPeriod(
    source,
    target.period,
    target.periodOffset,
  );
  return result
    ? {
        source,
        period: target.period,
        periodOffset: target.periodOffset,
        state: "ready",
        result,
      }
    : null;
}
export function useStatistics() {
  const {
    showArchivedHabitsInStatistics,
    allHabits,
    allHabitsLoaded,
    allRecords,
    allDayRecordsLoaded,
  } = useLiveStatisticsStoreSnapshot();
  const loadHabits = useHabitStore.getState().loadHabits;
  const loadAllDayRecords = useHabitStore.getState().loadAllDayRecords;
  const [errorKind, setErrorKind] = useState<StatisticsErrorKind>(null);
  const todayStr = useCurrentLocalDate();
  const source = useMemo<StatisticsSourceSnapshot>(
    () => ({
      allHabits,
      allRecords,
      showArchivedHabitsInStatistics,
      todayStr,
    }),
    [allHabits, allRecords, showArchivedHabitsInStatistics, todayStr],
  );
  const requestedTargetRef = useRef<StatisticsTarget>({
    period: "week",
    periodOffset: 0,
  });
  const [presentation, setPresentation] =
    useState<StatisticsPresentationEnvelope>(() => {
      const prepared = getPreparedPresentation(
        source,
        requestedTargetRef.current,
      );
      return createStatisticsPresentationEnvelope(
        prepared ? { ...prepared, revision: 1 } : null,
      );
    });
  const presentationRevisionRef = useRef(presentation.request?.revision ?? 0);
  const presentationRef = useRef(presentation);
  const sourceRef = useRef(source);
  useLayoutEffect(() => {
    presentationRef.current = presentation;
    sourceRef.current = source;
  }, [presentation, source]);
  const preparationRevisionRef = useRef(0);
  const preparationTaskRef = useRef<ScheduledUiTask | null>(null);
  const activePreparationRef = useRef<{
    source: StatisticsSourceSnapshot;
    target: StatisticsTarget;
  } | null>(null);
  const statisticsFocusedRef = useRef(false);
  const publishRequestedTarget = useCallback((nextTarget: StatisticsTarget) => {
    requestedTargetRef.current = nextTarget;
  }, []);
  const publishPresentation = useCallback(
    (nextPresentation: StatisticsPresentation) => {
      setPresentation((current) =>
        publishStatisticsPresentation(current, nextPresentation),
      );
    },
    [],
  );
  const maskPresentation = useCallback(() => {
    setPresentation(maskStatisticsPresentation);
  }, []);
  const revealPresentation = useCallback(
    (targetSource: StatisticsSourceSnapshot, target: StatisticsTarget) => {
      setPresentation((current) =>
        revealStatisticsPresentation(current, targetSource, target),
      );
    },
    [],
  );
  const normalizeRequestedTargetForSource = useCallback(
    (targetSource: StatisticsSourceSnapshot): StatisticsTarget => {
      const current = requestedTargetRef.current;
      const normalized = normalizeStatisticsTargetForBase(
        current,
        targetSource.todayStr,
      );
      if (targetsEqual(current, normalized)) return current;
      requestedTargetRef.current = normalized;
      return normalized;
    },
    [],
  );
  const prepareAndPublishTarget = useCallback(
    (
      targetSource: StatisticsSourceSnapshot,
      target: StatisticsTarget,
      mode?: StatisticsPreparationMode,
    ) => {
      const resolvedMode =
        mode ??
        (presentationRef.current.retainedReadyScene == null
          ? "deferred"
          : "immediate");
      preparationTaskRef.current?.cancel();
      preparationTaskRef.current = null;
      activePreparationRef.current = null;
      const revision = preparationRevisionRef.current + 1;
      preparationRevisionRef.current = revision;
      const preparationToken = {
        revision,
        source: targetSource,
        target,
      };
      const prepared = peekPreparedStatisticsPeriod(
        targetSource,
        target.period,
        target.periodOffset,
      );
      if (prepared) {
        // The pure peek proved this is a hit. Re-read through the normal owner
        // outside render so the visible period becomes the most-recently used
        // entry without risking a hidden calculation.
        const touched = getStatisticsPeriod(
          targetSource,
          target.period,
          target.periodOffset,
        );
        setErrorKind(null);
        presentationRevisionRef.current += 1;
        publishPresentation({
          revision: presentationRevisionRef.current,
          source: targetSource,
          period: target.period,
          periodOffset: target.periodOffset,
          state: "ready",
          result: touched,
        });
        return;
      }
      activePreparationRef.current = {
        source: targetSource,
        target,
      };
      setErrorKind(null);
      presentationRevisionRef.current += 1;
      publishPresentation({
        revision: presentationRevisionRef.current,
        source: targetSource,
        period: target.period,
        periodOffset: target.periodOffset,
        state: "loading",
      });
      // Initial cold work waits for the neutral loading presentation. Once a
      // ready scene exists, the old coherent frame stays mounted while the
      // replacement is calculated and then promoted atomically.
      const calculateAndPublish = () => {
        try {
          const result = getStatisticsPeriod(
            targetSource,
            target.period,
            target.periodOffset,
          );
          const latestTarget = requestedTargetRef.current;
          const latestSource = readCurrentStatisticsSource().source;
          if (
            !isLatestStatisticsPreparation({
              candidate: preparationToken,
              latestRevision: preparationRevisionRef.current,
              latestSource,
              latestTarget,
            })
          ) {
            return;
          }
          preparationTaskRef.current = null;
          activePreparationRef.current = null;
          setErrorKind(null);
          presentationRevisionRef.current += 1;
          publishPresentation({
            revision: presentationRevisionRef.current,
            source: targetSource,
            period: target.period,
            periodOffset: target.periodOffset,
            state: "ready",
            result,
          });
        } catch (calculationError) {
          const latestSource = readCurrentStatisticsSource().source;
          if (
            !isLatestStatisticsPreparation({
              candidate: preparationToken,
              latestRevision: preparationRevisionRef.current,
              latestSource,
              latestTarget: requestedTargetRef.current,
            })
          ) {
            return;
          }
          console.error("Failed to calculate statistics", calculationError);
          preparationTaskRef.current = null;
          activePreparationRef.current = null;
          presentationRevisionRef.current += 1;
          publishPresentation({
            revision: presentationRevisionRef.current,
            source: targetSource,
            period: target.period,
            periodOffset: target.periodOffset,
            state: "error",
          });
        }
      };
      if (resolvedMode === "immediate") {
        calculateAndPublish();
      } else {
        preparationTaskRef.current = runAfterUiPaint(calculateAndPublish);
      }
    },
    [publishPresentation],
  );
  useEffect(() => {
    if (
      !statisticsFocusedRef.current ||
      !allHabitsLoaded ||
      !allDayRecordsLoaded ||
      errorKind
    ) {
      return;
    }
    const target = normalizeRequestedTargetForSource(source);
    const envelope = presentationRef.current;
    const current = envelope.request;
    const active = activePreparationRef.current;
    if (
      current?.state === "ready" &&
      areStatisticsSourcesEqual(current.source, source) &&
      current.period === target.period &&
      current.periodOffset === target.periodOffset
    ) {
      return;
    }
    if (
      active != null &&
      areStatisticsSourcesEqual(active.source, source) &&
      targetsEqual(active.target, target)
    ) {
      return;
    }
    prepareAndPublishTarget(
      source,
      target,
      envelope.retainedReadyScene == null ? "deferred" : "immediate",
    );
  }, [
    allDayRecordsLoaded,
    allHabitsLoaded,
    errorKind,
    normalizeRequestedTargetForSource,
    prepareAndPublishTarget,
    source,
  ]);
  const cancelStatisticsPreparation = useCallback(() => {
    activePreparationRef.current = null;
    preparationRevisionRef.current += 1;
    preparationTaskRef.current?.cancel();
    preparationTaskRef.current = null;
  }, []);
  useEffect(
    () => () => {
      cancelStatisticsPreparation();
    },
    [cancelStatisticsPreparation],
  );
  const reload = useCallback(async () => {
    const currentOwner = readCurrentStatisticsSource();
    if (
      currentOwner.store.allHabitsLoaded &&
      currentOwner.store.allDayRecordsLoaded
    ) {
      setErrorKind(null);
      const target = normalizeRequestedTargetForSource(currentOwner.source);
      const envelope = presentationRef.current;
      const current = envelope.request;
      const active = activePreparationRef.current;
      const currentIsUsable = Boolean(
        current?.state === "ready" &&
          areStatisticsSourcesEqual(current.source, currentOwner.source) &&
          targetsEqual(current, target),
      );
      const targetIsPreparing = Boolean(
        active != null &&
          areStatisticsSourcesEqual(active.source, currentOwner.source) &&
          targetsEqual(active.target, target),
      );
      if (currentIsUsable) {
        revealPresentation(currentOwner.source, target);
      } else if (!targetIsPreparing) {
        // Retry owns a complete loading presentation synchronously. The screen
        // must never briefly terminalize the new retry against the old error.
        prepareAndPublishTarget(
          currentOwner.source,
          target,
          envelope.retainedReadyScene == null ? "deferred" : "immediate",
        );
      }
      return;
    }
    setErrorKind(null);
    try {
      await Promise.all([
        currentOwner.store.allHabitsLoaded ? Promise.resolve() : loadHabits(),
        currentOwner.store.allDayRecordsLoaded
          ? Promise.resolve()
          : loadAllDayRecords(),
      ]);
      const state = useHabitStore.getState();
      if (!state.allHabitsLoaded || !state.allDayRecordsLoaded) {
        setErrorKind("source");
      }
    } catch (loadError) {
      console.error("Failed to load statistics", loadError);
      setErrorKind("source");
    }
  }, [
    loadAllDayRecords,
    loadHabits,
    normalizeRequestedTargetForSource,
    prepareAndPublishTarget,
    revealPresentation,
  ]);
  // Focus, initial source loading and target preparation share one owner.
  const reloadRef = useRef(reload);
  useLayoutEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useFocusEffect(
    useCallback(() => {
      statisticsFocusedRef.current = true;
      void reloadRef.current();
      return () => {
        statisticsFocusedRef.current = false;
        maskPresentation();
        cancelStatisticsPreparation();
      };
    }, [cancelStatisticsPreparation, maskPresentation]),
  );
  const requestedPresentation = presentation.request;
  const currentPresentation =
    requestedPresentation != null &&
    areStatisticsSourcesEqual(requestedPresentation.source, source)
      ? requestedPresentation
      : null;
  // Target, loading/error state and ready data are one presentation envelope.
  // Never derive the selector from a newer mutable intent while rendering an
  // older body: every committed frame must describe exactly one target.
  const period =
    currentPresentation?.period ?? requestedPresentation?.period ?? "week";
  const periodOffset =
    currentPresentation?.periodOffset ??
    requestedPresentation?.periodOffset ??
    0;
  const periodBaseCivilDate =
    currentPresentation?.source.todayStr ??
    requestedPresentation?.source.todayStr ??
    source.todayStr;
  const periodRange = getStatisticsPeriodRange(
    period,
    periodOffset,
    periodBaseCivilDate,
  );
  if (periodRange == null) {
    throw new RangeError(
      "Statistics presentation is outside the supported civil date range",
    );
  }
  const visibleTarget = { period, periodOffset };
  const canNavigatePrevious = canNavigateStatisticsBackward(
    visibleTarget,
    periodBaseCivilDate,
  );
  const canNavigateNext = canNavigateStatisticsForward(
    visibleTarget,
    periodBaseCivilDate,
  );
  const readyPresentation =
    currentPresentation?.state === "ready" ? currentPresentation : null;
  const stats =
    readyPresentation?.result.stats ?? EMPTY_STATISTICS_PERIOD_STATS;
  const visibleError =
    errorKind != null || currentPresentation?.state === "error"
      ? "load-failed"
      : null;
  const retainedReadyScene = presentation.retainedReadyScene;
  const sceneActive = Boolean(
    errorKind == null &&
      allHabitsLoaded &&
      allDayRecordsLoaded &&
      presentation.sceneExposed &&
      readyPresentation != null &&
      retainedReadyScene === readyPresentation,
  );
  const isLoading =
    ((!allHabitsLoaded || !allDayRecordsLoaded) && errorKind == null) ||
    (currentPresentation == null && visibleError == null) ||
    currentPresentation?.state === "loading" ||
    (!presentation.sceneExposed && visibleError == null);
  useFocusEffect(
    useCallback(() => {
      if (
        !allHabitsLoaded ||
        !allDayRecordsLoaded ||
        errorKind != null ||
        currentPresentation?.state !== "ready" ||
        !sceneActive
      ) {
        return;
      }
      // This starts only after the coherent target presentation committed.
      // One miss per idle slot prepares the neighbouring period without ever
      // mounting or mutating the visible Statistics screen.
      const visibleTarget = { period, periodOffset };
      const previousTarget = getStatisticsNavigationTarget(
        visibleTarget,
        "prev",
        source.todayStr,
      );
      const nextTarget = getStatisticsNavigationTarget(
        visibleTarget,
        "next",
        source.todayStr,
      );
      const adjacentTargets = [previousTarget, nextTarget].filter(
        (target, index, targets) =>
          !targetsEqual(target, visibleTarget) &&
          targets.findIndex((candidate) => targetsEqual(candidate, target)) ===
            index,
      );
      const task = scheduleStatisticsPeriodsPrewarm(source, [
        ...adjacentTargets,
        ...CURRENT_STATISTICS_PERIOD_TARGETS,
      ]);
      return () => task.cancel();
    }, [
      allDayRecordsLoaded,
      allHabitsLoaded,
      currentPresentation,
      errorKind,
      period,
      periodOffset,
      sceneActive,
      source,
    ]),
  );
  const resolveNavigationTarget = useCallback(
    (direction: "prev" | "next") => {
      const currentOwner = readCurrentStatisticsSource();
      const currentTarget = normalizeRequestedTargetForSource(
        currentOwner.source,
      );
      return getStatisticsNavigationTarget(
        currentTarget,
        direction,
        currentOwner.source.todayStr,
      );
    },
    [normalizeRequestedTargetForSource],
  );
  const navigatePeriod = useCallback(
    (direction: "prev" | "next", nextTarget: StatisticsTarget) => {
      const currentOwner = readCurrentStatisticsSource();
      if (
        !currentOwner.store.allHabitsLoaded ||
        !currentOwner.store.allDayRecordsLoaded
      ) {
        return;
      }
      const currentTarget = normalizeRequestedTargetForSource(
        currentOwner.source,
      );
      const admittedTarget = getStatisticsNavigationTarget(
        currentTarget,
        direction,
        currentOwner.source.todayStr,
      );
      if (
        targetsEqual(admittedTarget, currentTarget) ||
        !targetsEqual(nextTarget, admittedTarget)
      ) {
        return;
      }
      publishRequestedTarget(admittedTarget);
      prepareAndPublishTarget(currentOwner.source, admittedTarget);
    },
    [
      normalizeRequestedTargetForSource,
      prepareAndPublishTarget,
      publishRequestedTarget,
    ],
  );
  const changePeriod = useCallback(
    (nextPeriod: Period) => {
      if (!allHabitsLoaded || !allDayRecordsLoaded) {
        return;
      }
      const currentTarget = requestedTargetRef.current;
      if (
        nextPeriod === currentTarget.period &&
        currentTarget.periodOffset === 0
      ) {
        return;
      }
      const nextTarget = { period: nextPeriod, periodOffset: 0 };
      publishRequestedTarget(nextTarget);
      prepareAndPublishTarget(sourceRef.current, nextTarget);
    },
    [
      allDayRecordsLoaded,
      allHabitsLoaded,
      prepareAndPublishTarget,
      publishRequestedTarget,
    ],
  );
  return {
    period,
    setPeriod: changePeriod,
    periodOffset,
    periodBaseCivilDate,
    periodRange,
    canNavigatePrevious,
    canNavigateNext,
    resolveNavigationTarget,
    navigatePeriod,
    stats,
    presentationRevision: currentPresentation?.revision ?? 0,
    retainedScene:
      retainedReadyScene == null
        ? null
        : {
            period: retainedReadyScene.period,
            todayStr: retainedReadyScene.source.todayStr,
            stats: retainedReadyScene.result.stats,
            presentationRevision: retainedReadyScene.revision,
          },
    sceneActive,
    isLoading,
    error: visibleError,
    reload,
  };
}
