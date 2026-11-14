import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { PixelRatio } from "react-native";
import { calculateStreakStats } from "@/domain/habits/streak";
import { projectHabitDayRecordsForDate } from "@/domain/habits/day-record-projection";
import { getHabitDayRecordsForState } from "@/stores/habit-store";
import type { DayRecord, DayStatus } from "@/types/habit";
import type {
  HabitListItemViewModel,
  HabitCheckboxState,
} from "../presentation/habit-list-view-model";
import {
  FLIGHT_DURATION_MS,
  ROW_SHIFT_DURATION_MS,
  SLOT_HEIGHT,
} from "../animation/constants";
import type { useSectionFlight } from "../animation/useSectionFlight";
type SectionName = "active" | "completed";
// Geometry is fractional (safe-area + pixel rounding), so a "same visual slot"
// transfer can still report a few pixels distance. Treat it as no-flight.
const ZERO_FLIGHT_DISTANCE_PX = 6;

type TransferSyncSource = "checkbox" | "context" | "zero-distance";
type CommitFlushReason = "overlay-ready" | "fallback";

const MIN_ROW_SHIFT_REMAINING_FRACTION = 0.35;
const SHORT_FLIGHT_ROW_SHIFT_THRESHOLD_MS = 300;
const SHORT_FLIGHT_MIN_ROW_SHIFT_MS = 48;
const LONG_FLIGHT_MIN_ROW_SHIFT_MS = 72;
const SHORT_FLIGHT_MAX_LAG_AFTER_REMAINING_MS = 36;
const MIN_VISIBLE_FLIGHT_AFTER_BIND_MS = 60;
const ZERO_DISTANCE_FLIGHT_HOLD_MS = 110;
const ZERO_DISTANCE_OVERLAY_WAIT_MS = 90;
// React commit + layout/effect propagation usually starts list reflow
// noticeably after commit dispatch; compensate this in remaining duration
// so row-shift still lands with the overlay flight.
const COMMIT_TO_LAYOUT_LAG_COMPENSATION_MS = 130;
// Perceptual flight pacing:
// 1-cell hops should not feel like a blink,
// but long flights must not become "teleports".
const BASE_SHORT_HOP_SPEED_PX_PER_SEC = 150;
const SPEED_GAIN_PER_EXTRA_CELL = 90;
const MAX_PLANNED_SPEED_PX_PER_SEC = 540;
// Directional pacing:
// - completed -> active should feel snappier (undo completion).
// - active -> completed can be faster, but less aggressive.
const COMPLETED_TO_ACTIVE_DURATION_MULTIPLIER = 0.275;
const ACTIVE_TO_COMPLETED_DURATION_MULTIPLIER = 1 / 3;
const COMPLETED_TO_ACTIVE_MIN_DURATION_MS = 120;

type TransferSyncContext = {
  habitId: number;
  from: SectionName;
  to: SectionName;
  plannedFlightDurationMs: number;
  rowShiftDurationMs: number;
  source: TransferSyncSource;
  startedAtMs: number;
  flightLaunchedAtMs: number | null;
  overlayBindAtMs: number | null;
  visualOverlayAtMs: number | null;
  commitFlushedAtMs: number | null;
  flightCompletedAtMs: number | null;
};

export interface FlyingState {
  habitId: number;
  from: SectionName;
  to: SectionName;
  sourceIndex: number;
  targetIndex: number;
  startX: number;
  startY: number;
  width: number;
  endY: number;
  checkboxState: HabitCheckboxState;
  currentStreak: number;
  habitName: string;
  clipBottomY: number | null;
  clipBottomYEnd: number | null;
}
type OverlayLayer = "under" | "over";
interface UseHabitTransferParams {
  activeItems: HabitListItemViewModel[];
  completedItems: HabitListItemViewModel[];
  selectedDate: string;
  isPast: boolean;
  isFuture: boolean;
  flight: ReturnType<typeof useSectionFlight>;
  markDay: (id: number, date: string, status: DayStatus) => Promise<void>;
  unmarkDay: (id: number, date: string) => Promise<void>;
  allDayRecords: DayRecord[];
  habitOrderIds: number[];
  statusByHabitId: Map<number, DayStatus>;
  completedExpanded: boolean;
  completedToggleHeightRef: React.RefObject<number>;
  headerAreaHeightRef: React.RefObject<number>;
  scrollOffsetRef: React.RefObject<number>;
}
// --- Transfer geometry and record projection ---
function resolveActiveTargetIndex(
  habitId: number,
  activeIds: number[],
  habitOrderIds: number[],
): number {
  const mergedIds = habitOrderIds.filter(
    (id) => id === habitId || activeIds.includes(id),
  );
  const index = mergedIds.indexOf(habitId);
  return index < 0 ? activeIds.length : index;
}
function resolveCompletedTargetIndex(
  habitId: number,
  completedItems: {
    habit: {
      id: number;
    };
    completedAt: number | null;
  }[],
  optimisticCompletedAt: number = Date.now(),
): number {
  let index = 0;
  for (const item of completedItems) {
    const completedAt = item.completedAt ?? Number.MAX_SAFE_INTEGER;
    if (completedAt < optimisticCompletedAt) {
      index += 1;
      continue;
    }
    if (completedAt > optimisticCompletedAt) break;
    if (item.habit.id < habitId) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}
function snapLayout(value: number): number {
  return PixelRatio.roundToNearestPixel(value);
}
function resolvePlannedFlightDurationMs(
  distancePx: number,
  from: SectionName,
  to: SectionName,
): number {
  const distance = Math.max(0, Math.abs(distancePx));
  if (distance <= 0) return 0;
  const cellsToTravel = SLOT_HEIGHT > 0 ? distance / SLOT_HEIGHT : 0;
  const extraCells = Math.max(0, cellsToTravel - 1);
  const plannedSpeedPxPerSec = Math.min(
    MAX_PLANNED_SPEED_PX_PER_SEC,
    BASE_SHORT_HOP_SPEED_PX_PER_SEC + extraCells * SPEED_GAIN_PER_EXTRA_CELL,
  );
  const durationMs =
    plannedSpeedPxPerSec <= 0
      ? FLIGHT_DURATION_MS
      : Math.round((distance / plannedSpeedPxPerSec) * 1000);
  const directionalMultiplier =
    from === "completed" && to === "active"
      ? COMPLETED_TO_ACTIVE_DURATION_MULTIPLIER
      : from === "active" && to === "completed"
        ? ACTIVE_TO_COMPLETED_DURATION_MULTIPLIER
        : 1;
  const adjustedDurationMs = Math.round(durationMs * directionalMultiplier);
  const minDurationMs =
    from === "completed" && to === "active"
      ? COMPLETED_TO_ACTIVE_MIN_DURATION_MS
      : 1;
  return Math.max(minDurationMs, adjustedDurationMs);
}
function projectStreakForTransfer(params: {
  habit: HabitListItemViewModel["habit"];
  selectedDate: string;
  allDayRecords: DayRecord[];
  to: SectionName;
  targetCheckboxState: HabitCheckboxState;
}): number {
  const { habit, selectedDate, allDayRecords, to, targetCheckboxState } =
    params;
  const persistedStatus: DayStatus | null =
    to === "active"
      ? null
      : targetCheckboxState === "unmarked" ||
          targetCheckboxState === "unmarkedPast"
        ? "done"
        : (targetCheckboxState as DayStatus);
  const nowTs = Date.now();
  const habitRecords = getHabitDayRecordsForState({ allDayRecords }, habit.id);
  const existing = habitRecords.find((record) => record.date === selectedDate);
  const nextRecord =
    persistedStatus == null
      ? null
      : existing
        ? { ...existing, status: persistedStatus, updatedAt: nowTs }
        : {
            id: -nowTs,
            habitId: habit.id,
            date: selectedDate,
            status: persistedStatus,
            createdAt: nowTs,
            updatedAt: nowTs,
          };
  const projectedRecords = projectHabitDayRecordsForDate(
    habitRecords,
    selectedDate,
    nextRecord,
  );
  projectedRecords.sort((a, b) => {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return 1;
    return a.createdAt - b.createdAt;
  });
  return calculateStreakStats(
    projectedRecords,
    habit.repeatSchedule,
    habit.startDate,
    habit.archiveHistory,
    habit.scheduleHistory,
  ).current;
}
// --- Main hook ---
export function useHabitTransfer({
  activeItems,
  completedItems,
  selectedDate,
  isPast,
  isFuture,
  flight,
  markDay,
  unmarkDay,
  allDayRecords,
  habitOrderIds,
  statusByHabitId,
  completedExpanded,
  completedToggleHeightRef,
  headerAreaHeightRef,
  scrollOffsetRef,
}: UseHabitTransferParams) {
  const [flyingState, setFlyingState] = useState<FlyingState | null>(null);
  const [rowShiftDurationMs, setRowShiftDurationMs] = useState(
    ROW_SHIFT_DURATION_MS,
  );
  const [isTransferSyncActive, setIsTransferSyncActive] = useState(false);
  const [overlayMountedHabitId, setOverlayMountedHabitId] = useState<
    number | null
  >(null);

  const pendingCommitRef = useRef<{
    habitId: number;
    runCommit: () => void;
  } | null>(null);
  const pendingCommitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const delayedFlightCompleteTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const flushPendingCommitRef = useRef<(reason: CommitFlushReason) => void>(
    () => {},
  );
  const isBusy = flyingState != null;

  const transferSyncRef = useRef<TransferSyncContext | null>(null);
  const getIsTransferBusy = useCallback(() => transferSyncRef.current != null, []);

  const pendingFlightCompletionRef = useRef<{ habitId: number } | null>(null);
  // Single source of truth for visual transfer lifecycle.
  // Overlay mount is tracked separately to avoid hiding source row before overlay appears.

  const hasVisualFlightOverlay =
    flyingState != null && overlayMountedHabitId === flyingState.habitId;
  // Upward (completed -> active) flights are rendered on the over-layer.
  // If source row in completed stays visible until visual-overlay-ready,
  // users can see a short duplicate. Hide completed source immediately.
  const shouldHideCompletedSourcePreVisual =
    flyingState != null &&
    flyingState.from === "completed" &&
    flyingState.to === "active";
  const hiddenActiveHabitId =
    hasVisualFlightOverlay && flyingState ? flyingState.habitId : null;
  const hiddenCompletedHabitId =
    (hasVisualFlightOverlay || shouldHideCompletedSourcePreVisual) &&
    flyingState
      ? flyingState.habitId
      : null;

  const beginFlight = flight.beginFlight;

  const updateRowShiftDuration = useCallback((nextDurationMs: number) => {
    const normalizedDurationMs = Math.max(0, Math.round(nextDurationMs));
    setRowShiftDurationMs(() => normalizedDurationMs);
  }, []);
  const finalizeTransferSyncSession = useCallback(() => {
    if (!transferSyncRef.current) return;
    transferSyncRef.current = null;
    setIsTransferSyncActive(false);
  }, []);
  const startTransferSyncSession = useCallback(
    (params: {
      habitId: number;
      from: SectionName;
      to: SectionName;
      plannedFlightDurationMs: number;
      source: TransferSyncSource;
    }) => {
      if (transferSyncRef.current) finalizeTransferSyncSession();
      setIsTransferSyncActive(true);
      const initialRowShiftDurationMs =
        params.source === "zero-distance"
          ? 0
          : Math.max(0, Math.round(params.plannedFlightDurationMs));
      updateRowShiftDuration(initialRowShiftDurationMs);
      transferSyncRef.current = {
        habitId: params.habitId,
        from: params.from,
        to: params.to,
        plannedFlightDurationMs: params.plannedFlightDurationMs,
        rowShiftDurationMs: initialRowShiftDurationMs,
        source: params.source,
        startedAtMs: Date.now(),
        flightLaunchedAtMs: null,
        overlayBindAtMs: null,
        visualOverlayAtMs: null,
        commitFlushedAtMs: null,
        flightCompletedAtMs: null,
      };
    },
    [finalizeTransferSyncSession, updateRowShiftDuration],
  );
  const handleOverlayBind = useCallback(
    (habitId: number, _layer: OverlayLayer) => {
      const now = Date.now(),
        sync = transferSyncRef.current;
      if (sync && sync.habitId === habitId && sync.overlayBindAtMs == null)
        sync.overlayBindAtMs = now;
      if (
        sync &&
        sync.habitId === habitId &&
        sync.from === "active" &&
        sync.to === "completed"
      ) {
        if (sync.flightLaunchedAtMs == null) {
          sync.flightLaunchedAtMs = now;
          beginFlight(habitId);
        }
        setOverlayMountedHabitId((current) =>
          current === habitId ? current : habitId,
        );
        if (pendingCommitRef.current?.habitId === habitId)
          flushPendingCommitRef.current("overlay-ready");
      }
    },
    [beginFlight],
  );
  const launchDownwardFlightImmediately = useCallback(
    (habitId: number) => {
      const sync = transferSyncRef.current;
      if (
        sync &&
        sync.habitId === habitId &&
        sync.from === "active" &&
        sync.to === "completed" &&
        sync.flightLaunchedAtMs == null
      )
        sync.flightLaunchedAtMs = Date.now();
      beginFlight(habitId);
      setOverlayMountedHabitId((current) =>
        current === habitId ? current : habitId,
      );
      if (pendingCommitRef.current?.habitId === habitId)
        flushPendingCommitRef.current("overlay-ready");
    },
    [beginFlight],
  );
  const handleOverlayVisualReady = useCallback(
    (habitId: number, _layer: OverlayLayer) => {
      const now = Date.now(),
        sync = transferSyncRef.current;
      if (sync && sync.habitId === habitId) {
        if (sync.overlayBindAtMs == null) sync.overlayBindAtMs = now;
        if (sync.visualOverlayAtMs == null) sync.visualOverlayAtMs = now;
        if (sync.flightLaunchedAtMs == null) sync.flightLaunchedAtMs = now;
      }
      beginFlight(habitId);
      setOverlayMountedHabitId((current) =>
        current === habitId ? current : habitId,
      );
      if (pendingCommitRef.current?.habitId === habitId)
        flushPendingCommitRef.current("overlay-ready");
    },
    [beginFlight],
  );
  const handleOverlayUnbind = useCallback(
    (habitId: number, _layer: OverlayLayer) => {
      setOverlayMountedHabitId((current) =>
        current === habitId ? null : current,
      );
    },
    [],
  );
  const clearPendingCommit = useCallback(() => {
    pendingCommitRef.current = null;
    if (pendingCommitTimeoutRef.current != null) {
      clearTimeout(pendingCommitTimeoutRef.current);
      pendingCommitTimeoutRef.current = null;
    }
  }, []);
  const clearDelayedFlightCompleteTimeout = useCallback(() => {
    if (delayedFlightCompleteTimeoutRef.current == null) return;
    clearTimeout(delayedFlightCompleteTimeoutRef.current);
    delayedFlightCompleteTimeoutRef.current = null;
  }, []);

  const flushPendingCommit = useCallback(
    (reason: CommitFlushReason) => {
      const pending = pendingCommitRef.current;
      if (!pending) return;
      const sync = transferSyncRef.current;
      let remainingRowShiftDurationMs =
        sync?.rowShiftDurationMs ?? ROW_SHIFT_DURATION_MS;
      if (
        sync &&
        sync.habitId === pending.habitId &&
        sync.commitFlushedAtMs == null
      ) {
        const now = Date.now();
        sync.commitFlushedAtMs = now;
        const flightStartMs = sync.flightLaunchedAtMs ?? sync.startedAtMs;
        const elapsedMs = Math.max(0, now - flightStartMs);
        const compensatedElapsedMs =
          reason === "overlay-ready"
            ? elapsedMs + COMMIT_TO_LAYOUT_LAG_COMPENSATION_MS
            : elapsedMs;
        if (sync.source === "zero-distance") {
          // For zero-distance transfers keep layout fully snapped.
          remainingRowShiftDurationMs = 0;
        } else {
          const minimalFractionRemainingMs = Math.round(
            sync.plannedFlightDurationMs * MIN_ROW_SHIFT_REMAINING_FRACTION,
          );
          const minimalRemainingRowShiftMs =
            sync.plannedFlightDurationMs <= SHORT_FLIGHT_ROW_SHIFT_THRESHOLD_MS
              ? SHORT_FLIGHT_MIN_ROW_SHIFT_MS
              : LONG_FLIGHT_MIN_ROW_SHIFT_MS;
          const remainingPlannedFlightMs = Math.max(
            0,
            sync.plannedFlightDurationMs - compensatedElapsedMs,
          );
          // Keep row-shift synced to flight landing: if commit is delayed,
          // shorten reflow duration to the remaining flight time, but avoid
          // overly abrupt reflow snaps when JS is late.
          remainingRowShiftDurationMs = Math.max(
            minimalRemainingRowShiftMs,
            minimalFractionRemainingMs,
            remainingPlannedFlightMs,
          );
          if (
            sync.plannedFlightDurationMs <= SHORT_FLIGHT_ROW_SHIFT_THRESHOLD_MS
          ) {
            const shortFlightMaxRemainingMs = Math.max(
              minimalRemainingRowShiftMs,
              remainingPlannedFlightMs +
                SHORT_FLIGHT_MAX_LAG_AFTER_REMAINING_MS,
            );
            remainingRowShiftDurationMs = Math.min(
              remainingRowShiftDurationMs,
              shortFlightMaxRemainingMs,
            );
          }
        }
        sync.rowShiftDurationMs = remainingRowShiftDurationMs;
        updateRowShiftDuration(remainingRowShiftDurationMs);
      }
      pendingCommitRef.current = null;
      if (pendingCommitTimeoutRef.current != null) {
        clearTimeout(pendingCommitTimeoutRef.current);
        pendingCommitTimeoutRef.current = null;
      }
      pending.runCommit();
    },
    [updateRowShiftDuration],
  );
  flushPendingCommitRef.current = flushPendingCommit;
  const queueCommitAfterOverlayReady = useCallback(
    (habitId: number, runCommit: () => void) => {
      clearPendingCommit();

      pendingCommitRef.current = { habitId, runCommit };

      // Fallback safety: if overlay-ready signal is missed, do not lose commit.

      pendingCommitTimeoutRef.current = setTimeout(() => {
        flushPendingCommit("fallback");
      }, 1200);
    },
    [clearPendingCommit, flushPendingCommit],
  );
  useEffect(() => {
    if (flyingState != null) return;
    if (pendingCommitRef.current == null) return;
    // Flight ended but pending commit still exists (overlay-ready missed).
    // Flush it now to avoid state desync.
    flushPendingCommit("fallback");
  }, [flushPendingCommit, flyingState]);
  useEffect(
    () => () => {
      clearPendingCommit();
    },
    [clearPendingCommit],
  );
  useEffect(
    () => () => {
      clearDelayedFlightCompleteTimeout();
      clearPendingCommit();

      finalizeTransferSyncSession();
    },
    [
      clearPendingCommit,
      clearDelayedFlightCompleteTimeout,
      finalizeTransferSyncSession,
    ],
  );
  // Arithmetic position calculation — no onLayout refs needed for individual sections.
  // The overlay is absolutely positioned in the screen root, so coordinates must be
  // relative to the screen root's top.
  //
  // Layout structure (screen root → down):
  //   Header area [height: headerAreaHeight]
  //   ScrollView [flex: 1, scrolled by scrollOffset]
  //     Active list container [height: activeVisibleCount * SLOT_HEIGHT, or 0]
  //       Active rows [position: absolute, top: index * SLOT_HEIGHT]
  //     Footer wrapper
  //       CompletedHabitsSection
  //         Curtain [height: curtainHeight, or 0 if collapsed]
  //           Completed rows [flow layout, each ~ SLOT_HEIGHT]
  //         Toggle button
  //
  // Active row N screen-relative Y = headerH + N * SLOT_HEIGHT - scrollOffset
  // Completed row N screen-relative Y = headerH + activeListHeight + N * SLOT_HEIGHT - scrollOffset
  const resolveFlightGeometry = useCallback(
    (
      from: SectionName,
      to: SectionName,
      sourceIndex: number,
      targetIndex: number,
    ): {
      startY: number;
      endY: number;
      startX: number;
      width: number;
      clipBottomY: number | null;
      clipBottomYEnd: number | null;
    } => {
      const headerH = headerAreaHeightRef.current ?? 0;
      const scrollY = scrollOffsetRef.current ?? 0;
      const toggleH = Math.max(0, completedToggleHeightRef.current ?? 56);
      const activeCount = activeItems.length;
      let startY: number;
      let endY: number;
      let clipBottomY: number | null = null;
      let clipBottomYEnd: number | null = null;
      if (from === "active" && to === "completed") {
        // Active → Completed
        // Start: current position in active list
        startY = headerH + sourceIndex * SLOT_HEIGHT - scrollY;
        // End: position in completed section AFTER active list shrinks by 1 slot.
        const currentActiveHeight =
          activeCount > 0 ? activeCount * SLOT_HEIGHT : 0;
        const newActiveCount = activeCount - 1;
        const newActiveHeight =
          newActiveCount > 0 ? newActiveCount * SLOT_HEIGHT : 0;
        if (completedExpanded) {
          endY =
            headerH + newActiveHeight + targetIndex * SLOT_HEIGHT - scrollY;
        } else {
          // Collapsed completed section:
          // keep a virtual target below the toggle so transfer timing remains
          // perceptible even when completed rows are hidden.
          const collapsedBoundaryY = headerH + newActiveHeight - scrollY;
          const currentToggleBottomY =
            headerH + currentActiveHeight + toggleH - scrollY;
          const collapsedToggleBottomY = collapsedBoundaryY + toggleH;
          const hiddenCompletedBaseOffset = Math.max(SLOT_HEIGHT, toggleH);
          // Collapsed completed list has no visible row slots, so deep targetIndex
          // should not push overlay far below the hidden block.
          endY = collapsedBoundaryY + hiddenCompletedBaseOffset;
          // Keep transfer under the collapsed block and animate clip with
          // active-list shrink so card hides progressively instead of instantly.
          clipBottomY = currentToggleBottomY;
          clipBottomYEnd = collapsedToggleBottomY;
        }
      } else {
        // Completed → Active
        // Start: current position in completed section
        const currentActiveHeight =
          activeCount > 0 ? activeCount * SLOT_HEIGHT : 0;
        const completedTopOffset = completedExpanded ? 0 : toggleH;
        startY =
          headerH +
          currentActiveHeight +
          completedTopOffset +
          sourceIndex * SLOT_HEIGHT -
          scrollY;
        // End: target position in active list
        endY = headerH + targetIndex * SLOT_HEIGHT - scrollY;
      }
      return {
        startY: snapLayout(startY),
        endY: snapLayout(endY),
        startX: 0,
        width: 0,
        clipBottomY: clipBottomY == null ? null : snapLayout(clipBottomY),
        clipBottomYEnd:
          clipBottomYEnd == null ? null : snapLayout(clipBottomYEnd),
      };
    },
    [
      activeItems.length,
      completedExpanded,
      completedToggleHeightRef,
      headerAreaHeightRef,
      scrollOffsetRef,
    ],
  );
  const handleCheckboxPress = useCallback(
    (habitId: number) => {
      if (isFuture) {
        return false;
      }

      if (isBusy || getIsTransferBusy()) {
        return false;
      }
      const isCompleted = statusByHabitId.has(habitId);
      const from: SectionName = isCompleted ? "completed" : "active";
      const to: SectionName = isCompleted ? "active" : "completed";
      const sourceItems = isCompleted ? completedItems : activeItems;
      const sourceIndex = sourceItems.findIndex((i) => i.habit.id === habitId);
      const sourceItem = sourceItems[sourceIndex];

      if (sourceIndex < 0 || !sourceItem) {
        if (isCompleted) {
          void unmarkDay(habitId, selectedDate);
        } else {
          void markDay(habitId, selectedDate, "done");
        }
        return true;
      }
      const targetCheckboxState: HabitCheckboxState =
        to === "completed" ? "done" : isPast ? "unmarkedPast" : "unmarked";
      const overlayCheckboxState: HabitCheckboxState =
        from === "active" ? sourceItem.checkboxState : targetCheckboxState;
      const targetIndex = isCompleted
        ? resolveActiveTargetIndex(
            habitId,
            activeItems.map((i) => i.habit.id),
            habitOrderIds,
          )
        : resolveCompletedTargetIndex(habitId, completedItems);
      const targetCurrentStreak = projectStreakForTransfer({
        habit: sourceItem.habit,
        selectedDate,
        allDayRecords,
        to,
        targetCheckboxState,
      });

      const geometry = resolveFlightGeometry(
        from,
        to,
        sourceIndex,
        targetIndex,
      );
      const travelDistance = Math.abs(geometry.endY - geometry.startY);
      const isZeroDistance = travelDistance <= ZERO_FLIGHT_DISTANCE_PX;
      const plannedFlightDurationMs = isZeroDistance
        ? ZERO_DISTANCE_FLIGHT_HOLD_MS
        : resolvePlannedFlightDurationMs(travelDistance, from, to);
      startTransferSyncSession({
        habitId,
        from,
        to,
        plannedFlightDurationMs,
        source: isZeroDistance ? "zero-distance" : "checkbox",
      });

      // Prepare flight shared values before showing overlay on JS side.
      // This prevents a one-frame overlay render with stale transform.
      pendingFlightCompletionRef.current = { habitId };
      flight.startFlight({
        habitId,
        startY: geometry.startY,
        endY: geometry.endY,
        startX: geometry.startX,
        width: geometry.width,
        durationMs: plannedFlightDurationMs,
      });
      // Set flying state (single source of truth for overlay + hidden source row).
      setFlyingState({
        habitId,
        from,
        to,
        sourceIndex,
        targetIndex,
        startX: geometry.startX,
        startY: geometry.startY,
        width: geometry.width,
        endY: geometry.endY,
        checkboxState: overlayCheckboxState,
        currentStreak: targetCurrentStreak,
        habitName: sourceItem.habit.name,
        clipBottomY: geometry.clipBottomY,
        clipBottomYEnd: geometry.clipBottomYEnd,
      });
      queueCommitAfterOverlayReady(habitId, () => {
        if (isCompleted) {
          void unmarkDay(habitId, selectedDate);
        } else {
          void markDay(habitId, selectedDate, "done");
        }
      });
      if (from === "active" && to === "completed") {
        launchDownwardFlightImmediately(habitId);
      }
      return true;
    },
    [isBusy, getIsTransferBusy, isFuture, statusByHabitId, completedItems, activeItems, isPast, habitOrderIds, allDayRecords, selectedDate, resolveFlightGeometry, flight, queueCommitAfterOverlayReady, launchDownwardFlightImmediately, startTransferSyncSession, unmarkDay, markDay],
  );
  const handleContextAction = useCallback(
    (habitId: number, status: DayStatus) => {
      if (isFuture || isBusy || getIsTransferBusy()) {
        return false;
      }
      const isCompleted = statusByHabitId.has(habitId);
      if (isCompleted) {
        // Already completed, just update status

        void markDay(habitId, selectedDate, status);
        return true;
      }
      // Transfer active → completed with specific status
      const sourceIndex = activeItems.findIndex((i) => i.habit.id === habitId);
      const sourceItem = activeItems[sourceIndex];
      if (sourceIndex < 0 || !sourceItem) {
        void markDay(habitId, selectedDate, status);
        return true;
      }
      const targetIndex = resolveCompletedTargetIndex(habitId, completedItems);
      const targetCurrentStreak = projectStreakForTransfer({
        habit: sourceItem.habit,
        selectedDate,
        allDayRecords,
        to: "completed",
        targetCheckboxState: status,
      });

      const geometry = resolveFlightGeometry(
        "active",
        "completed",
        sourceIndex,
        targetIndex,
      );
      const travelDistance = Math.abs(geometry.endY - geometry.startY);
      const isZeroDistance = travelDistance <= ZERO_FLIGHT_DISTANCE_PX;
      const plannedFlightDurationMs = isZeroDistance
        ? ZERO_DISTANCE_FLIGHT_HOLD_MS
        : resolvePlannedFlightDurationMs(travelDistance, "active", "completed");
      startTransferSyncSession({
        habitId,
        from: "active",
        to: "completed",
        plannedFlightDurationMs,
        source: isZeroDistance ? "zero-distance" : "context",
      });

      // Same timing rule for context-menu transfers: initialize UI-thread flight first.
      pendingFlightCompletionRef.current = { habitId };
      flight.startFlight({
        habitId,
        startY: geometry.startY,
        endY: geometry.endY,
        startX: geometry.startX,
        width: geometry.width,
        durationMs: plannedFlightDurationMs,
      });
      setFlyingState({
        habitId,
        from: "active",
        to: "completed",
        sourceIndex,
        targetIndex,
        startX: geometry.startX,
        startY: geometry.startY,
        width: geometry.width,
        endY: geometry.endY,
        checkboxState: sourceItem.checkboxState,
        currentStreak: targetCurrentStreak,
        habitName: sourceItem.habit.name,
        clipBottomY: geometry.clipBottomY,
        clipBottomYEnd: geometry.clipBottomYEnd,
      });
      queueCommitAfterOverlayReady(habitId, () => {
        void markDay(habitId, selectedDate, status);
      });
      launchDownwardFlightImmediately(habitId);
      return true;
    },
    [isBusy, getIsTransferBusy, isFuture, statusByHabitId, activeItems, completedItems, allDayRecords, selectedDate, resolveFlightGeometry, flight, queueCommitAfterOverlayReady, launchDownwardFlightImmediately, startTransferSyncSession, markDay],
  );
  const finalizeFlightCompletion = useCallback(() => {
    clearDelayedFlightCompleteTimeout();
    if (flyingState) {
      const pending = pendingCommitRef.current;
      if (pending && pending.habitId === flyingState.habitId) {
        // Safety net: if overlay-ready callback was missed, execute commit now.
        flushPendingCommit("fallback");
      }
    }
    clearPendingCommit();
    setFlyingState(null);
    setOverlayMountedHabitId(null);
    updateRowShiftDuration(ROW_SHIFT_DURATION_MS);
    finalizeTransferSyncSession();
  }, [
    clearDelayedFlightCompleteTimeout,
    clearPendingCommit,
    finalizeTransferSyncSession,
    flushPendingCommit,
    flyingState,
    updateRowShiftDuration,
  ]);

  const handleFlightComplete = useCallback(() => {
    const completedAtMs = Date.now();
    const timing = pendingFlightCompletionRef.current;
    if (timing) {
      const sync = transferSyncRef.current;
      if (
        sync &&
        sync.habitId === timing.habitId &&
        sync.flightCompletedAtMs == null
      ) {
        sync.flightCompletedAtMs = completedAtMs;
      }

      pendingFlightCompletionRef.current = null;
    }
    const sync = transferSyncRef.current;
    if (
      sync &&
      sync.source === "zero-distance" &&
      sync.overlayBindAtMs == null
    ) {
      clearDelayedFlightCompleteTimeout();
      delayedFlightCompleteTimeoutRef.current = setTimeout(() => {
        delayedFlightCompleteTimeoutRef.current = null;
        finalizeFlightCompletion();
      }, ZERO_DISTANCE_OVERLAY_WAIT_MS);
      return;
    }
    if (
      sync &&
      sync.overlayBindAtMs != null &&
      sync.visualOverlayAtMs == null &&
      sync.flightCompletedAtMs != null
    ) {
      const visibleAfterBindMs = Math.max(
        0,
        completedAtMs - sync.overlayBindAtMs,
      );
      const holdMs = Math.max(
        0,
        MIN_VISIBLE_FLIGHT_AFTER_BIND_MS - visibleAfterBindMs,
      );
      if (holdMs > 0) {
        clearDelayedFlightCompleteTimeout();
        delayedFlightCompleteTimeoutRef.current = setTimeout(() => {
          delayedFlightCompleteTimeoutRef.current = null;
          finalizeFlightCompletion();
        }, holdMs);
        return;
      }
    }
    finalizeFlightCompletion();
  }, [clearDelayedFlightCompleteTimeout, finalizeFlightCompletion]);
  return {
    flyingState,
    isBusy,
    getIsTransferBusy,
    isTransferSyncActive,
    hasVisualFlightOverlay,
    rowShiftDurationMs,
    handleOverlayBind,
    handleOverlayVisualReady,
    handleOverlayUnbind,
    hiddenActiveHabitId,
    hiddenCompletedHabitId,
    handleCheckboxPress,
    handleContextAction,
    handleFlightComplete,
  };
}
