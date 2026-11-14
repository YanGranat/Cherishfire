import React, { useEffect, useRef } from "react";
import { View, StyleSheet } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { HabitItem } from "./HabitItem";
import {
  FLIGHT_OVERLAY_Z,
  SEPARATOR_RENDER_HEIGHT,
  SLOT_HEIGHT,
} from "../animation/constants";
import type { FlyingState } from "../hooks/useHabitTransfer";
import type { AnimatedStyle } from "react-native-reanimated";
import type { ViewStyle } from "react-native";
type OverlayLayer = "under" | "over";
interface SectionFlightOverlayProps {
  flyingState: FlyingState | null;
  overlayStyle: AnimatedStyle<ViewStyle>;
  separatorColor: string;
  surfaceBackgroundColor: string;
  layer?: OverlayLayer;
  yOffset?: number;
  clipTopY?: number | null;
  clipBottomAnimDurationMs?: number;
  onOverlayBind?: (habitId: number, layer: OverlayLayer) => void;
  onOverlayVisualReady?: (habitId: number, layer: OverlayLayer) => void;
  onOverlayUnbind?: (habitId: number, layer: OverlayLayer) => void;
}
export function SectionFlightOverlay({
  flyingState,
  overlayStyle,
  separatorColor,
  surfaceBackgroundColor,
  layer = "over",
  yOffset = 0,
  clipTopY = null,
  clipBottomAnimDurationMs = 0,
  onOverlayBind,
  onOverlayVisualReady,
  onOverlayUnbind,
}: SectionFlightOverlayProps) {
  const onOverlayBindRef = useRef(onOverlayBind);
  const onOverlayVisualReadyRef = useRef(onOverlayVisualReady);
  const onOverlayUnbindRef = useRef(onOverlayUnbind);
  const yOffsetSv = useSharedValue(yOffset);
  const clipBottomSv = useSharedValue(0);
  const visualReadySignatureRef = useRef<string | null>(null);
  const bindSignature =
    flyingState == null
      ? null
      : `${flyingState.habitId}:${flyingState.from}:${flyingState.to}:${flyingState.sourceIndex}:${flyingState.targetIndex}`;
  const clipBottomY =
    flyingState?.to === "completed" ? flyingState.clipBottomY : null;
  const clipBottomYEnd =
    flyingState?.to === "completed"
      ? (flyingState.clipBottomYEnd ?? clipBottomY)
      : null;
  const clippedTopY = Math.max(0, clipTopY ?? 0);
  useEffect(() => {
    onOverlayBindRef.current = onOverlayBind;
  }, [onOverlayBind]);
  useEffect(() => {
    onOverlayUnbindRef.current = onOverlayUnbind;
  }, [onOverlayUnbind]);
  useEffect(() => {
    onOverlayVisualReadyRef.current = onOverlayVisualReady;
  }, [onOverlayVisualReady]);
  useEffect(() => {
    yOffsetSv.value = yOffset;
  }, [yOffset, yOffsetSv]);
  useEffect(() => {
    if (!flyingState || bindSignature == null) return;
    visualReadySignatureRef.current = null;
    const boundHabitId = flyingState.habitId;
    onOverlayBindRef.current?.(boundHabitId, layer);
    return () => {
      onOverlayUnbindRef.current?.(boundHabitId, layer);
    };
  }, [bindSignature, clippedTopY, flyingState, layer]);
  useEffect(() => {
    if (clipBottomY == null) {
      clipBottomSv.value = 0;
      return;
    }
    clipBottomSv.value = clipBottomY;
  }, [bindSignature, clipBottomY, clipBottomSv]);
  useEffect(() => {
    if (clipBottomY == null || clipBottomYEnd == null) return;
    if (Math.abs(clipBottomYEnd - clipBottomY) < 0.5) return;
    const durationMs = Math.max(0, clipBottomAnimDurationMs);
    if (durationMs <= 0) {
      clipBottomSv.value = clipBottomYEnd;
      return;
    }
    clipBottomSv.value = withTiming(clipBottomYEnd, {
      duration: durationMs,
      easing: Easing.linear,
    });
  }, [clipBottomAnimDurationMs, clipBottomSv, clipBottomY, clipBottomYEnd]);
  const top = (flyingState?.startY ?? 0) + yOffset - clippedTopY;
  const clippedStyle = useAnimatedStyle(() => ({
    height: Math.max(0, clipBottomSv.value + yOffsetSv.value - clippedTopY),
  }));
  if (!flyingState) return null;
  const isOverLayer = layer === "over";
  const rootStyle =
    clipBottomY == null
      ? [
          styles.overlayBase,
          { top: clippedTopY },
          isOverLayer ? styles.overlayOver : styles.overlayUnder,
        ]
      : [
          styles.overlayClippedBase,
          { top: clippedTopY },
          isOverLayer ? styles.overlayClippedOver : styles.overlayClippedUnder,
          clippedStyle,
        ];
  // Overlay row should always keep its own top separator visible.
  // For non-first rows, overlap the exact physical-pixel footprint used by
  // the source row. A hard-coded dp offset can rasterize on adjacent pixels
  // at fractional Android densities and briefly look like a double line.
  const showTopSeparator = true;
  const topSeparatorTop =
    flyingState.sourceIndex > 0 ? -SEPARATOR_RENDER_HEIGHT : 0;
  return (
    <Animated.View pointerEvents="none" style={rootStyle}>
      <Animated.View
        style={[
          styles.card,
          {
            left: flyingState.startX,
            top,
            width: flyingState.width > 0 ? flyingState.width : "100%",
            height: SLOT_HEIGHT,
            backgroundColor: surfaceBackgroundColor,
          },
          overlayStyle,
        ]}
        onLayout={() => {
          if (
            bindSignature != null &&
            visualReadySignatureRef.current !== bindSignature
          ) {
            visualReadySignatureRef.current = bindSignature;
            onOverlayVisualReadyRef.current?.(flyingState.habitId, layer);
          }
        }}
      >
        <View
          pointerEvents="none"
          style={[
            styles.rowTopSeparator,
            {
              backgroundColor: separatorColor,
              opacity: showTopSeparator ? 1 : 0,
              top: topSeparatorTop,
            },
          ]}
        />
        <HabitItem
          habitId={flyingState.habitId}
          habitName={flyingState.habitName}
          checkboxState={flyingState.checkboxState}
          currentStreak={flyingState.currentStreak}
          onCheckboxPress={() => false}
          onCheckboxLongPress={() => {}}
          onPress={() => {}}
          onLongPress={() => {}}
          // Keep visual parity with source row at flight start.
          // Active rows have a drag handle; completed rows do not.
          showDragHandle={flyingState.from === "active"}
          animateCheckboxTransitions={false}
        />
        <View
          pointerEvents="none"
          style={[
            styles.rowBottomSeparator,
            { backgroundColor: separatorColor },
          ]}
        />
      </Animated.View>
    </Animated.View>
  );
}
const styles = StyleSheet.create({
  overlayBase: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
  },
  overlayOver: {
    zIndex: FLIGHT_OVERLAY_Z,
    elevation: FLIGHT_OVERLAY_Z,
  },
  overlayUnder: {
    zIndex: 0,
    elevation: 0,
  },
  overlayClippedBase: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    overflow: "hidden",
  },
  overlayClippedOver: {
    zIndex: FLIGHT_OVERLAY_Z,
    elevation: FLIGHT_OVERLAY_Z,
  },
  overlayClippedUnder: {
    zIndex: 0,
    elevation: 0,
  },
  card: {
    position: "absolute",
    overflow: "visible",
  },
  rowTopSeparator: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: SEPARATOR_RENDER_HEIGHT,
  },
  rowBottomSeparator: {
    position: "absolute",
    left: 0,
    right: 0,
    top: SLOT_HEIGHT - SEPARATOR_RENDER_HEIGHT,
    height: SEPARATOR_RENDER_HEIGHT,
  },
});
