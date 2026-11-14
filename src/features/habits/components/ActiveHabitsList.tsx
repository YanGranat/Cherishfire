import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { View, StyleSheet } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { HabitItem } from "./HabitItem";
import {
  DRAG_ACTIVATE_MS,
  DRAG_LIFT_SCALE,
  DROP_DURATION_MS,
  ROW_SHIFT_EASING,
  SEPARATOR_RENDER_HEIGHT,
  SLOT_HEIGHT,
} from "../animation/constants";
import type { HabitListItemViewModel } from "../presentation/habit-list-view-model";
import type { SharedValue } from "react-native-reanimated";
const NOOP_HEIGHT_DELTA_PX = 0.5;
type HomeReorderReleaseState = "drop" | "no-move" | "cancelled" | "interrupted";

interface ActiveHabitsListProps {
  layoutEpoch: string;
  items: HabitListItemViewModel[];
  hiddenHabitId: number | null;
  incomingPlaceholderIndex: number | null;
  outgoingSourceIndex: number | null;
  rowShiftDurationMs: number;
  suppressLayoutAnimations: boolean;
  animateCheckboxTransitions: boolean;
  checkboxDisabled: boolean;
  gapBackgroundColor: string;
  onCheckboxPress: (habitId: number) => boolean;
  onCheckboxLongPress: (habitId: number, pageX: number, pageY: number) => void;
  onPressHabit: (habitId: number) => void;
  onLongPressHabit: (habitId: number, pageX: number, pageY: number) => void;
  onReorderActiveIds: (ids: number[]) => void;
  isBusy: boolean;
  showTopSeparator: boolean;
  separatorColor: string;
  surfaceBackgroundColor: string;
}
function lightenHexColor(hex: string, amount: number): string {
  const normalized = hex.trim();
  const match = normalized.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return hex;
  const value = match[1];
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  const adjust = (offset: number) => {
    const channel = parseInt(value.slice(offset, offset + 2), 16);
    return clamp(Math.round(channel + (255 - channel) * amount))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${adjust(0)}${adjust(2)}${adjust(4)}`;
}
function ActiveHabitsListComponent({
  layoutEpoch,
  items,
  hiddenHabitId,
  incomingPlaceholderIndex,
  outgoingSourceIndex,
  rowShiftDurationMs,
  suppressLayoutAnimations,
  animateCheckboxTransitions,
  checkboxDisabled,
  gapBackgroundColor,
  onCheckboxPress,
  onCheckboxLongPress,
  onPressHabit,
  onLongPressHabit,
  onReorderActiveIds,
  isBusy,
  showTopSeparator,
  separatorColor,
  surfaceBackgroundColor,
}: ActiveHabitsListProps) {
  const visibleItems = useMemo(
    () =>
      hiddenHabitId != null
        ? items.filter((i) => i.habit.id !== hiddenHabitId)
        : items,
    [items, hiddenHabitId],
  );
  const visibleCount = visibleItems.length;
  const itemIndexById = useMemo(() => {
    const indexById: Record<number, number> = {};
    for (let i = 0; i < visibleItems.length; i += 1) {
      indexById[visibleItems[i].habit.id] = i;
    }
    return indexById;
  }, [visibleItems]);
  const clampedIncomingPlaceholderIndex = useMemo(() => {
    if (incomingPlaceholderIndex == null) return null;
    return Math.max(0, Math.min(visibleCount, incomingPlaceholderIndex));
  }, [incomingPlaceholderIndex, visibleCount]);
  const clampedOutgoingPlaceholderIndex = useMemo(() => {
    if (outgoingSourceIndex == null) return null;
    return Math.max(0, Math.min(visibleCount, outgoingSourceIndex));
  }, [outgoingSourceIndex, visibleCount]);
  type ActiveRenderRow =
    | {
        kind: "item";
        key: string;
        item: HabitListItemViewModel;
      }
    | {
        kind: "placeholder";
        key: string;
      };
  const renderRows = useMemo<ActiveRenderRow[]>(() => {
    const nextRows: ActiveRenderRow[] = visibleItems.map((item) => ({
      kind: "item",
      key: `item-${item.habit.id}`,
      item,
    }));
    if (clampedOutgoingPlaceholderIndex != null) {
      nextRows.splice(clampedOutgoingPlaceholderIndex, 0, {
        kind: "placeholder",
        key: "outgoing-placeholder",
      });
    }
    if (clampedIncomingPlaceholderIndex != null) {
      const incomingIndex =
        clampedOutgoingPlaceholderIndex != null &&
        clampedIncomingPlaceholderIndex >= clampedOutgoingPlaceholderIndex
          ? clampedIncomingPlaceholderIndex + 1
          : clampedIncomingPlaceholderIndex;
      nextRows.splice(incomingIndex, 0, {
        kind: "placeholder",
        key: "incoming-placeholder",
      });
    }
    return nextRows;
  }, [
    visibleItems,
    clampedIncomingPlaceholderIndex,
    clampedOutgoingPlaceholderIndex,
  ]);
  const targetListHeight = useMemo(
    () => (renderRows.length > 0 ? renderRows.length * SLOT_HEIGHT : 0),
    [renderRows.length],
  );
  const effectiveRowShiftDurationMs = useMemo(
    () => Math.max(0, rowShiftDurationMs),
    [rowShiftDurationMs],
  );

  // Animated list height via Reanimated (UI thread)
  // Start from measured target to avoid initial 0 -> target jump on mount.
  const listHeight = useSharedValue(targetListHeight);
  const initialHeightRef = useRef<number | null>(targetListHeight);
  const prevBusyRef = useRef(isBusy);

  const prevHiddenHabitIdRef = useRef<number | null>(hiddenHabitId);
  const [suppressReflowAnimation, setSuppressReflowAnimation] = useState(false);
  const suppressReflowRafRef = useRef<number | null>(null);
  // Anti-phantom reflow:
  // when hidden habit appears back in active, rows/placeholder must snap in that frame.
  // Timing animation here can produce a one-frame ghost at old row positions.
  useEffect(
    () => () => {
      if (suppressReflowRafRef.current != null) {
        cancelAnimationFrame(suppressReflowRafRef.current);
        suppressReflowRafRef.current = null;
      }
    },
    [],
  );
  useEffect(() => {
    const becameVisible =
      prevHiddenHabitIdRef.current != null && hiddenHabitId == null;
    prevHiddenHabitIdRef.current = hiddenHabitId;
    if (!becameVisible) return;
    if (suppressReflowRafRef.current != null) {
      cancelAnimationFrame(suppressReflowRafRef.current);
      suppressReflowRafRef.current = null;
    }
    setSuppressReflowAnimation(true);
    suppressReflowRafRef.current = requestAnimationFrame(() => {
      suppressReflowRafRef.current = null;
      setSuppressReflowAnimation(false);
    });
  }, [hiddenHabitId]);

  useLayoutEffect(() => {
    const target = targetListHeight;
    const justSettled = prevBusyRef.current && !isBusy;
    prevBusyRef.current = isBusy;
    // A matching first-commit seed needs no synchronous UI-runtime read.
    const currentHeight =
      initialHeightRef.current === target ? target : listHeight.value;
    initialHeightRef.current = null;
    const heightDelta = Math.abs(currentHeight - target);
    if (heightDelta < NOOP_HEIGHT_DELTA_PX) {
      listHeight.value = target;
      return;
    }
    // Keep initial/date-load frames snapped, but allow smooth reflow during flight.
    // Snapping on `isBusy` makes source/destination slots jump instantly.
    if (
      suppressLayoutAnimations ||
      suppressReflowAnimation ||
      justSettled ||
      effectiveRowShiftDurationMs <= 0
    ) {
      listHeight.value = target;
      return;
    }

    listHeight.value = withTiming(target, {
      duration: effectiveRowShiftDurationMs,
      easing: ROW_SHIFT_EASING,
    });
  }, [
    hiddenHabitId,
    isBusy,
    listHeight,
    effectiveRowShiftDurationMs,
    suppressLayoutAnimations,
    suppressReflowAnimation,
    targetListHeight,
  ]);
  const heightStyle = useAnimatedStyle(
    () => ({
      // Animated styles outrank ordinary styles. While suppression remains
      // active, converge the retained UI-thread height to the target value.
      height: suppressLayoutAnimations ? targetListHeight : listHeight.value,
    }),
    [suppressLayoutAnimations, targetListHeight],
  );
  // --- Drag & drop state ---
  const isDragging = useSharedValue(false);
  const draggedOriginalIndex = useSharedValue(-1);
  const dragTranslateY = useSharedValue(0);
  const dragRowTop = useSharedValue(0);
  const dragCurrentIndex = useSharedValue(-1);
  const [dragSessionIndexById, setDragSessionIndexById] = useState<Record<
    number,
    number
  > | null>(null);
  const pendingDropOrderRef = useRef<number[] | null>(null);
  const finalizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSessionRafRef = useRef<number | null>(null);

  const ownerLeaseRef = useRef({ live: false });
  const installOwnerLease = useCallback(() => {
    const lease = ownerLeaseRef.current;
    lease.live = true;
    return () => {
      lease.live = false;
    };
  }, []);
  useLayoutEffect(installOwnerLease, [installOwnerLease]);
  const admitOwnerCallback = useCallback(() => ownerLeaseRef.current.live, []);
  const itemIdsRef = useRef<number[]>([]);
  itemIdsRef.current = visibleItems.map((i) => i.habit.id);
  const onReorderRef = useRef(onReorderActiveIds);
  onReorderRef.current = onReorderActiveIds;
  const clearFinalizeTimeout = useCallback(() => {
    if (finalizeTimeoutRef.current != null) {
      clearTimeout(finalizeTimeoutRef.current);
      finalizeTimeoutRef.current = null;
    }
  }, []);
  const clearSessionRaf = useCallback(() => {
    if (clearSessionRafRef.current != null) {
      cancelAnimationFrame(clearSessionRafRef.current);
      clearSessionRafRef.current = null;
    }
  }, []);

  const resetDragState = useCallback(() => {
    runOnUI(() => {
      "worklet";
      isDragging.value = false;
      draggedOriginalIndex.value = -1;
      dragCurrentIndex.value = -1;
      dragTranslateY.value = 0;
      dragRowTop.value = 0;
    })();
  }, [
    dragCurrentIndex,
    dragRowTop,
    dragTranslateY,
    draggedOriginalIndex,
    isDragging,
  ]);
  const finalizeDrop = useCallback(() => {
    pendingDropOrderRef.current = null;
    clearFinalizeTimeout();
    resetDragState();
    clearSessionRaf();
    clearSessionRafRef.current = requestAnimationFrame(() => {
      setDragSessionIndexById(null);
      clearSessionRafRef.current = null;
    });
  }, [clearFinalizeTimeout, clearSessionRaf, resetDragState]);
  const beginDragSession = useCallback(
    (habitId: number) => {
      if (!admitOwnerCallback()) {
        return;
      }

      const ids = itemIdsRef.current;
      const next: Record<number, number> = {};
      for (let i = 0; i < ids.length; i += 1) {
        next[ids[i]] = i;
      }
      setDragSessionIndexById(next);
    },
    [admitOwnerCallback],
  );
  const handleDragRelease = useCallback(
    (_habitId: number, state: HomeReorderReleaseState) => {
      if (!admitOwnerCallback()) return;
      if (state === "cancelled") setDragSessionIndexById(null);
    },
    [admitOwnerCallback],
  );

  const handleDropCommit = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (!admitOwnerCallback()) return;
      const ids = itemIdsRef.current.slice();
      if (
        fromIdx < 0 ||
        toIdx < 0 ||
        fromIdx >= ids.length ||
        toIdx >= ids.length
      ) {
        finalizeDrop();
        return;
      }
      if (fromIdx === toIdx) {
        finalizeDrop();
        return;
      }
      const [removed] = ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, removed);
      pendingDropOrderRef.current = ids;
      clearFinalizeTimeout();
      finalizeTimeoutRef.current = setTimeout(() => {
        finalizeDrop();
      }, 2500);
      onReorderRef.current(ids);
    },
    [admitOwnerCallback, clearFinalizeTimeout, finalizeDrop],
  );
  // Transfer-flight and drag-reorder should never overlap visually.
  // If any stale drag shared value survives between interactions,
  // it can force unrelated rows into drag branch and produce one-frame flicker.
  useEffect(() => {
    if (!isBusy) return;

    pendingDropOrderRef.current = null;
    clearFinalizeTimeout();
    clearSessionRaf();
    setDragSessionIndexById(null);
    resetDragState();
  }, [isBusy, clearFinalizeTimeout, clearSessionRaf, resetDragState]);
  const scheduleDropCommit = useCallback(
    (fromIdx: number, toIdx: number) => {
      handleDropCommit(fromIdx, toIdx);
    },
    [handleDropCommit],
  );
  const visibleIds = useMemo(
    () => visibleItems.map((i) => i.habit.id),
    [visibleItems],
  );
  useEffect(() => {
    const expected = pendingDropOrderRef.current;
    if (!expected) return;
    if (expected.length !== visibleIds.length) return;
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i] !== visibleIds[i]) return;
    }
    finalizeDrop();
  }, [visibleIds, finalizeDrop]);
  useEffect(
    () => () => {
      clearFinalizeTimeout();
      clearSessionRaf();
    },
    [clearFinalizeTimeout, clearSessionRaf],
  );
  useLayoutEffect(() => {
    pendingDropOrderRef.current = null;
    clearFinalizeTimeout();
    clearSessionRaf();
    setDragSessionIndexById(null);
    resetDragState();
  }, [layoutEpoch, clearFinalizeTimeout, clearSessionRaf, resetDragState]);
  // Date-epoch suppression snaps these same absolute rows in place. Keep their
  // absolute layout through the first date frame and gesture-lock release.
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.listContainer, heightStyle]}
    >
      {renderRows.map((row, index) => {
        if (row.kind === "placeholder") {
          return (
            <ActivePlaceholderRow
              key={row.key}
              index={index}
              showTopSeparator={showTopSeparator}
              isBusy={isBusy}
              rowShiftDurationMs={effectiveRowShiftDurationMs}
              suppressReflowAnimation={suppressReflowAnimation}
              suppressLayoutAnimations={suppressLayoutAnimations}
              gapBackgroundColor={gapBackgroundColor}
              separatorColor={separatorColor}
            />
          );
        }
        const item = row.item;
        const stableIndex = itemIndexById[item.habit.id] ?? index;
        return (
          <ActiveHabitRow
            key={row.key}
            item={item}
            index={index}
            totalCount={visibleCount}
            isDragging={isDragging}
            draggedOriginalIndex={draggedOriginalIndex}
            dragTranslateY={dragTranslateY}
            dragRowTop={dragRowTop}
            dragCurrentIndex={dragCurrentIndex}
            dragSessionIndex={
              dragSessionIndexById?.[item.habit.id] ?? stableIndex
            }
            isBusy={isBusy}
            showTopSeparator={showTopSeparator}
            separatorColor={separatorColor}
            surfaceBackgroundColor={surfaceBackgroundColor}
            onCheckboxPress={onCheckboxPress}
            onCheckboxLongPress={onCheckboxLongPress}
            onPressHabit={onPressHabit}
            onLongPressHabit={onLongPressHabit}
            onBeginDragSession={beginDragSession}
            onDragRelease={handleDragRelease}
            onScheduleDropCommit={scheduleDropCommit}
            rowShiftDurationMs={effectiveRowShiftDurationMs}
            suppressReflowAnimation={suppressReflowAnimation}
            suppressLayoutAnimations={suppressLayoutAnimations}
            animateCheckboxTransitions={animateCheckboxTransitions}
            checkboxDisabled={checkboxDisabled}
            checkboxVisualEpoch={layoutEpoch}
          />
        );
      })}
    </Animated.View>
  );
}
export const ActiveHabitsList = React.memo(ActiveHabitsListComponent);
// --- Individual row with drag gesture ---
interface ActivePlaceholderRowProps {
  index: number;
  showTopSeparator: boolean;
  isBusy: boolean;
  rowShiftDurationMs: number;
  suppressReflowAnimation: boolean;
  suppressLayoutAnimations: boolean;
  gapBackgroundColor: string;
  separatorColor: string;
}
const ActivePlaceholderRow = React.memo(function ActivePlaceholderRow({
  index,
  showTopSeparator,
  isBusy,
  rowShiftDurationMs,
  suppressReflowAnimation,
  suppressLayoutAnimations,
  gapBackgroundColor,
  separatorColor,
}: ActivePlaceholderRowProps) {
  const staticTop = useSharedValue(index * SLOT_HEIGHT);
  const useStaticRowPosition =
    suppressLayoutAnimations || suppressReflowAnimation;
  useLayoutEffect(() => {
    if (suppressLayoutAnimations || suppressReflowAnimation) {
      staticTop.value = index * SLOT_HEIGHT;
      return;
    }
    if (rowShiftDurationMs <= 0) {
      staticTop.value = index * SLOT_HEIGHT;
      return;
    }
    staticTop.value = withTiming(index * SLOT_HEIGHT, {
      duration: rowShiftDurationMs,
      easing: ROW_SHIFT_EASING,
    });
  }, [
    index,
    rowShiftDurationMs,
    staticTop,
    suppressLayoutAnimations,
    suppressReflowAnimation,
  ]);
  const animatedRowStyle = useAnimatedStyle(() => ({
    position: "absolute" as const,
    left: 0,
    right: 0,
    height: SLOT_HEIGHT,
    top: staticTop.value,
    zIndex: 0,
  }));
  const staticRowStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: 0,
      right: 0,
      height: SLOT_HEIGHT,
      top: index * SLOT_HEIGHT,
      zIndex: 0,
    }),
    [index],
  );
  const baseRowStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: 0,
      right: 0,
      height: SLOT_HEIGHT,
      top: index * SLOT_HEIGHT,
      zIndex: 0,
    }),
    [index],
  );
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        baseRowStyle,
        { backgroundColor: isBusy ? "transparent" : gapBackgroundColor },
        useStaticRowPosition ? staticRowStyle : animatedRowStyle,
      ]}
    >
      {index === 0 && showTopSeparator ? (
        <View
          pointerEvents="none"
          style={[styles.rowTopSeparator, { backgroundColor: separatorColor }]}
        />
      ) : null}
      <View style={styles.placeholderBody} />
      <View
        pointerEvents="none"
        style={[styles.rowBottomSeparator, { backgroundColor: separatorColor }]}
      />
    </Animated.View>
  );
});
interface ActiveHabitRowProps {
  item: HabitListItemViewModel;
  index: number;
  totalCount: number;
  isDragging: SharedValue<boolean>;
  draggedOriginalIndex: SharedValue<number>;
  dragTranslateY: SharedValue<number>;
  dragRowTop: SharedValue<number>;
  dragCurrentIndex: SharedValue<number>;
  dragSessionIndex: number;
  isBusy: boolean;
  showTopSeparator: boolean;
  separatorColor: string;
  surfaceBackgroundColor: string;
  onCheckboxPress: (habitId: number) => boolean;
  onCheckboxLongPress: (habitId: number, pageX: number, pageY: number) => void;
  onPressHabit: (habitId: number) => void;
  onLongPressHabit: (habitId: number, pageX: number, pageY: number) => void;
  onBeginDragSession: (habitId: number) => void;
  onDragRelease: (habitId: number, state: HomeReorderReleaseState) => void;
  onScheduleDropCommit: (from: number, to: number) => void;
  rowShiftDurationMs: number;
  suppressReflowAnimation: boolean;
  suppressLayoutAnimations: boolean;
  animateCheckboxTransitions: boolean;
  checkboxDisabled: boolean;
  checkboxVisualEpoch: string;
}
function areActiveHabitRowPropsEqual(
  previous: ActiveHabitRowProps,
  next: ActiveHabitRowProps,
): boolean {
  const sameVisibleItem =
    previous.item.habit.id === next.item.habit.id &&
    previous.item.habit.name === next.item.habit.name &&
    previous.item.checkboxState === next.item.checkboxState &&
    previous.item.currentStreak === next.item.currentStreak;
  return (
    sameVisibleItem &&
    previous.index === next.index &&
    previous.totalCount === next.totalCount &&
    previous.isDragging === next.isDragging &&
    previous.draggedOriginalIndex === next.draggedOriginalIndex &&
    previous.dragTranslateY === next.dragTranslateY &&
    previous.dragRowTop === next.dragRowTop &&
    previous.dragCurrentIndex === next.dragCurrentIndex &&
    previous.dragSessionIndex === next.dragSessionIndex &&
    previous.isBusy === next.isBusy &&
    previous.showTopSeparator === next.showTopSeparator &&
    previous.separatorColor === next.separatorColor &&
    previous.surfaceBackgroundColor === next.surfaceBackgroundColor &&
    previous.onCheckboxPress === next.onCheckboxPress &&
    previous.onCheckboxLongPress === next.onCheckboxLongPress &&
    previous.onPressHabit === next.onPressHabit &&
    previous.onLongPressHabit === next.onLongPressHabit &&
    previous.onBeginDragSession === next.onBeginDragSession &&
    previous.onDragRelease === next.onDragRelease &&
    previous.onScheduleDropCommit === next.onScheduleDropCommit &&
    previous.rowShiftDurationMs === next.rowShiftDurationMs &&
    previous.suppressReflowAnimation === next.suppressReflowAnimation &&
    previous.suppressLayoutAnimations === next.suppressLayoutAnimations &&
    previous.animateCheckboxTransitions === next.animateCheckboxTransitions &&
    previous.checkboxVisualEpoch === next.checkboxVisualEpoch &&
    previous.checkboxDisabled === next.checkboxDisabled
  );
}
const ActiveHabitRow = React.memo(function ActiveHabitRow({
  item,
  index,
  totalCount,
  isDragging,
  draggedOriginalIndex,
  dragTranslateY,
  dragRowTop,
  dragCurrentIndex,
  dragSessionIndex,
  isBusy,
  showTopSeparator,
  separatorColor,
  surfaceBackgroundColor,
  onCheckboxPress,
  onCheckboxLongPress,
  onPressHabit,
  onLongPressHabit,
  onBeginDragSession,
  onDragRelease,
  onScheduleDropCommit,
  rowShiftDurationMs,
  suppressReflowAnimation,
  suppressLayoutAnimations,
  animateCheckboxTransitions,
  checkboxDisabled,
  checkboxVisualEpoch,
}: ActiveHabitRowProps) {
  const myIndex = index;
  const dragVisualsDisabled = isBusy;
  const useStaticRowPosition =
    suppressLayoutAnimations || suppressReflowAnimation;
  const draggedSurfaceBackgroundColor = useMemo(
    () => lightenHexColor(surfaceBackgroundColor, 0.02),
    [surfaceBackgroundColor],
  );
  const isDropping = useSharedValue(false);
  const staticTop = useSharedValue(myIndex * SLOT_HEIGHT);
  const dragAdmissionCode = useSharedValue(0);
  const dragGestureIndex = useSharedValue(dragSessionIndex);
  const dragGestureCount = useSharedValue(totalCount);

  const dragCallbacksRef = useRef({
    onBeginDragSession,
    onDragRelease,
    onScheduleDropCommit,
  });

  // GestureDetector keeps the native recognizer mounted while a habit remains
  // in the list. Its config callbacks are refreshed from a passive effect,
  // which can trail a visible date commit. Keep one recognizer for the row and
  // publish its changing admission/index inputs through UI-thread values so a
  // date-snap lock cannot remain captured until an unrelated re-render.
  useLayoutEffect(() => {
    dragAdmissionCode.value =
      suppressLayoutAnimations || suppressReflowAnimation ? 1 : isBusy ? 2 : 0;
    dragGestureIndex.value = dragSessionIndex;
    dragGestureCount.value = totalCount;
    dragCallbacksRef.current = {
      onBeginDragSession,
      onDragRelease,
      onScheduleDropCommit,
    };
  }, [
    dragAdmissionCode,
    dragGestureCount,
    dragGestureIndex,
    dragSessionIndex,
    index,
    isBusy,
    onBeginDragSession,
    onDragRelease,
    onScheduleDropCommit,
    suppressLayoutAnimations,
    suppressReflowAnimation,
    totalCount,
  ]);
  const resolveShiftForDrag = useCallback(
    (originalIndex: number, sessionIndex: number, targetIndex: number) => {
      "worklet";
      if (originalIndex < sessionIndex && targetIndex >= sessionIndex) {
        return -SLOT_HEIGHT;
      }
      if (originalIndex > sessionIndex && targetIndex <= sessionIndex) {
        return SLOT_HEIGHT;
      }
      return 0;
    },
    [],
  );
  useLayoutEffect(() => {
    if (suppressLayoutAnimations || suppressReflowAnimation) {
      staticTop.value = myIndex * SLOT_HEIGHT;
      return;
    }
    if (rowShiftDurationMs <= 0) {
      staticTop.value = myIndex * SLOT_HEIGHT;
      return;
    }
    // While dragging, keep static top snapped to current index to avoid
    // a late "return to source" frame when drop finalization flips branches.
    if (isDragging.value) {
      staticTop.value = myIndex * SLOT_HEIGHT;
      return;
    }
    staticTop.value = withTiming(myIndex * SLOT_HEIGHT, {
      duration: rowShiftDurationMs,
      easing: ROW_SHIFT_EASING,
    });
  }, [
    isDragging,
    myIndex,
    rowShiftDurationMs,
    staticTop,
    suppressLayoutAnimations,
    suppressReflowAnimation,
  ]);

  const beginDragSession = useCallback((habitId: number) => {
    dragCallbacksRef.current.onBeginDragSession(habitId);
  }, []);
  const releaseDragSession = useCallback(
    (habitId: number, state: HomeReorderReleaseState) => {
      dragCallbacksRef.current.onDragRelease(habitId, state);
    },
    [],
  );
  const commitDropOrder = useCallback((from: number, to: number) => {
    dragCallbacksRef.current.onScheduleDropCommit(from, to);
  }, []);
  const dragGesture = useMemo(() => {
    return Gesture.Pan()
      .enabled(item.habit.id > 0)
      .activateAfterLongPress(DRAG_ACTIVATE_MS)
      .onStart(() => {
        "worklet";
        const admissionCode = dragAdmissionCode.value;
        if (admissionCode === 1) {
          return;
        }
        if (admissionCode === 2) {
          return;
        }
        if (isDragging.value) {
          return;
        }

        isDropping.value = false;
        const sessionIndex = dragGestureIndex.value;
        runOnJS(beginDragSession)(item.habit.id);
        isDragging.value = true;
        draggedOriginalIndex.value = sessionIndex;
        dragCurrentIndex.value = sessionIndex;
        dragTranslateY.value = 0;
        dragRowTop.value = sessionIndex * SLOT_HEIGHT;
      })
      .onUpdate((e) => {
        "worklet";
        if (!isDragging.value) return;
        const sessionIndex = dragGestureIndex.value;
        const count = dragGestureCount.value;
        const baseTop = sessionIndex * SLOT_HEIGHT;
        const minTop = 0;
        const maxTop = Math.max(0, (count - 1) * SLOT_HEIGHT);
        const nextTop = baseTop + e.translationY;
        const clampedTop = Math.max(minTop, Math.min(maxTop, nextTop));
        const snappedTop = Math.round(clampedTop);
        const clampedTranslationY = snappedTop - baseTop;
        dragTranslateY.value = clampedTranslationY;
        dragRowTop.value = snappedTop;
        const moveBy = Math.round(clampedTranslationY / SLOT_HEIGHT);
        dragCurrentIndex.value = Math.max(
          0,
          Math.min(count - 1, draggedOriginalIndex.value + moveBy),
        );
      })
      .onEnd(() => {
        "worklet";
        if (!isDragging.value) return;
        isDropping.value = true;
        const from = draggedOriginalIndex.value;
        const to = dragCurrentIndex.value;

        const targetTop = to * SLOT_HEIGHT;
        dragRowTop.value = withTiming(
          targetTop,
          { duration: DROP_DURATION_MS, easing: Easing.out(Easing.cubic) },
          (finished) => {
            "worklet";
            if (!finished) return;
            runOnJS(commitDropOrder)(from, to);
          },
        );
        runOnJS(releaseDragSession)(
          item.habit.id,
          from === to ? "no-move" : "drop",
        );
      })
      .onFinalize(() => {
        "worklet";
        if (isDropping.value) {
          return;
        }
        if (!isDragging.value) return;

        isDragging.value = false;
        draggedOriginalIndex.value = -1;
        dragCurrentIndex.value = -1;
        dragTranslateY.value = 0;
        runOnJS(releaseDragSession)(item.habit.id, "cancelled");
      });
  }, [
    beginDragSession,
    commitDropOrder,
    dragAdmissionCode,
    dragGestureCount,
    dragGestureIndex,
    isDropping,
    isDragging,
    draggedOriginalIndex,
    dragTranslateY,
    dragRowTop,
    dragCurrentIndex,
    item.habit.id,
    releaseDragSession,
  ]);
  const animatedRowStyle = useAnimatedStyle(() => {
    if (useStaticRowPosition) {
      return {
        position: "absolute" as const,
        left: 0,
        right: 0,
        height: SLOT_HEIGHT,
        top: myIndex * SLOT_HEIGHT,
        zIndex: 0,
        backgroundColor: surfaceBackgroundColor,
        transform: [{ scale: 1 }],
      };
    }
    if (
      dragVisualsDisabled ||
      !isDragging.value ||
      draggedOriginalIndex.value < 0
    ) {
      return {
        position: "absolute" as const,
        left: 0,
        right: 0,
        height: SLOT_HEIGHT,
        top: staticTop.value,
        zIndex: 0,
        backgroundColor: surfaceBackgroundColor,
        transform: [{ scale: 1 }],
      };
    }
    const dragTop = dragSessionIndex * SLOT_HEIGHT;
    if (dragSessionIndex === draggedOriginalIndex.value) {
      return {
        position: "absolute" as const,
        left: 0,
        right: 0,
        height: SLOT_HEIGHT,
        top: Math.round(dragRowTop.value),
        zIndex: 10,
        backgroundColor: draggedSurfaceBackgroundColor,
        transform: [{ scale: DRAG_LIFT_SCALE }],
      };
    }
    const dragTargetIdx = dragCurrentIndex.value;
    const origIdx = draggedOriginalIndex.value;
    const shift = resolveShiftForDrag(origIdx, dragSessionIndex, dragTargetIdx);
    return {
      position: "absolute" as const,
      left: 0,
      right: 0,
      height: SLOT_HEIGHT,
      top: withTiming(dragTop + shift, {
        duration: 150,
        easing: Easing.out(Easing.ease),
      }),
      zIndex: 0,
      backgroundColor: surfaceBackgroundColor,
      transform: [{ scale: 1 }],
    };
  });
  const staticRowStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: 0,
      right: 0,
      height: SLOT_HEIGHT,
      top: myIndex * SLOT_HEIGHT,
      zIndex: 0,
      backgroundColor: surfaceBackgroundColor,
      transform: [{ scale: 1 }],
    }),
    [myIndex, surfaceBackgroundColor],
  );
  const baseRowStyle = useMemo(
    () => ({
      position: "absolute" as const,
      left: 0,
      right: 0,
      height: SLOT_HEIGHT,
      top: myIndex * SLOT_HEIGHT,
      zIndex: 0,
      backgroundColor: surfaceBackgroundColor,
      transform: [{ scale: 1 }],
    }),
    [myIndex, surfaceBackgroundColor],
  );
  const topSeparatorStyle = useAnimatedStyle(() => {
    if (
      useStaticRowPosition ||
      dragVisualsDisabled ||
      !isDragging.value ||
      draggedOriginalIndex.value < 0
    ) {
      const isFirstRow = myIndex === 0;
      return {
        opacity: 1,
        top: isFirstRow && showTopSeparator ? 0 : -SEPARATOR_RENDER_HEIGHT,
      };
    }
    const draggedIdx = dragCurrentIndex.value;
    const isDraggedRow = dragSessionIndex === draggedOriginalIndex.value;
    let visualIndex = draggedIdx;
    if (!isDraggedRow) {
      const origIdx = draggedOriginalIndex.value;
      const shift = resolveShiftForDrag(origIdx, dragSessionIndex, draggedIdx);
      visualIndex = dragSessionIndex + shift / SLOT_HEIGHT;
    }
    const isFirstVisible = visualIndex === 0;
    // Preserve the original row-owned model during drag: every habit carries
    // both its top and bottom separator. At aligned boundaries the lower row's
    // top line overlaps the upper row's bottom line on the exact same pixels.
    const topOffset =
      isFirstVisible && showTopSeparator ? 0 : -SEPARATOR_RENDER_HEIGHT;
    return {
      opacity: 1,
      top: topOffset,
    };
  }, [myIndex, showTopSeparator]);

  const rowContent = (
    <>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.rowTopSeparator,
          topSeparatorStyle,
          { backgroundColor: separatorColor },
        ]}
      />
      <HabitItem
        habitId={item.habit.id}
        habitName={item.habit.name}
        checkboxState={item.checkboxState}
        checkboxDisabled={checkboxDisabled}
        currentStreak={item.currentStreak}
        onCheckboxPress={onCheckboxPress}
        onCheckboxLongPress={onCheckboxLongPress}
        onPress={onPressHabit}
        onLongPress={onLongPressHabit}
        showDragHandle={true}
        dragHandleGesture={dragGesture}
        animateCheckboxTransitions={animateCheckboxTransitions}
        visualEpoch={checkboxVisualEpoch}
      />
      <Animated.View
        pointerEvents="none"
        style={[styles.rowBottomSeparator, { backgroundColor: separatorColor }]}
      />
    </>
  );
  const rowElement = (
    <Animated.View
      style={[
        baseRowStyle,
        useStaticRowPosition ? staticRowStyle : null,
        animatedRowStyle,
      ]}
    >
      {rowContent}
    </Animated.View>
  );
  return rowElement;
}, areActiveHabitRowPropsEqual);
const styles = StyleSheet.create({
  listContainer: {
    position: "relative",
    overflow: "hidden",
  },
  placeholderBody: {
    height: SLOT_HEIGHT - SEPARATOR_RENDER_HEIGHT,
  },
  rowBottomSeparator: {
    opacity: 1,
    position: "absolute",
    left: 0,
    right: 0,
    top: SLOT_HEIGHT - SEPARATOR_RENDER_HEIGHT,
    height: SEPARATOR_RENDER_HEIGHT,
  },
  rowTopSeparator: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: SEPARATOR_RENDER_HEIGHT,
  },
});
