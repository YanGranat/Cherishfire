import { useCallback, useEffect, useRef } from "react";
import { PixelRatio } from "react-native";
import {
  cancelAnimation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { FLIGHT_DURATION_MS, FLIGHT_EASING } from "./constants";

const DEVICE_SCALE = PixelRatio.get();

export interface FlightConfig {
  habitId: number;
  startY: number;
  endY: number;
  startX: number;
  width: number;
  durationMs?: number;
}

export function useSectionFlight(onComplete: (habitId: number) => void) {
  const isFlying = useSharedValue(false);
  const progress = useSharedValue(0);
  const startY = useSharedValue(0);
  const endY = useSharedValue(0);
  const flyingHabitId = useSharedValue(-1);

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const pendingDurationMsRef = useRef(FLIGHT_DURATION_MS);
  const pendingHabitIdRef = useRef<number | null>(null);
  const hasLaunchedRef = useRef(false);
  const launchFallbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const handleFlightComplete = useCallback((habitId: number) => {
    onCompleteRef.current(habitId);
  }, []);

  const clearLaunchFallback = useCallback(() => {
    if (launchFallbackTimeoutRef.current == null) return;
    clearTimeout(launchFallbackTimeoutRef.current);
    launchFallbackTimeoutRef.current = null;
  }, []);

  const beginFlight = useCallback(
    (habitId: number) => {
      if (pendingHabitIdRef.current !== habitId) return;
      if (hasLaunchedRef.current) return;
      hasLaunchedRef.current = true;
      clearLaunchFallback();
      const durationMs = pendingDurationMsRef.current;
      progress.value = withTiming(
        1,
        { duration: durationMs, easing: FLIGHT_EASING },
        (finished) => {
          "worklet";
          if (finished) {
            isFlying.value = false;
            runOnJS(handleFlightComplete)(habitId);
          }
        }
      );
    },
    [clearLaunchFallback, handleFlightComplete, isFlying, progress]
  );

  const startFlight = useCallback(
    (config: FlightConfig) => {
      const requestedDurationMs = config.durationMs ?? FLIGHT_DURATION_MS;

      // Anti-phantom guard:
      // shared values must be prepared before JS mounts the overlay.
      // If this order is changed, Android can show one stale frame ("phantom flash")
      // at old coordinates.
      cancelAnimation(progress);
      isFlying.value = false;
      progress.value = 0;
      flyingHabitId.value = config.habitId;
      startY.value = config.startY;
      endY.value = config.endY;
      isFlying.value = true;
      pendingHabitIdRef.current = config.habitId;
      pendingDurationMsRef.current = Math.max(0, requestedDurationMs);
      hasLaunchedRef.current = false;

      // Safety net: if visual-ready callback is delayed/missed, start anyway.
      // Keep this timeout above typical mount latency so perceived speed
      // is not shortened by starting while overlay is still not visible.
      clearLaunchFallback();
      const launchFallbackMs = Math.max(900, requestedDurationMs);
      launchFallbackTimeoutRef.current = setTimeout(() => {
        beginFlight(config.habitId);
      }, launchFallbackMs);
    },
    [
      beginFlight,
      clearLaunchFallback,
      endY,
      flyingHabitId,
      isFlying,
      progress,
      startY,
    ]
  );

  useEffect(
    () => () => {
      clearLaunchFallback();
    },
    [clearLaunchFallback]
  );

  const overlayStyle = useAnimatedStyle(() => ({
    // Snap to the physical pixel grid (not integer dp) to avoid a tiny
    // "overshoot then snap back" at landing on high-density Android screens.
    // Integer-dp rounding can introduce up to ~1-2px mismatch.
    // Keep start/end geometry untouched; only the animated interpolation is snapped.
    // This keeps the final overlay position aligned with the real row position.
    transform: [
      {
        translateY:
          Math.round(
            interpolate(
              progress.value,
              [0, 1],
              [0, endY.value - startY.value]
            ) * DEVICE_SCALE
          ) / DEVICE_SCALE,
      },
    ],
    // Keep overlay fully visible for the whole flight.
    // Any fade-in at progress=0 can expose a one-frame gap (source hidden,
    // overlay still transparent), which is perceived as a row blink.
    opacity: 1,
  }));

  return {
    isFlying,
    flyingHabitId,
    progress,
    startFlight,
    beginFlight,
    overlayStyle,
  };
}
