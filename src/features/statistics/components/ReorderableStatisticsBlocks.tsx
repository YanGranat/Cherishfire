import React from "react";
import {
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  measure,
  runOnJS,
  runOnUI,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import {
  getStatisticsAutoScrollOffset,
  getStatisticsBlockTop as topForCode,
  getStatisticsBlocksHeight as totalHeight,
  getStatisticsDraggedTop,
  getStatisticsDragTargetIndex as targetIndexForDrag,
  getStatisticsEdgeScrollVelocity as edgeVelocity,
  getStatisticsViewportDragTop,
  moveStatisticsBlockCode as moveCode,
  shouldSettleStatisticsAtTop,
} from "@/features/statistics/utils/ui-thread-reorder";
import { getStatisticsScenePresentationKey } from "@/features/statistics/utils/scene-membership";
import {
  areStatisticsBlockOrdersEqual,
  getStatisticsBlockOrderKey,
  getStatisticsSceneRevision,
  isStatisticsSceneRevisionCurrent,
  resolveNextStatisticsScenePresentation,
  resolveStatisticsPresentationHeights,
  type StatisticsPresentationLayoutSamples,
  type StatisticsScenePhase,
  type StatisticsScenePresentation,
} from "@/features/statistics/utils/scene-transition";
import type { StatisticsBlockId } from "@/types/settings";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { darkTheme, lightTheme } from "@/theme/colors";
type StatsBlockId = StatisticsBlockId;
interface ReorderableStatisticsBlocksProps {
  visibleOrder: StatsBlockId[];
  content: Record<StatsBlockId, React.ReactNode>;
  geometryRevision: string | number;
  handleColor: string;
  presentationHeader?: React.ReactNode;
  active?: boolean;
  onSceneReady?: () => void;
  onReorder: (visibleOrder: StatsBlockId[]) => void;
}
interface ReorderableStatisticsSceneProps
  extends Omit<
    ReorderableStatisticsBlocksProps,
    "presentationHeader" | "active"
  > {
  active: boolean;
  bottomPadding: number;
  initialScrollOffset: number;
  preservedScrollOffset: SharedValue<number>;
  reorderAccessibilityLabel: string;
  onScrollSettled: (offset: number) => void;
}
interface ReorderableStatisticsRowProps {
  id: StatsBlockId;
  code: number;
  enabled: boolean;
  controllerMounted: boolean;
  handleColor: string;
  reorderAccessibilityLabel: string;
  scrollRef: AnimatedRef<React.ComponentRef<typeof Animated.ScrollView>>;
  baseOrder: SharedValue<number[]>;
  committedOrder: SharedValue<number[]>;
  sessionOrder: SharedValue<number[]>;
  heights: SharedValue<number[]>;
  geometryReady: SharedValue<number>;
  geometryReadyRevision: SharedValue<string | number | null>;
  expectedGeometryRevision: string | number;
  layoutRevision: string | number;
  draggingCode: SharedValue<number>;
  dragFromIndex: SharedValue<number>;
  dragTargetIndex: SharedValue<number>;
  dragStartTop: SharedValue<number>;
  dragTop: SharedValue<number>;
  gestureTranslationY: SharedValue<number>;
  scrollOffset: SharedValue<number>;
  dragStartScrollOffset: SharedValue<number>;
  viewportPageY: SharedValue<number>;
  viewportHeight: SharedValue<number>;
  autoScrollVelocity: SharedValue<number>;
  overlayReady: SharedValue<number>;
  settling: SharedValue<number>;
  onHeight: (
    id: StatsBlockId,
    height: number,
    layoutRevision: string | number,
  ) => void;
  onDragStart: (id: StatsBlockId, observedAtEpochMs: number) => void;
  onDragFinished: (id: StatsBlockId, dragStartedAtEpochMs: number) => void;
  onDrop: (
    orderCodes: number[],
    changed: boolean,
    dragStartedAtEpochMs: number,
  ) => void;
  onScrollSettled: (offset: number) => void;
  children: React.ReactNode;
}
type StatisticsDragControllerProps = Pick<
  ReorderableStatisticsRowProps,
  | "id"
  | "code"
  | "enabled"
  | "reorderAccessibilityLabel"
  | "scrollRef"
  | "committedOrder"
  | "sessionOrder"
  | "heights"
  | "geometryReady"
  | "geometryReadyRevision"
  | "expectedGeometryRevision"
  | "draggingCode"
  | "dragFromIndex"
  | "dragTargetIndex"
  | "dragStartTop"
  | "dragTop"
  | "gestureTranslationY"
  | "scrollOffset"
  | "dragStartScrollOffset"
  | "viewportPageY"
  | "viewportHeight"
  | "autoScrollVelocity"
  | "overlayReady"
  | "settling"
  | "onDragStart"
  | "onDragFinished"
  | "onDrop"
  | "onScrollSettled"
>;
const BLOCK_IDS: StatsBlockId[] = ["summary", "heatmap", "bar", "habit"];
const BLOCK_CODE: Record<StatsBlockId, number> = {
  summary: 0,
  heatmap: 1,
  bar: 2,
  habit: 3,
};
// Drag activation, neighbor motion and drop settling define gesture pacing.
const DRAG_ACTIVATE_MS = 180;
const NEIGHBOR_SHIFT_MS = 150;
const DROP_SETTLE_MS = 180;
const TOP_SCROLL_SETTLE_THRESHOLD_DP = 16;
const TOP_SCROLL_SETTLE_DELAY_MS = 30;
const PRESENTATION_READY_TOLERANCE_DP = 0.75;
function updateActiveDragPosition(
  sessionOrder: SharedValue<number[]>,
  heights: SharedValue<number[]>,
  draggingCode: SharedValue<number>,
  dragStartTop: SharedValue<number>,
  dragTop: SharedValue<number>,
  gestureTranslationY: SharedValue<number>,
  scrollOffset: SharedValue<number>,
  dragStartScrollOffset: SharedValue<number>,
  dragTargetIndex: SharedValue<number>,
): void {
  "worklet";
  const activeCode = draggingCode.value;
  if (activeCode < 0) return;
  const order = sessionOrder.value;
  const activeHeight = heights.value[activeCode] ?? 0;
  const maxTop = Math.max(0, totalHeight(order, heights.value) - activeHeight);
  const nextTop = getStatisticsDraggedTop(
    dragStartTop.value,
    gestureTranslationY.value,
    scrollOffset.value,
    dragStartScrollOffset.value,
    maxTop,
  );
  dragTop.value = nextTop;
  dragTargetIndex.value = targetIndexForDrag(
    order,
    heights.value,
    activeCode,
    nextTop,
    dragTargetIndex.value,
  );
}
const StatisticsDragController = React.memo(function StatisticsDragController({
  id,
  code,
  enabled,
  reorderAccessibilityLabel,
  scrollRef,
  committedOrder,
  sessionOrder,
  heights,
  geometryReady,
  geometryReadyRevision,
  expectedGeometryRevision,
  draggingCode,
  dragFromIndex,
  dragTargetIndex,
  dragStartTop,
  dragTop,
  gestureTranslationY,
  scrollOffset,
  dragStartScrollOffset,
  viewportPageY,
  viewportHeight,
  autoScrollVelocity,
  overlayReady,
  settling,
  onDragStart,
  onDragFinished,
  onDrop,
  onScrollSettled,
}: StatisticsDragControllerProps) {
  const isDropping = useSharedValue(false);
  const dragStartedAtEpochMs = useSharedValue(0);
  const acceptDrop = React.useCallback(
    (
      nextOrder: number[],
      changed: boolean,
      observedDragStartedAtEpochMs: number,
    ) => {
      // The accepted order is durable before the visual settle can be cancelled.
      onDrop(nextOrder, changed, observedDragStartedAtEpochMs);
    },
    [onDrop],
  );
  const finishDropVisuals = React.useCallback(
    (finalScrollOffset: number, observedDragStartedAtEpochMs: number) => {
      onScrollSettled(finalScrollOffset);
      onDragFinished(id, observedDragStartedAtEpochMs);
    },
    [id, onDragFinished, onScrollSettled],
  );
  const finishCancelledDrag = React.useCallback(
    (finalScrollOffset: number, observedDragStartedAtEpochMs: number) => {
      onScrollSettled(finalScrollOffset);
      onDragFinished(id, observedDragStartedAtEpochMs);
    },
    [id, onDragFinished, onScrollSettled],
  );
  const gesture = React.useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activateAfterLongPress(DRAG_ACTIVATE_MS)
        .shouldCancelWhenOutside(false)
        .onStart(() => {
          "worklet";
          if (
            draggingCode.value >= 0 ||
            geometryReady.value !== 1 ||
            geometryReadyRevision.value !== expectedGeometryRevision
          ) {
            return;
          }
          const order = committedOrder.value.slice();
          const fromIndex = order.indexOf(code);
          if (fromIndex < 0 || (heights.value[code] ?? 0) <= 0) return;
          const viewport = measure(scrollRef);
          if (viewport != null) {
            viewportPageY.value = viewport.pageY;
            viewportHeight.value = viewport.height;
          }
          isDropping.value = false;
          const observedDragStartedAtEpochMs = Date.now();
          dragStartedAtEpochMs.value = observedDragStartedAtEpochMs;
          overlayReady.value = 0;
          settling.value = 0;
          sessionOrder.value = order;
          draggingCode.value = code;
          dragFromIndex.value = fromIndex;
          dragTargetIndex.value = fromIndex;
          dragStartTop.value = topForCode(order, heights.value, code);
          dragTop.value = dragStartTop.value;
          gestureTranslationY.value = 0;
          dragStartScrollOffset.value = scrollOffset.value;
          autoScrollVelocity.value = 0;
          runOnJS(onDragStart)(id, observedDragStartedAtEpochMs);
        })
        .onUpdate((event) => {
          "worklet";
          if (draggingCode.value !== code) return;
          gestureTranslationY.value = event.translationY;
          updateActiveDragPosition(
            sessionOrder,
            heights,
            draggingCode,
            dragStartTop,
            dragTop,
            gestureTranslationY,
            scrollOffset,
            dragStartScrollOffset,
            dragTargetIndex,
          );
          autoScrollVelocity.value = edgeVelocity(
            event.absoluteY,
            viewportPageY.value,
            viewportHeight.value,
          );
        })
        .onEnd(() => {
          "worklet";
          if (draggingCode.value !== code) return;
          isDropping.value = true;
          settling.value = 1;
          autoScrollVelocity.value = 0;
          const order = sessionOrder.value.slice();
          const fromIndex = dragFromIndex.value;
          const targetIndex = dragTargetIndex.value;
          const observedDragStartedAtEpochMs = dragStartedAtEpochMs.value;
          const nextOrder = moveCode(order, fromIndex, targetIndex);
          const targetTop = topForCode(nextOrder, heights.value, code);
          runOnJS(acceptDrop)(
            nextOrder,
            fromIndex !== targetIndex,
            observedDragStartedAtEpochMs,
          );
          dragTop.value = withTiming(
            targetTop,
            { duration: DROP_SETTLE_MS, easing: Easing.out(Easing.cubic) },
            (finished) => {
              "worklet";
              if (
                !finished ||
                draggingCode.value !== code ||
                dragStartedAtEpochMs.value !== observedDragStartedAtEpochMs
              ) {
                return;
              }
              committedOrder.value = nextOrder;
              overlayReady.value = 0;
              draggingCode.value = -1;
              dragFromIndex.value = -1;
              dragTargetIndex.value = -1;
              gestureTranslationY.value = 0;
              settling.value = 0;
              isDropping.value = false;
              runOnJS(finishDropVisuals)(
                scrollOffset.value,
                observedDragStartedAtEpochMs,
              );
            },
          );
        })
        .onFinalize(() => {
          "worklet";
          if (isDropping.value || draggingCode.value !== code) return;
          settling.value = 1;
          autoScrollVelocity.value = 0;
          const observedDragStartedAtEpochMs = dragStartedAtEpochMs.value;
          dragTop.value = withTiming(
            dragStartTop.value,
            { duration: DROP_SETTLE_MS, easing: Easing.out(Easing.cubic) },
            (finished) => {
              "worklet";
              if (!finished || draggingCode.value !== code) return;
              overlayReady.value = 0;
              draggingCode.value = -1;
              dragFromIndex.value = -1;
              dragTargetIndex.value = -1;
              gestureTranslationY.value = 0;
              settling.value = 0;
              runOnJS(finishCancelledDrag)(
                scrollOffset.value,
                observedDragStartedAtEpochMs,
              );
            },
          );
        }),
    [
      autoScrollVelocity,
      code,
      committedOrder,
      dragFromIndex,
      dragStartScrollOffset,
      dragStartTop,
      dragTargetIndex,
      dragTop,
      draggingCode,
      enabled,
      acceptDrop,
      dragStartedAtEpochMs,
      finishCancelledDrag,
      finishDropVisuals,
      geometryReady,
      geometryReadyRevision,
      gestureTranslationY,
      heights,
      id,
      isDropping,
      expectedGeometryRevision,
      onDragStart,
      overlayReady,
      scrollOffset,
      scrollRef,
      sessionOrder,
      settling,
      viewportHeight,
      viewportPageY,
    ],
  );
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        collapsable={false}
        accessible={enabled}
        accessibilityRole="adjustable"
        accessibilityLabel={reorderAccessibilityLabel}
        pointerEvents={enabled ? "auto" : "none"}
        importantForAccessibility={enabled ? "auto" : "no-hide-descendants"}
        style={styles.handle}
      />
    </GestureDetector>
  );
});
const ReorderableStatisticsRow = React.memo(function ReorderableStatisticsRow({
  id,
  code,
  enabled,
  controllerMounted,
  handleColor,
  reorderAccessibilityLabel,
  scrollRef,
  baseOrder,
  committedOrder,
  sessionOrder,
  heights,
  geometryReady,
  geometryReadyRevision,
  expectedGeometryRevision,
  layoutRevision,
  draggingCode,
  dragFromIndex,
  dragTargetIndex,
  dragStartTop,
  dragTop,
  gestureTranslationY,
  scrollOffset,
  dragStartScrollOffset,
  viewportPageY,
  viewportHeight,
  autoScrollVelocity,
  overlayReady,
  settling,
  onHeight,
  onDragStart,
  onDragFinished,
  onDrop,
  onScrollSettled,
  children,
}: ReorderableStatisticsRowProps) {
  const animatedStyle = useAnimatedStyle(() => {
    if (
      geometryReady.value !== 1 ||
      geometryReadyRevision.value !== expectedGeometryRevision
    ) {
      return {
        opacity: 1,
        zIndex: 0,
        elevation: 0,
        transform: undefined,
      };
    }
    const nativeTop = topForCode(baseOrder.value, heights.value, code);
    const activeCode = draggingCode.value;
    if (activeCode === code) {
      const hiddenBehindOverlay = overlayReady.value === 1;
      return {
        opacity: hiddenBehindOverlay ? 0 : 1,
        zIndex: hiddenBehindOverlay ? 0 : 20,
        elevation: hiddenBehindOverlay ? 0 : 12,
        transform: [
          { translateY: dragTop.value - nativeTop },
          {
            scale: withTiming(settling.value === 1 ? 1 : 1.01, {
              duration: DROP_SETTLE_MS,
              easing: Easing.out(Easing.cubic),
            }),
          },
        ],
      };
    }
    const targetOrder =
      activeCode >= 0
        ? moveCode(
            sessionOrder.value,
            dragFromIndex.value,
            dragTargetIndex.value,
          )
        : committedOrder.value;
    const targetTop = topForCode(targetOrder, heights.value, code);
    const translateY = targetTop - nativeTop;
    return {
      opacity: 1,
      zIndex: 0,
      elevation: 0,
      transform: [
        {
          translateY:
            activeCode >= 0
              ? withTiming(translateY, {
                  duration: NEIGHBOR_SHIFT_MS,
                  easing: Easing.out(Easing.cubic),
                })
              : translateY,
        },
        { scale: 1 },
      ],
    };
  });
  return (
    <Animated.View collapsable={false} style={animatedStyle}>
      {children}
      <View
        key={`layout-proof:${layoutRevision}`}
        pointerEvents="none"
        accessible={false}
        collapsable={false}
        importantForAccessibility="no-hide-descendants"
        onLayout={(event) =>
          onHeight(id, event.nativeEvent.layout.height, layoutRevision)
        }
        style={styles.layoutProof}
      />
      <Animated.View
        pointerEvents="none"
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={styles.handle}
      >
        <MaterialIcons name="drag-handle" size={18} color={handleColor} />
      </Animated.View>
      {controllerMounted ? (
        <StatisticsDragController
          id={id}
          code={code}
          enabled={enabled}
          reorderAccessibilityLabel={reorderAccessibilityLabel}
          scrollRef={scrollRef}
          committedOrder={committedOrder}
          sessionOrder={sessionOrder}
          heights={heights}
          geometryReady={geometryReady}
          geometryReadyRevision={geometryReadyRevision}
          expectedGeometryRevision={expectedGeometryRevision}
          draggingCode={draggingCode}
          dragFromIndex={dragFromIndex}
          dragTargetIndex={dragTargetIndex}
          dragStartTop={dragStartTop}
          dragTop={dragTop}
          gestureTranslationY={gestureTranslationY}
          scrollOffset={scrollOffset}
          dragStartScrollOffset={dragStartScrollOffset}
          viewportPageY={viewportPageY}
          viewportHeight={viewportHeight}
          autoScrollVelocity={autoScrollVelocity}
          overlayReady={overlayReady}
          settling={settling}
          onDragStart={onDragStart}
          onDragFinished={onDragFinished}
          onDrop={onDrop}
          onScrollSettled={onScrollSettled}
        />
      ) : null}
    </Animated.View>
  );
});
function StatisticsDragOverlay({
  code,
  handleColor,
  draggingCode,
  dragTop,
  scrollOffset,
  overlayReady,
  settling,
  onReady,
  children,
}: {
  code: number;
  handleColor: string;
  draggingCode: SharedValue<number>;
  dragTop: SharedValue<number>;
  scrollOffset: SharedValue<number>;
  overlayReady: SharedValue<number>;
  settling: SharedValue<number>;
  onReady: (code: number) => void;
  children: React.ReactNode;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const visible = draggingCode.value === code && overlayReady.value === 1;
    return {
      opacity: visible ? 1 : 0,
      zIndex: visible ? 40 : 0,
      elevation: visible ? 12 : 0,
      transform: [
        {
          translateY: getStatisticsViewportDragTop(
            dragTop.value,
            scrollOffset.value,
          ),
        },
        {
          scale: withTiming(settling.value === 1 ? 1 : 1.01, {
            duration: DROP_SETTLE_MS,
            easing: Easing.out(Easing.cubic),
          }),
        },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      onLayout={() => onReady(code)}
      style={[styles.overlay, animatedStyle]}
    >
      {children}
      <View style={styles.handle}>
        <MaterialIcons name="drag-handle" size={18} color={handleColor} />
      </View>
    </Animated.View>
  );
}
interface StatisticsPresentationFallbackProps {
  visibleOrder: StatsBlockId[];
  content: Record<StatsBlockId, React.ReactNode>;
  handleColor: string;
  layoutRevision: string | number;
  onHeight: (
    id: StatsBlockId,
    height: number,
    layoutRevision: string | number,
  ) => void;
}
const StatisticsPresentationFallback = React.memo(
  function StatisticsPresentationFallback({
    visibleOrder,
    content,
    handleColor,
    layoutRevision,
    onHeight,
  }: StatisticsPresentationFallbackProps) {
    return (
      <View
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.presentationFallback}
      >
        {visibleOrder.map((id) => (
          <View
            key={`${layoutRevision}:${id}`}
            collapsable={false}
            onLayout={(event) =>
              onHeight(id, event.nativeEvent.layout.height, layoutRevision)
            }
          >
            {content[id]}
            <View
              pointerEvents="none"
              accessible={false}
              importantForAccessibility="no-hide-descendants"
              style={styles.handle}
            >
              <MaterialIcons name="drag-handle" size={18} color={handleColor} />
            </View>
          </View>
        ))}
      </View>
    );
  },
);
const styles = {
  handle: {
    position: "absolute" as const,
    top: 8,
    right: 16,
    width: 42,
    height: 36,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    zIndex: 30,
  },
  overlay: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
  },
  presentationFallback: {
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
  },
  layoutProof: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
};
const ReorderableStatisticsScene = React.memo(
  function ReorderableStatisticsScene({
    visibleOrder,
    content,
    geometryRevision,
    handleColor,
    active,
    bottomPadding,
    onReorder,
    initialScrollOffset,
    preservedScrollOffset,
    reorderAccessibilityLabel,
    onScrollSettled,
    onSceneReady,
  }: ReorderableStatisticsSceneProps) {
    const effectiveMode = useVisualEffectiveMode();
    const backgroundColor =
      effectiveMode === "dark" ? darkTheme.background : lightTheme.background;
    const scrollRef =
      useAnimatedRef<React.ComponentRef<typeof Animated.ScrollView>>();
    const mountedScrollRef = React.useRef<React.ComponentRef<
      typeof Animated.ScrollView
    > | null>(null);
    const attachScrollRef = React.useCallback(
      (node: React.ComponentRef<typeof Animated.ScrollView> | null) => {
        mountedScrollRef.current = node;
        scrollRef(node);
      },
      [scrollRef],
    );
    // A drag keeps the native rows frozen and expresses its committed order with
    // UI-thread transforms. A later content presentation rebases those same keyed
    // rows while they are either already in normal flow or covered by an exact
    // normal-flow fallback. The ScrollView, gesture controllers and row instances
    // survive; no obsolete transformed scene can become a visible target frame.
    const requestedPresentationRevision = getStatisticsSceneRevision(
      geometryRevision,
      visibleOrder,
    );
    const [scenePresentation, setScenePresentation] =
      React.useState<StatisticsScenePresentation>(() => ({
        sourceRevision: geometryRevision,
        revision: JSON.stringify([requestedPresentationRevision, 0]),
        attempt: 0,
        nativeOrder: visibleOrder.slice(),
        phase: "ready",
      }));
    const [nativeLayoutDirty, setNativeLayoutDirty] = React.useState(false);
    const nativeLayoutDirtyRef = React.useRef(false);
    const transformedOrderKeyRef = React.useRef<string | null>(null);
    const [controllerMounted, setControllerMounted] = React.useState(false);
    const [overlayId, setOverlayId] = React.useState<StatsBlockId | null>(null);
    const nativeSceneDirty = nativeLayoutDirty || nativeLayoutDirtyRef.current;
    const nextScenePresentation = resolveNextStatisticsScenePresentation(
      scenePresentation,
      {
        sourceRevision: geometryRevision,
        revision: requestedPresentationRevision,
        targetOrder: visibleOrder,
        nativeLayoutDirty: nativeSceneDirty,
        transformedOrderKey: transformedOrderKeyRef.current,
        overlayVisible: overlayId != null,
      },
    );
    const presentationChanged = nextScenePresentation != null;
    const effectiveScenePresentation =
      nextScenePresentation ?? scenePresentation;
    const effectivePresentationRevision = effectiveScenePresentation.revision;
    const effectiveNativeOrder = effectiveScenePresentation.nativeOrder;
    const effectivePhase: StatisticsScenePhase =
      effectiveScenePresentation.phase;
    const fallbackVisible =
      effectivePhase === "preparing-hidden" || effectivePhase === "overlap";
    const dragLayerVisible = effectivePhase !== "preparing-hidden";
    const sceneInteractive =
      active && effectivePhase === "ready" && !presentationChanged;
    const latestPresentationRevisionRef = React.useRef(
      effectivePresentationRevision,
    );
    const fallbackRetireFrameRef = React.useRef<number | null>(null);
    const [heightById, setHeightById] = React.useState<
      Partial<Record<StatsBlockId, number>>
    >({});
    const pendingHeightByIdRef = React.useRef<
      Partial<Record<StatsBlockId, number>>
    >({});
    const heightCommitScheduledRef = React.useRef(false);
    const heightCommitFrameRef = React.useRef<number | null>(null);
    const heightCommitMountedRef = React.useRef(true);
    const presentationProofsRef = React.useRef(
      new Map<
        string | number,
        {
          native: StatisticsPresentationLayoutSamples;
          fallback: StatisticsPresentationLayoutSamples;
          published: boolean;
        }
      >(),
    );
    const presentationProofFrameRef = React.useRef<number | null>(null);
    const presentationMountedRef = React.useRef(true);
    const presentationTargetRef = React.useRef<{
      revision: string | number;
      order: StatsBlockId[];
      usesFallback: boolean;
      bottomPadding: number;
    }>({
      revision: effectivePresentationRevision,
      order: effectiveNativeOrder.slice(),
      usesFallback: false,
      bottomPadding,
    });
    const initializedPresentationRevisionRef = React.useRef<string | number>(
      scenePresentation.revision,
    );
    const announcedReadyRevisionRef = React.useRef<string | number | null>(
      null,
    );
    const nativeOrderCodes = React.useMemo(
      () => effectiveNativeOrder.map((id) => BLOCK_CODE[id]),
      [effectiveNativeOrder],
    );
    const visibleOrderCodes = React.useMemo(
      () => visibleOrder.map((id) => BLOCK_CODE[id]),
      [visibleOrder],
    );
    const currentHeights = React.useMemo(
      () => [
        heightById.summary ?? 0,
        heightById.heatmap ?? 0,
        heightById.bar ?? 0,
        heightById.habit ?? 0,
      ],
      [
        heightById.bar,
        heightById.habit,
        heightById.heatmap,
        heightById.summary,
      ],
    );
    const layoutReady = effectiveNativeOrder.every(
      (id) => (heightById[id] ?? 0) > 0,
    );
    const controllerShouldBeMounted = controllerMounted || layoutReady;
    const baseOrder = useSharedValue<number[]>([]);
    const committedOrder = useSharedValue<number[]>([]);
    const sessionOrder = useSharedValue<number[]>([]);
    const heights = useSharedValue<number[]>([0, 0, 0, 0]);
    const geometryReady = useSharedValue(0);
    const geometryReadyRevision = useSharedValue<string | number | null>(
      effectivePresentationRevision,
    );
    const activePresentationRevision = useSharedValue<string | number>(
      effectivePresentationRevision,
    );
    const draggingCode = useSharedValue(-1);
    const dragFromIndex = useSharedValue(-1);
    const dragTargetIndex = useSharedValue(-1);
    const dragStartTop = useSharedValue(0);
    const dragTop = useSharedValue(0);
    const gestureTranslationY = useSharedValue(0);
    const scrollOffset = useSharedValue(Math.max(0, initialScrollOffset));
    const dragStartScrollOffset = useSharedValue(0);
    const viewportPageY = useSharedValue(0);
    const viewportHeight = useSharedValue(0);
    const autoScrollVelocity = useSharedValue(0);
    const scrollContentHeight = useSharedValue(0);
    const overlayReady = useSharedValue(0);
    const settling = useSharedValue(0);
    const nativeScrollDragActive = useSharedValue(0);
    const nativeScrollMomentumActive = useSharedValue(0);
    const topScrollSettleTimerRef = React.useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const activeDropOwnerRef = React.useRef<{
      startedAtEpochMs: number;
      target: StatsBlockId;
      nativeOrder: StatsBlockId[];
      commit: ReorderableStatisticsBlocksProps["onReorder"];
      accepted: boolean;
    } | null>(null);
    const sceneInteractionAdmissionRef = React.useRef<object | null>(null);
    const sceneInteractionAdmissionToken = React.useMemo<object>(
      () => ({ active, effectivePresentationRevision }),
      [active, effectivePresentationRevision],
    );
    React.useLayoutEffect(() => {
      if (!active) return;
      sceneInteractionAdmissionRef.current = sceneInteractionAdmissionToken;
      return () => {
        if (
          sceneInteractionAdmissionRef.current ===
          sceneInteractionAdmissionToken
        ) {
          sceneInteractionAdmissionRef.current = null;
        }
      };
    }, [active, sceneInteractionAdmissionToken]);
    const publishOwnedScrollOffset = React.useCallback(
      (offset: number) => {
        if (
          sceneInteractionAdmissionRef.current !==
          sceneInteractionAdmissionToken
        ) {
          return;
        }
        onScrollSettled(offset);
      },
      [onScrollSettled, sceneInteractionAdmissionToken],
    );
    React.useLayoutEffect(() => {
      latestPresentationRevisionRef.current = effectivePresentationRevision;
    }, [effectivePresentationRevision]);
    const clearTopScrollSettleTimer = React.useCallback(() => {
      if (topScrollSettleTimerRef.current == null) return;
      clearTimeout(topScrollSettleTimerRef.current);
      topScrollSettleTimerRef.current = null;
    }, []);
    const clearOwnedTopScrollSettleTimer = React.useCallback(() => {
      if (
        sceneInteractionAdmissionRef.current !== sceneInteractionAdmissionToken
      ) {
        return;
      }
      clearTopScrollSettleTimer();
    }, [clearTopScrollSettleTimer, sceneInteractionAdmissionToken]);
    const settleAtTop = React.useCallback(() => {
      if (
        sceneInteractionAdmissionRef.current !== sceneInteractionAdmissionToken
      ) {
        return;
      }
      runOnUI(
        (
          ref: AnimatedRef<React.ComponentRef<typeof Animated.ScrollView>>,
          offset: SharedValue<number>,
          dragCode: SharedValue<number>,
          scrollDragActive: SharedValue<number>,
          scrollMomentumActive: SharedValue<number>,
        ) => {
          "worklet";
          if (
            !shouldSettleStatisticsAtTop(
              offset.value,
              dragCode.value,
              scrollDragActive.value,
              scrollMomentumActive.value,
              TOP_SCROLL_SETTLE_THRESHOLD_DP,
            )
          ) {
            return;
          }
          if (Math.abs(offset.value) <= 0.5) {
            offset.value = 0;
            return;
          }
          offset.value = 0;
          scrollTo(ref, 0, 0, false);
        },
      )(
        scrollRef,
        scrollOffset,
        draggingCode,
        nativeScrollDragActive,
        nativeScrollMomentumActive,
      );
    }, [
      draggingCode,
      nativeScrollDragActive,
      nativeScrollMomentumActive,
      scrollOffset,
      scrollRef,
      sceneInteractionAdmissionToken,
    ]);
    const scheduleTopScrollSettle = React.useCallback(
      (offset: number) => {
        if (
          sceneInteractionAdmissionRef.current !==
          sceneInteractionAdmissionToken
        ) {
          return;
        }
        if (offset > TOP_SCROLL_SETTLE_THRESHOLD_DP) {
          onScrollSettled(offset);
          return;
        }
        onScrollSettled(0);
        clearTopScrollSettleTimer();
        topScrollSettleTimerRef.current = setTimeout(() => {
          topScrollSettleTimerRef.current = null;
          settleAtTop();
        }, TOP_SCROLL_SETTLE_DELAY_MS);
      },
      [
        clearTopScrollSettleTimer,
        onScrollSettled,
        sceneInteractionAdmissionToken,
        settleAtTop,
      ],
    );
    React.useEffect(
      () => () => {
        clearTopScrollSettleTimer();
      },
      [clearTopScrollSettleTimer],
    );
    const flushPendingHeights = React.useCallback(() => {
      heightCommitScheduledRef.current = false;
      heightCommitFrameRef.current = null;
      const pending = pendingHeightByIdRef.current;
      pendingHeightByIdRef.current = {};
      if (!heightCommitMountedRef.current) return;
      setHeightById((previous) => {
        let next = previous;
        for (const id of BLOCK_IDS) {
          const height = pending[id];
          if (
            height == null ||
            height <= 0 ||
            Math.abs((previous[id] ?? 0) - height) < 0.5
          ) {
            continue;
          }
          if (next === previous) next = { ...previous };
          next[id] = height;
        }
        return next;
      });
    }, []);
    const reportPresentationReady = React.useCallback(
      (
        readyRevision: string | number,
        measuredHeights: number[],
        usedFallback: boolean,
      ) => {
        if (!presentationMountedRef.current) return;
        if (
          !isStatisticsSceneRevisionCurrent(
            latestPresentationRevisionRef.current,
            readyRevision,
          )
        ) {
          return;
        }
        setHeightById((previous) => {
          let next = previous;
          for (const id of BLOCK_IDS) {
            const measuredHeight = measuredHeights[BLOCK_CODE[id]] ?? 0;
            if (
              measuredHeight <= 0 ||
              Math.abs((previous[id] ?? 0) - measuredHeight) < 0.5
            ) {
              continue;
            }
            if (next === previous) next = { ...previous };
            next[id] = measuredHeight;
          }
          return next;
        });
        setNativeLayoutDirty(false);
        nativeLayoutDirtyRef.current = false;
        transformedOrderKeyRef.current = null;
        setScenePresentation((current) =>
          current.revision === readyRevision
            ? {
                ...current,
                phase: usedFallback ? "overlap" : "ready",
              }
            : current,
        );
      },
      [],
    );
    const presentationProofScheduleRef = React.useRef(0);
    const cancelPresentationProofFrame = React.useCallback(() => {
      presentationProofScheduleRef.current += 1;
      if (presentationProofFrameRef.current != null) {
        globalThis.cancelAnimationFrame?.(presentationProofFrameRef.current);
        presentationProofFrameRef.current = null;
      }
    }, []);
    React.useEffect(
      () => () => {
        presentationProofsRef.current.clear();
      },
      [],
    );
    React.useLayoutEffect(() => {
      presentationMountedRef.current = true;
      runOnUI(
        (
          activeRevision: SharedValue<string | number>,
          currentRevision: string | number,
        ) => {
          "worklet";
          activeRevision.value = currentRevision;
        },
      )(activePresentationRevision, latestPresentationRevisionRef.current);
      return () => {
        presentationMountedRef.current = false;
        cancelPresentationProofFrame();
        runOnUI((activeRevision: SharedValue<string | number>) => {
          "worklet";
          activeRevision.value = "__statistics-scene-unmounted__";
        })(activePresentationRevision);
      };
    }, [activePresentationRevision, cancelPresentationProofFrame]);
    const schedulePresentationProof = React.useCallback(
      (revision: string | number) => {
        cancelPresentationProofFrame();
        const requestFrame = globalThis.requestAnimationFrame;
        if (
          !presentationMountedRef.current ||
          typeof requestFrame !== "function"
        ) {
          return;
        }
        const scheduleId = presentationProofScheduleRef.current;
        presentationProofFrameRef.current = requestFrame(() => {
          if (
            !presentationMountedRef.current ||
            presentationProofScheduleRef.current !== scheduleId
          ) {
            return;
          }
          presentationProofFrameRef.current = requestFrame(() => {
            presentationProofFrameRef.current = null;
            if (
              !presentationMountedRef.current ||
              presentationProofScheduleRef.current !== scheduleId
            ) {
              return;
            }
            const target = presentationTargetRef.current;
            if (target.revision !== revision) return;
            const proof = presentationProofsRef.current.get(revision);
            if (proof == null || proof.published) return;
            const orderedHeights = resolveStatisticsPresentationHeights(
              target.order,
              revision,
              proof.native,
              target.usesFallback ? proof.fallback : null,
              PRESENTATION_READY_TOLERANCE_DP,
            );
            if (orderedHeights == null) return;
            proof.published = true;
            const measuredHeights = [0, 0, 0, 0];
            target.order.forEach((id, index) => {
              measuredHeights[BLOCK_CODE[id]] = orderedHeights[index] ?? 0;
            });
            const orderCodes = target.order.map((id) => BLOCK_CODE[id]);
            const nextContentHeight =
              totalHeight(orderCodes, measuredHeights) + target.bottomPadding;
            const desiredOffset =
              viewportHeight.value > 0
                ? Math.min(
                    Math.max(0, nextContentHeight - viewportHeight.value),
                    Math.max(0, preservedScrollOffset.value),
                  )
                : Math.max(0, preservedScrollOffset.value);
            const currentScrollView = mountedScrollRef.current;
            if (!presentationMountedRef.current || currentScrollView == null) {
              proof.published = false;
              return;
            }
            currentScrollView.scrollTo({
              x: 0,
              y: desiredOffset,
              animated: false,
            });
            runOnUI(
              (
                activeRevision: SharedValue<string | number>,
                ready: SharedValue<number>,
                readyRevision: SharedValue<string | number | null>,
                nextBaseOrder: SharedValue<number[]>,
                nextCommittedOrder: SharedValue<number[]>,
                nextSessionOrder: SharedValue<number[]>,
                nextHeightsOwner: SharedValue<number[]>,
                contentHeight: SharedValue<number>,
                preservedOffset: SharedValue<number>,
                currentOffset: SharedValue<number>,
                targetRevision: string | number,
                targetOrder: number[],
                targetHeights: number[],
                targetContentHeight: number,
                targetScrollOffset: number,
                usedFallback: boolean,
              ) => {
                "worklet";
                if (activeRevision.value !== targetRevision) return;
                nextBaseOrder.value = targetOrder;
                nextCommittedOrder.value = targetOrder;
                nextSessionOrder.value = targetOrder;
                nextHeightsOwner.value = targetHeights;
                contentHeight.value = targetContentHeight;
                preservedOffset.value = targetScrollOffset;
                currentOffset.value = targetScrollOffset;
                readyRevision.value = targetRevision;
                ready.value = 1;
                runOnJS(reportPresentationReady)(
                  targetRevision,
                  targetHeights,
                  usedFallback,
                );
              },
            )(
              activePresentationRevision,
              geometryReady,
              geometryReadyRevision,
              baseOrder,
              committedOrder,
              sessionOrder,
              heights,
              scrollContentHeight,
              preservedScrollOffset,
              scrollOffset,
              revision,
              orderCodes,
              measuredHeights,
              nextContentHeight,
              desiredOffset,
              target.usesFallback,
            );
          });
        });
      },
      [
        activePresentationRevision,
        baseOrder,
        cancelPresentationProofFrame,
        committedOrder,
        geometryReady,
        geometryReadyRevision,
        heights,
        preservedScrollOffset,
        reportPresentationReady,
        scrollContentHeight,
        scrollOffset,
        sessionOrder,
        viewportHeight,
      ],
    );
    const recordPresentationLayout = React.useCallback(
      (
        layer: "native" | "fallback",
        id: StatsBlockId,
        height: number,
        layoutRevision: string | number,
      ) => {
        if (!Number.isFinite(height) || height <= 0) return;
        let proof = presentationProofsRef.current.get(layoutRevision);
        if (proof == null) {
          proof = {
            native: {},
            fallback: {},
            published: false,
          };
          presentationProofsRef.current.set(layoutRevision, proof);
        }
        const owner = layer === "native" ? proof.native : proof.fallback;
        const previous = owner[id];
        if (
          previous?.revision === layoutRevision &&
          Math.abs(previous.height - height) < 0.1
        ) {
          return;
        }
        owner[id] = { revision: layoutRevision, height };
        if (presentationTargetRef.current.revision === layoutRevision) {
          schedulePresentationProof(layoutRevision);
        }
      },
      [schedulePresentationProof],
    );
    const handleHeight = React.useCallback(
      (id: StatsBlockId, height: number, layoutRevision: string | number) => {
        if (height <= 0) return;
        recordPresentationLayout("native", id, height, layoutRevision);
        if (layoutRevision !== presentationTargetRef.current.revision) return;
        pendingHeightByIdRef.current[id] = height;
        if (heightCommitScheduledRef.current) return;
        heightCommitScheduledRef.current = true;
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === "function") {
          heightCommitFrameRef.current = raf(flushPendingHeights);
        } else {
          queueMicrotask(flushPendingHeights);
        }
      },
      [flushPendingHeights, recordPresentationLayout],
    );
    const handleFallbackHeight = React.useCallback(
      (id: StatsBlockId, height: number, layoutRevision: string | number) => {
        recordPresentationLayout("fallback", id, height, layoutRevision);
      },
      [recordPresentationLayout],
    );
    React.useLayoutEffect(() => {
      heightCommitMountedRef.current = true;
      return () => {
        heightCommitMountedRef.current = false;
        if (heightCommitFrameRef.current != null) {
          globalThis.cancelAnimationFrame?.(heightCommitFrameRef.current);
        }
        heightCommitScheduledRef.current = false;
        heightCommitFrameRef.current = null;
        pendingHeightByIdRef.current = {};
      };
    }, []);
    React.useLayoutEffect(() => {
      if (layoutReady && !controllerMounted) setControllerMounted(true);
    }, [controllerMounted, layoutReady]);
    React.useLayoutEffect(() => {
      if (
        !layoutReady ||
        presentationChanged ||
        effectivePhase !== "ready" ||
        announcedReadyRevisionRef.current === effectivePresentationRevision
      ) {
        return;
      }
      announcedReadyRevisionRef.current = effectivePresentationRevision;
      onSceneReady?.();
    }, [
      effectivePhase,
      effectivePresentationRevision,
      layoutReady,
      onSceneReady,
      presentationChanged,
    ]);
    // The first commit uses ordinary Yoga flow and is already visually correct.
    // Once heights are known, Reanimated receives the exact same geometry and
    // takes ownership only of future reorder transforms.
    React.useLayoutEffect(() => {
      if (!sceneInteractive) return;
      runOnUI(
        (
          ready: boolean,
          nextBaseOrder: number[],
          nextVisibleOrder: number[],
          nextHeights: number[],
          paddedHeight: number,
          readyRevision: string | number,
        ) => {
          "worklet";
          if (!ready) {
            geometryReady.value = 0;
            return;
          }
          if (draggingCode.value >= 0) return;
          baseOrder.value = nextBaseOrder;
          committedOrder.value = nextVisibleOrder;
          sessionOrder.value = nextVisibleOrder;
          heights.value = nextHeights;
          scrollContentHeight.value =
            totalHeight(nextBaseOrder, nextHeights) + paddedHeight;
          geometryReadyRevision.value = readyRevision;
          geometryReady.value = 1;
        },
      )(
        layoutReady,
        nativeOrderCodes,
        visibleOrderCodes,
        currentHeights,
        bottomPadding,
        effectivePresentationRevision,
      );
    }, [
      baseOrder,
      bottomPadding,
      committedOrder,
      currentHeights,
      draggingCode,
      geometryReady,
      geometryReadyRevision,
      effectivePresentationRevision,
      heights,
      layoutReady,
      nativeOrderCodes,
      overlayId,
      sceneInteractive,
      scrollContentHeight,
      sessionOrder,
      visibleOrderCodes,
    ]);
    const handleViewportLayout = React.useCallback(
      (event: LayoutChangeEvent) => {
        const nextHeight = event.nativeEvent.layout.height;
        if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
        runOnUI((viewport: SharedValue<number>, measuredHeight: number) => {
          "worklet";
          viewport.value = measuredHeight;
        })(viewportHeight, nextHeight);
      },
      [viewportHeight],
    );
    const scrollHandler = useAnimatedScrollHandler({
      onBeginDrag: () => {
        nativeScrollDragActive.value = 1;
        nativeScrollMomentumActive.value = 0;
        runOnJS(clearOwnedTopScrollSettleTimer)();
      },
      onScroll: (event) => {
        if (draggingCode.value >= 0) return;
        scrollOffset.value = event.contentOffset.y;
        preservedScrollOffset.value = Math.max(0, event.contentOffset.y);
        if (
          nativeScrollMomentumActive.value === 1 &&
          nativeScrollDragActive.value === 0 &&
          event.contentOffset.y <= TOP_SCROLL_SETTLE_THRESHOLD_DP
        ) {
          nativeScrollMomentumActive.value = 0;
          scrollOffset.value = 0;
          scrollTo(scrollRef, 0, 0, false);
          runOnJS(clearOwnedTopScrollSettleTimer)();
        }
      },
      onEndDrag: (event) => {
        nativeScrollDragActive.value = 0;
        if (draggingCode.value < 0) {
          runOnJS(scheduleTopScrollSettle)(event.contentOffset.y);
        }
      },
      onMomentumBegin: () => {
        nativeScrollMomentumActive.value = 1;
        runOnJS(clearOwnedTopScrollSettleTimer)();
      },
      onMomentumEnd: (event) => {
        nativeScrollMomentumActive.value = 0;
        if (draggingCode.value < 0) {
          runOnJS(scheduleTopScrollSettle)(event.contentOffset.y);
        }
      },
    });
    const autoScrollFrame = useFrameCallback(
      React.useCallback(
        (frameInfo) => {
          "worklet";
          if (
            draggingCode.value < 0 ||
            overlayReady.value !== 1 ||
            autoScrollVelocity.value === 0
          ) {
            return;
          }
          const elapsed = Math.min(
            32,
            Math.max(0, frameInfo.timeSincePreviousFrame ?? 16),
          );
          const previousOffset = scrollOffset.value;
          const nextOffset = getStatisticsAutoScrollOffset(
            previousOffset,
            scrollContentHeight.value,
            viewportHeight.value,
            autoScrollVelocity.value,
            elapsed,
          );
          if (nextOffset === previousOffset) return;
          scrollOffset.value = nextOffset;
          updateActiveDragPosition(
            sessionOrder,
            heights,
            draggingCode,
            dragStartTop,
            dragTop,
            gestureTranslationY,
            scrollOffset,
            dragStartScrollOffset,
            dragTargetIndex,
          );
          scrollTo(scrollRef, 0, nextOffset, false);
        },
        [
          autoScrollVelocity,
          dragStartScrollOffset,
          dragStartTop,
          dragTargetIndex,
          dragTop,
          draggingCode,
          gestureTranslationY,
          heights,
          overlayReady,
          scrollContentHeight,
          scrollOffset,
          scrollRef,
          sessionOrder,
          viewportHeight,
        ],
      ),
      false,
    );
    React.useLayoutEffect(() => {
      if (active) return;
      clearTopScrollSettleTimer();
      if (autoScrollFrame.isActive) autoScrollFrame.setActive(false);
      setOverlayId(null);
      runOnUI(
        (
          dragCode: SharedValue<number>,
          fromIndex: SharedValue<number>,
          targetIndex: SharedValue<number>,
          translationY: SharedValue<number>,
          edgeScrollVelocity: SharedValue<number>,
          readyOverlay: SharedValue<number>,
          isSettling: SharedValue<number>,
        ) => {
          "worklet";
          dragCode.value = -1;
          fromIndex.value = -1;
          targetIndex.value = -1;
          translationY.value = 0;
          edgeScrollVelocity.value = 0;
          readyOverlay.value = 0;
          isSettling.value = 0;
        },
      )(
        draggingCode,
        dragFromIndex,
        dragTargetIndex,
        gestureTranslationY,
        autoScrollVelocity,
        overlayReady,
        settling,
      );
    }, [
      active,
      autoScrollFrame,
      autoScrollVelocity,
      clearTopScrollSettleTimer,
      dragFromIndex,
      dragTargetIndex,
      draggingCode,
      gestureTranslationY,
      overlayReady,
      settling,
    ]);
    React.useLayoutEffect(
      () => () => {
        clearTopScrollSettleTimer();
        if (autoScrollFrame.isActive) autoScrollFrame.setActive(false);
        runOnUI(
          (
            dragCode: SharedValue<number>,
            edgeScrollVelocity: SharedValue<number>,
            readyOverlay: SharedValue<number>,
            isSettling: SharedValue<number>,
          ) => {
            "worklet";
            dragCode.value = -1;
            edgeScrollVelocity.value = 0;
            readyOverlay.value = 0;
            isSettling.value = 0;
          },
        )(draggingCode, autoScrollVelocity, overlayReady, settling);
      },
      [
        autoScrollFrame,
        autoScrollVelocity,
        clearTopScrollSettleTimer,
        draggingCode,
        overlayReady,
        settling,
      ],
    );
    React.useLayoutEffect(() => {
      if (
        scenePresentation.phase !== "preparing-hidden" &&
        scenePresentation.phase !== "preparing-visible"
      ) {
        return;
      }
      if (
        initializedPresentationRevisionRef.current ===
        scenePresentation.revision
      ) {
        return;
      }
      initializedPresentationRevisionRef.current = scenePresentation.revision;
      cancelPresentationProofFrame();
      if (heightCommitFrameRef.current != null) {
        globalThis.cancelAnimationFrame?.(heightCommitFrameRef.current);
        heightCommitFrameRef.current = null;
      }
      heightCommitScheduledRef.current = false;
      pendingHeightByIdRef.current = {};
      presentationTargetRef.current = {
        revision: scenePresentation.revision,
        order: scenePresentation.nativeOrder.slice(),
        usesFallback: scenePresentation.phase === "preparing-hidden",
        bottomPadding,
      };
      for (const revision of presentationProofsRef.current.keys()) {
        if (revision !== scenePresentation.revision) {
          presentationProofsRef.current.delete(revision);
        }
      }
      const currentProof = presentationProofsRef.current.get(
        scenePresentation.revision,
      );
      if (currentProof != null) currentProof.published = false;
      if (fallbackRetireFrameRef.current != null) {
        globalThis.cancelAnimationFrame?.(fallbackRetireFrameRef.current);
        fallbackRetireFrameRef.current = null;
      }
      if (autoScrollFrame.isActive) autoScrollFrame.setActive(false);
      clearTopScrollSettleTimer();
      setOverlayId(null);
      runOnUI(
        (
          geometry: SharedValue<number>,
          readyRevision: SharedValue<string | number | null>,
          dragCode: SharedValue<number>,
          fromIndex: SharedValue<number>,
          targetIndex: SharedValue<number>,
          translationY: SharedValue<number>,
          edgeScrollVelocity: SharedValue<number>,
          readyOverlay: SharedValue<number>,
          isSettling: SharedValue<number>,
          scrollDragActive: SharedValue<number>,
          scrollMomentumActive: SharedValue<number>,
          activeRevision: SharedValue<string | number>,
          targetRevision: string | number,
        ) => {
          "worklet";
          activeRevision.value = targetRevision;
          geometry.value = 0;
          readyRevision.value = null;
          dragCode.value = -1;
          fromIndex.value = -1;
          targetIndex.value = -1;
          translationY.value = 0;
          edgeScrollVelocity.value = 0;
          readyOverlay.value = 0;
          isSettling.value = 0;
          scrollDragActive.value = 0;
          scrollMomentumActive.value = 0;
        },
      )(
        geometryReady,
        geometryReadyRevision,
        draggingCode,
        dragFromIndex,
        dragTargetIndex,
        gestureTranslationY,
        autoScrollVelocity,
        overlayReady,
        settling,
        nativeScrollDragActive,
        nativeScrollMomentumActive,
        activePresentationRevision,
        scenePresentation.revision,
      );
      schedulePresentationProof(scenePresentation.revision);
    }, [
      activePresentationRevision,
      autoScrollFrame,
      autoScrollVelocity,
      bottomPadding,
      cancelPresentationProofFrame,
      clearTopScrollSettleTimer,
      dragFromIndex,
      dragTargetIndex,
      draggingCode,
      geometryReady,
      geometryReadyRevision,
      gestureTranslationY,
      nativeScrollDragActive,
      nativeScrollMomentumActive,
      overlayReady,
      schedulePresentationProof,
      scenePresentation.nativeOrder,
      scenePresentation.phase,
      scenePresentation.revision,
      settling,
    ]);
    React.useLayoutEffect(() => {
      if (presentationChanged) return;
      if (scenePresentation.phase !== "overlap") return;
      const readyRevision = scenePresentation.revision;
      fallbackRetireFrameRef.current =
        globalThis.requestAnimationFrame?.(() => {
          fallbackRetireFrameRef.current =
            globalThis.requestAnimationFrame?.(() => {
              fallbackRetireFrameRef.current = null;
              if (latestPresentationRevisionRef.current !== readyRevision)
                return;
              setScenePresentation((current) =>
                current.revision === readyRevision &&
                current.phase === "overlap"
                  ? { ...current, phase: "ready" }
                  : current,
              );
            }) ?? null;
        }) ?? null;
      return () => {
        if (fallbackRetireFrameRef.current != null) {
          globalThis.cancelAnimationFrame?.(fallbackRetireFrameRef.current);
          fallbackRetireFrameRef.current = null;
        }
      };
    }, [
      presentationChanged,
      scenePresentation.phase,
      scenePresentation.revision,
    ]);
    const handleDrop = React.useCallback(
      (
        orderCodes: number[],
        changed: boolean,
        dragStartedAtEpochMs: number,
      ) => {
        const owner = activeDropOwnerRef.current;
        if (
          owner == null ||
          owner.startedAtEpochMs !== dragStartedAtEpochMs ||
          owner.accepted
        ) {
          return;
        }
        owner.accepted = true;
        if (!changed) {
          activeDropOwnerRef.current = null;
          return;
        }
        const nextIds = orderCodes
          .map((code) => BLOCK_IDS[code])
          .filter((id): id is StatsBlockId => id != null);
        const nextLayoutDirty = !areStatisticsBlockOrdersEqual(
          owner.nativeOrder,
          nextIds,
        );
        if (presentationMountedRef.current) {
          nativeLayoutDirtyRef.current = nextLayoutDirty;
          transformedOrderKeyRef.current = nextLayoutDirty
            ? getStatisticsBlockOrderKey(nextIds)
            : null;
          setNativeLayoutDirty(nextLayoutDirty);
        }
        try {
          owner.commit(nextIds);
        } finally {
          if (activeDropOwnerRef.current === owner) {
            activeDropOwnerRef.current = null;
          }
        }
      },
      [],
    );
    const handleDragStart = React.useCallback(
      (id: StatsBlockId, observedAtEpochMs: number) => {
        activeDropOwnerRef.current = {
          startedAtEpochMs: observedAtEpochMs,
          target: id,
          nativeOrder: scenePresentation.nativeOrder.slice(),
          commit: onReorder,
          accepted: false,
        };
        if (
          sceneInteractionAdmissionRef.current !==
          sceneInteractionAdmissionToken
        ) {
          return;
        }
        if (!autoScrollFrame.isActive) autoScrollFrame.setActive(true);
        setOverlayId(id);
      },
      [
        autoScrollFrame,
        onReorder,
        sceneInteractionAdmissionToken,
        scenePresentation.nativeOrder,
      ],
    );
    const handleDragFinished = React.useCallback(
      (id: StatsBlockId, dragStartedAtEpochMs: number) => {
        if (
          sceneInteractionAdmissionRef.current !==
          sceneInteractionAdmissionToken
        ) {
          return;
        }
        const owner = activeDropOwnerRef.current;
        if (
          owner != null &&
          (owner.target !== id ||
            owner.startedAtEpochMs !== dragStartedAtEpochMs)
        ) {
          return;
        }
        if (owner != null) {
          activeDropOwnerRef.current = null;
        }
        if (autoScrollFrame.isActive) autoScrollFrame.setActive(false);
        setOverlayId((current) => (current === id ? null : current));
      },
      [autoScrollFrame, sceneInteractionAdmissionToken],
    );
    const handleOverlayReady = React.useCallback(
      (code: number) => {
        if (
          sceneInteractionAdmissionRef.current !==
          sceneInteractionAdmissionToken
        ) {
          return;
        }
        runOnUI((nextCode: number) => {
          "worklet";
          if (draggingCode.value !== nextCode) return;
          overlayReady.value = 1;
        })(code);
      },
      [draggingCode, overlayReady, sceneInteractionAdmissionToken],
    );
    // Keep selector and body on one presentation revision without paying for a
    // full target row-tree render followed by a synchronous layout-effect retry.
    // React retries this component before it renders the returned children.
    if (nextScenePresentation != null) {
      setScenePresentation(nextScenePresentation);
    }
    return (
      <View style={{ flex: 1, overflow: "hidden" }}>
        <Animated.ScrollView
          ref={attachScrollRef}
          style={{ flex: 1, backgroundColor }}
          contentOffset={{ x: 0, y: initialScrollOffset }}
          onLayout={handleViewportLayout}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          removeClippedSubviews={false}
          keyboardShouldPersistTaps="always"
          scrollEnabled={active}
          contentContainerStyle={{ paddingBottom: bottomPadding }}
        >
          <View style={{ position: "relative" }}>
            <View
              pointerEvents={sceneInteractive ? "auto" : "none"}
              accessibilityElementsHidden={!sceneInteractive}
              importantForAccessibility={
                sceneInteractive ? "auto" : "no-hide-descendants"
              }
              style={{ opacity: dragLayerVisible ? 1 : 0, zIndex: 1 }}
            >
              {effectiveNativeOrder.map((id) => (
                <ReorderableStatisticsRow
                  key={id}
                  id={id}
                  code={BLOCK_CODE[id]}
                  enabled={layoutReady && sceneInteractive}
                  controllerMounted={controllerShouldBeMounted}
                  handleColor={handleColor}
                  reorderAccessibilityLabel={reorderAccessibilityLabel}
                  scrollRef={scrollRef}
                  baseOrder={baseOrder}
                  committedOrder={committedOrder}
                  sessionOrder={sessionOrder}
                  heights={heights}
                  geometryReady={geometryReady}
                  geometryReadyRevision={geometryReadyRevision}
                  expectedGeometryRevision={effectivePresentationRevision}
                  layoutRevision={effectivePresentationRevision}
                  draggingCode={draggingCode}
                  dragFromIndex={dragFromIndex}
                  dragTargetIndex={dragTargetIndex}
                  dragStartTop={dragStartTop}
                  dragTop={dragTop}
                  gestureTranslationY={gestureTranslationY}
                  scrollOffset={scrollOffset}
                  dragStartScrollOffset={dragStartScrollOffset}
                  viewportPageY={viewportPageY}
                  viewportHeight={viewportHeight}
                  autoScrollVelocity={autoScrollVelocity}
                  overlayReady={overlayReady}
                  settling={settling}
                  onHeight={handleHeight}
                  onDragStart={handleDragStart}
                  onDragFinished={handleDragFinished}
                  onDrop={handleDrop}
                  onScrollSettled={publishOwnedScrollOffset}
                >
                  {content[id]}
                </ReorderableStatisticsRow>
              ))}
            </View>

            {fallbackVisible ? (
              <StatisticsPresentationFallback
                visibleOrder={visibleOrder}
                content={content}
                handleColor={handleColor}
                layoutRevision={effectivePresentationRevision}
                onHeight={handleFallbackHeight}
              />
            ) : null}
          </View>
        </Animated.ScrollView>

        {sceneInteractive && overlayId != null ? (
          <StatisticsDragOverlay
            code={BLOCK_CODE[overlayId]}
            handleColor={handleColor}
            draggingCode={draggingCode}
            dragTop={dragTop}
            scrollOffset={scrollOffset}
            overlayReady={overlayReady}
            settling={settling}
            onReady={handleOverlayReady}
          >
            {content[overlayId]}
          </StatisticsDragOverlay>
        ) : null}
      </View>
    );
  },
);
export function ReorderableStatisticsBlocks(
  props: ReorderableStatisticsBlocksProps,
) {
  const active = props.active ?? true;
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const bottomPadding = insets.bottom + 16;
  const reorderAccessibilityLabel = t("accessibility.reorderStatisticsBlock");
  // A pure reorder and every later content presentation reuse one native scene.
  // The revision starts an in-place geometry handoff without changing React
  // keys, keeping the ScrollView, rows and gesture controllers mounted.
  const presentationKey = React.useMemo(
    () =>
      getStatisticsScenePresentationKey(
        props.visibleOrder,
        `${props.geometryRevision}:${width}:${height}:${fontScale}`,
      ),
    [fontScale, height, props.geometryRevision, props.visibleOrder, width],
  );
  const preservedScrollOffset = useSharedValue(0);
  const settledScrollOffsetRef = React.useRef(0);
  const handleScrollSettled = React.useCallback(
    (offset: number) => {
      const normalized = Math.max(0, Number.isFinite(offset) ? offset : 0);
      settledScrollOffsetRef.current = normalized;
      preservedScrollOffset.value = normalized;
    },
    [preservedScrollOffset],
  );
  return (
    <View style={{ flex: 1 }}>
      {props.presentationHeader}
      <ReorderableStatisticsScene
        visibleOrder={props.visibleOrder}
        content={props.content}
        geometryRevision={presentationKey}
        handleColor={props.handleColor}
        active={active}
        bottomPadding={bottomPadding}
        onReorder={props.onReorder}
        initialScrollOffset={settledScrollOffsetRef.current}
        preservedScrollOffset={preservedScrollOffset}
        reorderAccessibilityLabel={reorderAccessibilityLabel}
        onScrollSettled={handleScrollSettled}
        onSceneReady={props.onSceneReady}
      />
    </View>
  );
}
