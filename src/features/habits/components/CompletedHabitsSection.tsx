import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { View, StyleSheet } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { lightTheme } from "@/theme/colors";
import {
  EXPAND_DURATION_MS,
  ROW_SHIFT_EASING,
  SEPARATOR_RENDER_HEIGHT,
  SLOT_HEIGHT,
} from "../animation/constants";
import { CompletedSectionToggleVisual } from "./CompletedSectionToggleVisual";
import { HabitItem } from "./HabitItem";
import type { HabitListItemViewModel } from "../presentation/habit-list-view-model";
interface CompletedHabitsSectionProps {
  layoutEpoch: string;
  items: HabitListItemViewModel[];
  expanded: boolean;
  incomingPlaceholderIndex: number | null;
  preserveGapSourceIndex: number | null;
  rowShiftDurationMs: number;
  isBusy: boolean;
  lockToggleInteraction: boolean;
  suppressLayoutAnimations: boolean;
  animateCheckboxTransitions: boolean;
  checkboxDisabled: boolean;
  preserveHiddenSlot: boolean;
  hasPrecedingSeparator: boolean;
  gapBackgroundColor: string;
  onExpandedChange: (expanded: boolean) => void;
  hiddenHabitId: number | null;
  onToggleLayout?: (layout: { height: number; y: number }) => void;
  onCheckboxPress: (habitId: number) => boolean;
  onCheckboxLongPress: (habitId: number, pageX: number, pageY: number) => void;
  onPressHabit: (habitId: number) => void;
  onLongPressHabit: (habitId: number, pageX: number, pageY: number) => void;
  separatorColor: string;
  surfaceBackgroundColor: string;
}
type CompletedRenderRow =
  | {
      kind: "item";
      key: string;
      item: HabitListItemViewModel;
    }
  | {
      kind: "placeholder";
      key: string;
    };
const NOOP_CURTAIN_DELTA_PX = 0.5;
function CompletedHabitsSectionComponent({
  layoutEpoch,
  items,
  expanded,
  incomingPlaceholderIndex,
  preserveGapSourceIndex,
  rowShiftDurationMs,
  isBusy,
  lockToggleInteraction,
  suppressLayoutAnimations,
  animateCheckboxTransitions,
  checkboxDisabled,
  preserveHiddenSlot,
  hasPrecedingSeparator,
  gapBackgroundColor,
  onExpandedChange,
  hiddenHabitId,
  onToggleLayout,
  onCheckboxPress,
  onCheckboxLongPress,
  onPressHabit,
  onLongPressHabit,
  separatorColor,
  surfaceBackgroundColor,
}: CompletedHabitsSectionProps) {
  const { t } = useTranslation();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const toggleColor = isDarkTheme ? "#9E9E9E" : lightTheme.muted;
  const visibleItems = useMemo(
    () =>
      hiddenHabitId != null
        ? items.filter((i) => i.habit.id !== hiddenHabitId)
        : items,
    [items, hiddenHabitId],
  );
  const visibleCount = visibleItems.length;
  const isExpanded = expanded;
  const [rowsMounted, setRowsMounted] = useState(isExpanded);
  const latestExpandedRef = useRef(isExpanded);
  const latestBusyRef = useRef(isBusy);
  latestExpandedRef.current = isExpanded;
  latestBusyRef.current = isBusy;
  const mountCompletedRows = isExpanded || rowsMounted;
  useLayoutEffect(() => {
    if (isExpanded) setRowsMounted(true);
  }, [isExpanded]);
  const clampedIncomingPlaceholderIndex = useMemo(() => {
    if (incomingPlaceholderIndex == null) return null;
    return Math.max(0, Math.min(visibleCount, incomingPlaceholderIndex));
  }, [incomingPlaceholderIndex, visibleCount]);
  const clampedPreserveGapSourceIndex = useMemo(() => {
    if (!isExpanded) return null;
    if (!preserveHiddenSlot) return null;
    if (preserveGapSourceIndex == null) return null;
    return Math.max(0, Math.min(visibleCount, preserveGapSourceIndex));
  }, [isExpanded, preserveGapSourceIndex, preserveHiddenSlot, visibleCount]);
  const renderRows = useMemo<CompletedRenderRow[]>(() => {
    const rows: CompletedRenderRow[] = visibleItems.map((item) => ({
      kind: "item",
      key: `item-${item.habit.id}`,
      item,
    }));
    if (clampedPreserveGapSourceIndex != null) {
      rows.splice(clampedPreserveGapSourceIndex, 0, {
        kind: "placeholder",
        key: "source-gap-placeholder",
      });
    }
    if (isExpanded && clampedIncomingPlaceholderIndex != null) {
      const incomingIndex =
        clampedPreserveGapSourceIndex != null &&
        clampedIncomingPlaceholderIndex >= clampedPreserveGapSourceIndex
          ? clampedIncomingPlaceholderIndex + 1
          : clampedIncomingPlaceholderIndex;
      rows.splice(incomingIndex, 0, {
        kind: "placeholder",
        key: "incoming-placeholder",
      });
    }
    return rows;
  }, [
    visibleItems,
    isExpanded,
    clampedIncomingPlaceholderIndex,
    clampedPreserveGapSourceIndex,
  ]);

  const contentHeight = useMemo(
    () => (renderRows.length > 0 ? renderRows.length * SLOT_HEIGHT : 0),
    [renderRows.length],
  );
  const targetCurtainHeight = useMemo(() => {
    const targetCount = isExpanded ? renderRows.length : 0;
    return targetCount > 0 ? targetCount * SLOT_HEIGHT : 0;
  }, [isExpanded, renderRows.length]);
  const effectiveRowShiftDurationMs = useMemo(
    () => Math.max(0, rowShiftDurationMs),
    [rowShiftDurationMs],
  );
  // Keep completed rows inside clipping bounds while flight is active.
  // If this shrinks immediately on hide, the last row can disappear first and
  // only become visible later while it animates to a smaller index.
  const [contentInnerHeight, setContentInnerHeight] = useState(contentHeight);
  const prevPreserveHiddenSlotRef = useRef(preserveHiddenSlot);
  // Anti-jitter/phantom reflow:
  // when source-gap placeholder is removed, rows must snap in one frame.
  // Animating this transition makes unrelated completed rows and toggle drift.
  const suppressRowReflowAnimation =
    prevPreserveHiddenSlotRef.current && !preserveHiddenSlot && !isBusy;
  const effectiveContentInnerHeight =
    suppressLayoutAnimations || suppressRowReflowAnimation
      ? contentHeight
      : contentInnerHeight;
  useEffect(() => {
    prevPreserveHiddenSlotRef.current = preserveHiddenSlot;
  }, [preserveHiddenSlot]);
  useEffect(() => {
    setContentInnerHeight((current) => {
      if (suppressLayoutAnimations || suppressRowReflowAnimation) {
        return contentHeight;
      }
      if (isBusy) {
        // During transfer rows are still animating between indices.
        // Shrinking clipping bounds immediately can cut out the row that is
        // moving into the first visible slot.
        // Grow immediately, but postpone shrink until transfer is settled.
        return contentHeight > current ? contentHeight : current;
      }
      return contentHeight;
    });
  }, [
    contentHeight,
    isBusy,
    suppressLayoutAnimations,
    suppressRowReflowAnimation,
  ]);

  // Completed rows are clipped by animated height while the toggle stays below.
  // Start from computed target to avoid initial 0 -> target jump on mount.
  const curtainHeight = useSharedValue(targetCurtainHeight);
  const initialHeightRef = useRef<number | null>(targetCurtainHeight);
  const curtainAnimSeqRef = useRef(0);
  const curtainAnimRef = useRef<{ id: number } | null>(null);

  const ownerLeaseRef = useRef({ live: false });
  const installOwnerLease = useCallback(() => {
    const lease = ownerLeaseRef.current;
    lease.live = true;
    return () => {
      lease.live = false;
      curtainAnimRef.current = null;
    };
  }, []);
  useLayoutEffect(installOwnerLease, [installOwnerLease]);
  const admitOwnerCallback = useCallback(() => ownerLeaseRef.current.live, []);
  const prevBusyRef = useRef(isBusy);
  const prevExpandedRef = useRef(isExpanded);
  const forceCurtainSnap = suppressLayoutAnimations;

  const handleCurtainAnimFinish = useCallback(
    (animationId: number, finished: boolean) => {
      const timing = curtainAnimRef.current;
      if (!timing || timing.id !== animationId) return;

      curtainAnimRef.current = null;
      if (finished && !latestExpandedRef.current && !latestBusyRef.current) {
        setRowsMounted(false);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const target = targetCurtainHeight;
    // A matching first-commit seed needs no synchronous UI-runtime read.
    const currentHeight =
      initialHeightRef.current === target ? target : curtainHeight.value;
    initialHeightRef.current = null;
    const curtainDelta = Math.abs(currentHeight - target);
    if (curtainDelta < NOOP_CURTAIN_DELTA_PX) {
      curtainHeight.value = target;
      if (!isExpanded && !isBusy) setRowsMounted(false);
      return;
    }
    const expandedChanged = prevExpandedRef.current !== isExpanded;
    prevExpandedRef.current = isExpanded;

    const justSettled = prevBusyRef.current && !isBusy;
    prevBusyRef.current = isBusy;
    const zeroDurationReflow = effectiveRowShiftDurationMs <= 0;
    // Snap only for initial/date-load frames, settle cleanup and gap-removal frame.
    // Snapping on `isBusy` makes destination space appear instantly instead of
    // being released progressively while rows are shifting.
    if (
      forceCurtainSnap ||
      suppressRowReflowAnimation ||
      justSettled ||
      zeroDurationReflow
    ) {
      if (Math.round(currentHeight) !== Math.round(target)) {
        const animationId = curtainAnimSeqRef.current + 1;
        curtainAnimSeqRef.current = animationId;
        curtainAnimRef.current = { id: animationId };

        handleCurtainAnimFinish(animationId, true);
      }
      curtainHeight.value = target;
      return;
    }
    const animationId = curtainAnimSeqRef.current + 1;
    curtainAnimSeqRef.current = animationId;
    // During transfer keep curtain timing locked to transfer duration.
    // Using expand duration while busy desynchronizes lists vs flight.
    const plannedDurationMs =
      isBusy || !expandedChanged
        ? effectiveRowShiftDurationMs
        : EXPAND_DURATION_MS;
    curtainAnimRef.current = { id: animationId };

    curtainHeight.value = withTiming(
      target,
      {
        duration: plannedDurationMs,
        easing: ROW_SHIFT_EASING,
      },
      (finished) => {
        "worklet";
        runOnJS(handleCurtainAnimFinish)(animationId, finished === true);
      },
    );
  }, [
    handleCurtainAnimFinish,
    contentHeight,
    curtainHeight,
    hiddenHabitId,
    isExpanded,
    isBusy,
    suppressLayoutAnimations,
    preserveHiddenSlot,
    effectiveRowShiftDurationMs,
    renderRows.length,
    suppressRowReflowAnimation,
    targetCurtainHeight,
    forceCurtainSnap,
  ]);
  const curtainStyle = useAnimatedStyle(
    () => ({
      // Animated styles outrank ordinary styles. While suppression remains
      // active, converge the retained UI-thread curtain to the target height.
      height: forceCurtainSnap ? targetCurtainHeight : curtainHeight.value,
    }),
    [forceCurtainSnap, targetCurtainHeight],
  );
  const toggleTopSeparatorStyle = useAnimatedStyle(() => {
    const visibleCurtainHeight = forceCurtainSnap
      ? targetCurtainHeight
      : curtainHeight.value;
    return {
      // Keep the toggle's own top line visible. During a date snap, use the
      // same exact height owner as the curtain instead of one stale UI frame.
      top:
        hasPrecedingSeparator || visibleCurtainHeight > 0
          ? -SEPARATOR_RENDER_HEIGHT
          : 0,
    };
  }, [forceCurtainSnap, hasPrecedingSeparator, targetCurtainHeight]);
  const handleToggle = useCallback(() => {
    if (lockToggleInteraction) return;

    onExpandedChange(!expanded);
  }, [expanded, lockToggleInteraction, onExpandedChange]);
  const curtainContent = (
    // Keep the completed rows on the same absolute-positioned native tree for
    // normal animation and date-epoch snapping, matching ActiveHabitsList.
    <View
      style={[styles.contentInner, { height: effectiveContentInnerHeight }]}
    >
      {mountCompletedRows
        ? renderRows.map((row, index) => (
            <CompletedHabitRow
              key={row.key}
              rowKey={row.key}
              item={row.kind === "item" ? row.item : null}
              index={index}
              isBusy={isBusy}
              rowShiftDurationMs={effectiveRowShiftDurationMs}
              suppressReflowAnimation={suppressRowReflowAnimation}
              suppressLayoutAnimations={suppressLayoutAnimations}
              gapBackgroundColor={gapBackgroundColor}
              separatorColor={separatorColor}
              surfaceBackgroundColor={surfaceBackgroundColor}
              onCheckboxPress={onCheckboxPress}
              onCheckboxLongPress={onCheckboxLongPress}
              onPressHabit={onPressHabit}
              onLongPressHabit={onLongPressHabit}
              showTopSeparator={!hasPrecedingSeparator && index === 0}
              animateCheckboxTransitions={animateCheckboxTransitions}
              checkboxDisabled={checkboxDisabled}
              checkboxVisualEpoch={layoutEpoch}
            />
          ))
        : null}
    </View>
  );
  return (
    <View>
      <Animated.View
        style={[styles.curtain, curtainStyle]}
        pointerEvents={isExpanded && visibleCount > 0 ? "auto" : "none"}
      >
        {curtainContent}
      </Animated.View>

      {/* Toggle is always below completed rows */}
      <View
        onLayout={
          onToggleLayout
            ? (event) => {
                if (!admitOwnerCallback()) return;
                const { height, y } = event.nativeEvent.layout;

                onToggleLayout?.({ height, y });
              }
            : undefined
        }
      >
        <CompletedSectionToggleVisual
          expanded={isExpanded}
          separatorColor={separatorColor}
          topSeparatorStyle={toggleTopSeparatorStyle}
          toggleColor={toggleColor}
          showLabel={t("habits.showCompleted")}
          hideLabel={t("habits.hideCompleted")}
          onPress={lockToggleInteraction ? undefined : handleToggle}
          backgroundColor={surfaceBackgroundColor}
        />
      </View>
    </View>
  );
}
export const CompletedHabitsSection = React.memo(
  CompletedHabitsSectionComponent,
);
interface CompletedHabitRowProps {
  rowKey: string;
  item: HabitListItemViewModel | null;
  index: number;
  isBusy: boolean;
  rowShiftDurationMs: number;
  suppressReflowAnimation: boolean;
  suppressLayoutAnimations: boolean;
  gapBackgroundColor: string;
  separatorColor: string;
  surfaceBackgroundColor: string;
  showTopSeparator: boolean;
  onCheckboxPress: (habitId: number) => boolean;
  onCheckboxLongPress: (habitId: number, pageX: number, pageY: number) => void;
  onPressHabit: (habitId: number) => void;
  onLongPressHabit: (habitId: number, pageX: number, pageY: number) => void;
  animateCheckboxTransitions: boolean;
  checkboxDisabled: boolean;
  checkboxVisualEpoch: string;
}
function areCompletedHabitRowPropsEqual(
  previous: CompletedHabitRowProps,
  next: CompletedHabitRowProps,
): boolean {
  const sameVisibleItem =
    previous.item === null
      ? next.item === null
      : next.item !== null &&
        previous.item.habit.id === next.item.habit.id &&
        previous.item.habit.name === next.item.habit.name &&
        previous.item.checkboxState === next.item.checkboxState &&
        previous.item.currentStreak === next.item.currentStreak;
  return (
    sameVisibleItem &&
    previous.rowKey === next.rowKey &&
    previous.index === next.index &&
    previous.isBusy === next.isBusy &&
    previous.rowShiftDurationMs === next.rowShiftDurationMs &&
    previous.suppressReflowAnimation === next.suppressReflowAnimation &&
    previous.suppressLayoutAnimations === next.suppressLayoutAnimations &&
    previous.gapBackgroundColor === next.gapBackgroundColor &&
    previous.separatorColor === next.separatorColor &&
    previous.surfaceBackgroundColor === next.surfaceBackgroundColor &&
    previous.showTopSeparator === next.showTopSeparator &&
    previous.onCheckboxPress === next.onCheckboxPress &&
    previous.onCheckboxLongPress === next.onCheckboxLongPress &&
    previous.onPressHabit === next.onPressHabit &&
    previous.onLongPressHabit === next.onLongPressHabit &&
    previous.animateCheckboxTransitions === next.animateCheckboxTransitions &&
    previous.checkboxVisualEpoch === next.checkboxVisualEpoch &&
    previous.checkboxDisabled === next.checkboxDisabled
  );
}
const CompletedHabitRow = React.memo(function CompletedHabitRow({
  rowKey,
  item,
  index,
  isBusy,
  rowShiftDurationMs,
  suppressReflowAnimation,
  suppressLayoutAnimations,
  gapBackgroundColor,
  separatorColor,
  surfaceBackgroundColor,
  showTopSeparator,
  onCheckboxPress,
  onCheckboxLongPress,
  onPressHabit,
  onLongPressHabit,
  animateCheckboxTransitions,
  checkboxDisabled,
  checkboxVisualEpoch,
}: CompletedHabitRowProps) {
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
    isBusy,
    rowShiftDurationMs,
    staticTop,
    suppressLayoutAnimations,
    suppressReflowAnimation,
  ]);
  const animatedRowStyle = useAnimatedStyle(() => {
    if (useStaticRowPosition) {
      return {
        position: "absolute" as const,
        left: 0,
        right: 0,
        height: SLOT_HEIGHT,
        top: index * SLOT_HEIGHT,
        zIndex: 0,
      };
    }
    return {
      position: "absolute" as const,
      left: 0,
      right: 0,
      height: SLOT_HEIGHT,
      top: staticTop.value,
      zIndex: 0,
    };
  });
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
  const rowContent = (
    <>
      {showTopSeparator ? (
        <View
          pointerEvents="none"
          style={[styles.rowTopSeparator, { backgroundColor: separatorColor }]}
        />
      ) : null}
      {item != null ? (
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
          showDragHandle={false}
          animateCheckboxTransitions={animateCheckboxTransitions}
          visualEpoch={checkboxVisualEpoch}
        />
      ) : (
        <View style={styles.placeholderBody} />
      )}
      <View
        pointerEvents="none"
        style={[styles.rowBottomSeparator, { backgroundColor: separatorColor }]}
      />
    </>
  );

  const rowElement = (
    <Animated.View
      style={[
        baseRowStyle,
        {
          backgroundColor:
            item != null
              ? surfaceBackgroundColor
              : isBusy
                ? "transparent"
                : gapBackgroundColor,
        },
        useStaticRowPosition ? staticRowStyle : null,
        animatedRowStyle,
      ]}
    >
      {rowContent}
    </Animated.View>
  );
  return rowElement;
}, areCompletedHabitRowPropsEqual);
const styles = StyleSheet.create({
  curtain: {
    overflow: "hidden",
    position: "relative",
  },
  contentInner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    overflow: "hidden",
  },
  placeholderBody: {
    height: SLOT_HEIGHT - SEPARATOR_RENDER_HEIGHT,
  },
  rowBottomSeparator: {
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
