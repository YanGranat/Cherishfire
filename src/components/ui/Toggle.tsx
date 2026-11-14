import React from "react";
import { Animated, Easing, Switch } from "react-native";
import { getAccentScheme } from "@/theme/colors";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import {
  DARK_TOGGLE_OFF_THUMB_COLOR,
  getToggleThumbColor,
  LIGHT_TOGGLE_OFF_THUMB_COLOR,
  TOGGLE_THUMB_ANIMATION_DURATION_MS,
} from "@/components/ui/toggle-thumb-color";
interface ToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}
// The track is accent-colored when enabled and gray when disabled.
export function Toggle({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
}: ToggleProps) {
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const accent = getAccentScheme(colorScheme).base;
  const offTrackColor = isDarkTheme ? "#616161" : "#9E9E9E";
  const offThumbColor = isDarkTheme
    ? DARK_TOGGLE_OFF_THUMB_COLOR
    : LIGHT_TOGGLE_OFF_THUMB_COLOR;
  const thumbProgress = React.useRef(new Animated.Value(value ? 1 : 0)).current;
  const thumbProgressRef = React.useRef(value ? 1 : 0);
  const thumbAnimationRef = React.useRef<Animated.CompositeAnimation | null>(
    null,
  );
  const [displayedThumbProgress, setDisplayedThumbProgress] = React.useState(
    value ? 1 : 0,
  );
  const thumbColor = getToggleThumbColor(offThumbColor, displayedThumbProgress);
  React.useEffect(() => {
    const listenerId = thumbProgress.addListener(({ value: progress }) => {
      thumbProgressRef.current = progress;
      setDisplayedThumbProgress(progress);
    });
    return () => thumbProgress.removeListener(listenerId);
  }, [thumbProgress]);
  React.useLayoutEffect(() => {
    const target = value ? 1 : 0;
    thumbAnimationRef.current?.stop();
    if (Math.abs(thumbProgressRef.current - target) < 0.001) {
      thumbProgress.setValue(target);
      setDisplayedThumbProgress(target);
      return;
    }
    const animation = Animated.timing(thumbProgress, {
      toValue: target,
      duration: TOGGLE_THUMB_ANIMATION_DURATION_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    });
    thumbAnimationRef.current = animation;
    animation.start(({ finished }) => {
      if (!finished || thumbAnimationRef.current !== animation) {
        return;
      }
      thumbProgressRef.current = target;
      setDisplayedThumbProgress(target);
      thumbAnimationRef.current = null;
    });
    return () => animation.stop();
  }, [thumbProgress, value]);
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      trackColor={{ false: offTrackColor, true: accent }}
      ios_backgroundColor={offTrackColor}
      thumbColor={thumbColor}
    />
  );
}
