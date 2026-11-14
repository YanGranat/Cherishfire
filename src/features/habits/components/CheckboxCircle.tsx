import React, { useEffect, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import type { GestureResponderEvent } from "react-native";
import Entypo from "@expo/vector-icons/Entypo";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import Animated, {
  cancelAnimation,
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  interpolateColor,
  Easing,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { sizes, durations } from "@/theme/tokens";
import {
  getAccentScheme,
  semantic,
  lightTheme,
  darkTheme,
} from "@/theme/colors";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { playHabitExecutionSound } from "@/utils/sound-effects";
import type { DayStatus } from "@/types/habit";
import { runAfterUiPaint } from "@/utils/ui-scheduling";
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const CHECKBOX_RING_WIDTH = 0.7;
const USES_JS_ANIMATION_RUNTIME = Platform.OS === "web";
type CheckboxState = DayStatus | "unmarked" | "unmarkedPast";
interface CheckboxCircleProps {
  state: CheckboxState;
  onPress: () => boolean;
  onLongPress?: (event: GestureResponderEvent) => void;
  disabled?: boolean;
  readOnly?: boolean;
  animateTransitions?: boolean;
  accessibilityLabel?: string;
  accessibilityValue?: string;
}
function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function darkenColor(color: string, amount: number): string {
  const factor = Math.max(0, 1 - amount);
  if (color.startsWith("#")) {
    const value = color.replace("#", "");
    const r = Math.round(parseInt(value.slice(0, 2), 16) * factor);
    const g = Math.round(parseInt(value.slice(2, 4), 16) * factor);
    const b = Math.round(parseInt(value.slice(4, 6), 16) * factor);
    const toHex = (n: number) => n.toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  return color;
}
function enhanceAccentColor(
  color: string,
  saturationBoost = 0.22,
  lightnessBoost = 0.06,
): string {
  if (!color.startsWith("#")) return color;
  const value = color.replace("#", "");
  let r = parseInt(value.slice(0, 2), 16) / 255;
  let g = parseInt(value.slice(2, 4), 16) / 255;
  let b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (delta !== 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = 60 * (((g - b) / delta) % 6);
        break;
      case g:
        h = 60 * ((b - r) / delta + 2);
        break;
      default:
        h = 60 * ((r - g) / delta + 4);
        break;
    }
  }
  if (h < 0) h += 360;
  s = Math.min(1, Math.max(0, s + saturationBoost));
  l = Math.min(1, Math.max(0, l + lightnessBoost));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rr = 0;
  let gg = 0;
  let bb = 0;
  if (h < 60) {
    rr = c;
    gg = x;
  } else if (h < 120) {
    rr = x;
    gg = c;
  } else if (h < 180) {
    gg = c;
    bb = x;
  } else if (h < 240) {
    gg = x;
    bb = c;
  } else if (h < 300) {
    rr = x;
    bb = c;
  } else {
    rr = c;
    bb = x;
  }
  r = rr + m;
  g = gg + m;
  b = bb + m;
  const toHex = (n: number) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
function getStateColors(
  state: CheckboxState,
  accent: {
    base: string;
    pale: string;
    bright: string;
  },
  neutralColor: string,
  unmarkedPastColor: string,
  minimumTone: {
    bg: string;
    icon: string;
  },
  stateFill: {
    minimum: string;
    maximum: string;
  },
  doneTone: {
    bg: string;
    icon: string;
  },
  maximumIconColor: string,
  failureTone: {
    bg: string;
    icon: string;
  },
) {
  let bgColor = "transparent";
  let iconName: string | null = null;
  let iconSize: number = sizes.checkboxIcon;
  let hasBorder = true;
  let iconType: "material" | "fontawesome6" | "ionicons" | "entypo" =
    "material";
  let iconColor = "#212121";
  switch (state) {
    case "unmarked":
      hasBorder = true;
      break;
    case "unmarkedPast":
      bgColor = unmarkedPastColor;
      iconName = "help-outline";
      break;
    case "done":
      bgColor = doneTone.bg;
      iconName = "check";
      iconSize = 17;
      iconColor = doneTone.icon;
      iconType = "fontawesome6";
      break;
    case "minimum":
      bgColor = minimumTone.bg;
      iconName = "check";
      iconSize = 16;
      iconColor = minimumTone.icon;
      break;
    case "maximum":
      bgColor = stateFill.maximum;
      iconName = "local-fire-department";
      iconSize = 17;
      iconColor = maximumIconColor || accent.bright;
      break;
    case "skipped":
      bgColor = neutralColor;
      iconName = "chevron-right";
      iconType = "entypo";
      break;
    case "failure":
      bgColor = failureTone.bg;
      iconName = "close-sharp";
      iconColor = failureTone.icon;
      iconType = "ionicons";
      break;
  }
  return { bgColor, iconName, iconSize, hasBorder, iconType, iconColor };
}
// The 28dp outer circle uses each state's icon and background.
// Includes animated color transition on state change.
export function CheckboxCircle(props: CheckboxCircleProps) {
  if (props.animateTransitions === false) {
    return <CheckboxCircleStatic {...props} />;
  }
  return <CheckboxCircleAnimated {...props} />;
}
function CheckboxCircleStatic({
  state,
  onPress,
  onLongPress,
  disabled = false,
  readOnly = false,
  accessibilityLabel,
  accessibilityValue,
}: CheckboxCircleProps) {
  const [readOnlyPressed, setReadOnlyPressed] = useState(false);
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const accent = getAccentScheme(colorScheme);
  const isDark = effectiveMode === "dark";
  const neutralColor = isDark ? darkTheme.neutral : lightTheme.neutral;
  const unmarkedPastColor = isDark
    ? darkTheme.unmarkedPast
    : lightTheme.unmarkedPast;
  const unmarkedBorderColor = isDark ? "#4A4A4A" : "#ECECEC";
  const markedBorderColor = isDark ? "#282828" : "transparent";
  const minimumTone = isDark
    ? { bg: "#272727", icon: "#9C9C9C" }
    : { bg: "#D9D9D9", icon: "#7A7A7A" };
  const stateFill = {
    minimum: isDark
      ? hexToRgba(accent.pale, 0.2)
      : hexToRgba(accent.pale, 0.14),
    maximum: isDark
      ? hexToRgba(accent.bright, 0.22)
      : hexToRgba(accent.bright, 0.16),
  };
  const doneIconColor =
    colorScheme === "blue"
      ? "#01AEFF"
      : enhanceAccentColor(accent.base, 0.24, 0.06);
  const doneBgColor = colorScheme === "blue" ? "#20396D" : accent.base;
  const doneTone = isDark
    ? {
        bg: colorScheme === "blue" ? doneBgColor : hexToRgba(doneBgColor, 0.22),
        icon: doneIconColor,
      }
    : {
        bg: colorScheme === "blue" ? doneBgColor : hexToRgba(doneBgColor, 0.18),
        icon: doneIconColor,
      };
  const maximumIconColor = doneIconColor;
  const failureTone = isDark
    ? { bg: "#4D1A23", icon: "#FF3558" }
    : { bg: hexToRgba(semantic.failure, 0.16), icon: semantic.failure };
  const { bgColor, iconName, iconSize, hasBorder, iconType, iconColor } =
    getStateColors(
      state,
      accent,
      neutralColor,
      unmarkedPastColor,
      minimumTone,
      stateFill,
      doneTone,
      maximumIconColor,
      failureTone,
    );
  const handlePress = (event: GestureResponderEvent) => {
    event.stopPropagation();
    const isUnmarked = state === "unmarked" || state === "unmarkedPast";
    if (disabled || readOnly) {
      return;
    }
    if (!onPress()) return;
    runAfterUiPaint(() => {
      if (useSettingsStore.getState().soundEnabled && isUnmarked) {
        void playHabitExecutionSound();
      }
      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
    });
  };
  const handleLongPress = (event: GestureResponderEvent) => {
    event.stopPropagation();
    if (disabled || readOnly) {
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onLongPress?.(event);
  };
  const circleElement = (
    <Pressable
      onPressIn={(event) => {
        event.stopPropagation();
        if (readOnly) setReadOnlyPressed(true);
      }}
      onPressOut={(event) => {
        event.stopPropagation();
        if (readOnly) setReadOnlyPressed(false);
      }}
      onPress={handlePress}
      onLongPress={handleLongPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: accessibilityValue }}
      accessibilityState={{
        checked: state === "done" || state === "minimum" || state === "maximum",
        disabled: disabled || readOnly,
      }}
      delayLongPress={180}
      style={{
        width: sizes.touchTargetMin,
        height: sizes.touchTargetMin,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <View
        style={{
          width: sizes.checkboxOuter,
          height: sizes.checkboxOuter,
          borderRadius: sizes.checkboxOuter / 2,
          borderWidth: hasBorder ? CHECKBOX_RING_WIDTH : 0,
          borderColor: hasBorder
            ? state === "unmarked"
              ? unmarkedBorderColor
              : iconName
                ? darkenColor(iconColor, 0.12)
                : markedBorderColor
            : "transparent",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          backgroundColor: bgColor,
        }}
      >
        {readOnlyPressed ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
              borderRadius: sizes.checkboxOuter / 2,
              backgroundColor: isDark ? "rgba(0,0,0,0.34)" : "rgba(0,0,0,0.2)",
            }}
          />
        ) : null}
        {iconName ? (
          <View>
            {iconType === "fontawesome6" ? (
              <FontAwesome6
                name={iconName as keyof typeof FontAwesome6.glyphMap}
                size={iconSize}
                color={iconColor}
              />
            ) : iconType === "ionicons" ? (
              <Ionicons
                name={iconName as keyof typeof Ionicons.glyphMap}
                size={iconSize}
                color={iconColor}
              />
            ) : iconType === "entypo" ? (
              <Entypo
                name={iconName as keyof typeof Entypo.glyphMap}
                size={iconSize}
                color={iconColor}
              />
            ) : (
              <MaterialIcons
                name={iconName as keyof typeof MaterialIcons.glyphMap}
                size={iconSize}
                color={iconColor}
              />
            )}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
  return circleElement;
}
function CheckboxCircleAnimated({
  state,
  onPress,
  onLongPress,
  disabled = false,
  readOnly = false,
  accessibilityLabel,
  accessibilityValue,
}: CheckboxCircleProps) {
  const animateTransitions = true;
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const accent = getAccentScheme(colorScheme);
  const isDark = effectiveMode === "dark";
  const neutralColor = isDark ? darkTheme.neutral : lightTheme.neutral;
  const unmarkedPastColor = isDark
    ? darkTheme.unmarkedPast
    : lightTheme.unmarkedPast;
  const unmarkedBorderColor = isDark ? "#4A4A4A" : "#ECECEC";
  const markedBorderColor = isDark ? "#282828" : "transparent";
  const minimumTone = isDark
    ? { bg: "#272727", icon: "#9C9C9C" }
    : { bg: "#D9D9D9", icon: "#7A7A7A" };
  const stateFill = {
    minimum: isDark
      ? hexToRgba(accent.pale, 0.2)
      : hexToRgba(accent.pale, 0.14),
    maximum: isDark
      ? hexToRgba(accent.bright, 0.22)
      : hexToRgba(accent.bright, 0.16),
  };
  const doneIconColor =
    colorScheme === "blue"
      ? "#01AEFF"
      : enhanceAccentColor(accent.base, 0.24, 0.06);
  const doneBgColor = colorScheme === "blue" ? "#20396D" : accent.base;
  const doneTone = isDark
    ? {
        bg: colorScheme === "blue" ? doneBgColor : hexToRgba(doneBgColor, 0.22),
        icon: doneIconColor,
      }
    : {
        bg: colorScheme === "blue" ? doneBgColor : hexToRgba(doneBgColor, 0.18),
        icon: doneIconColor,
      };
  const maximumIconColor = doneIconColor;
  const failureTone = isDark
    ? { bg: "#4D1A23", icon: "#FF3558" }
    : { bg: hexToRgba(semantic.failure, 0.16), icon: semantic.failure };
  const { bgColor, iconName, iconSize, hasBorder, iconType, iconColor } =
    getStateColors(
      state,
      accent,
      neutralColor,
      unmarkedPastColor,
      minimumTone,
      stateFill,
      doneTone,
      maximumIconColor,
      failureTone,
    );
  const colorProgress = useSharedValue(1);
  const pressOverlay = useSharedValue(0);
  const pressScale = useSharedValue(1);
  const prevBgColor = useSharedValue(bgColor);
  const currentBgColor = useSharedValue(bgColor);
  const isFirstRenderRef = useRef(true);
  const toneKeyRef = useRef<string>(
    `${state}|${bgColor}|${iconName ?? "none"}|${iconType}|${iconColor}`,
  );
  // Animate color transition when visual tone changes (state/accent/theme).
  useEffect(() => {
    const nextToneKey = `${state}|${bgColor}|${iconName ?? "none"}|${iconType}|${iconColor}`;
    const prevToneKey = toneKeyRef.current;
    const toneChanged = prevToneKey !== nextToneKey;
    if (!animateTransitions) {
      prevBgColor.value = bgColor;
      currentBgColor.value = bgColor;
      colorProgress.value = 1;
      isFirstRenderRef.current = false;
      toneKeyRef.current = nextToneKey;
      return;
    }
    if (isFirstRenderRef.current) {
      prevBgColor.value = bgColor;
      currentBgColor.value = bgColor;
      colorProgress.value = 1;
      isFirstRenderRef.current = false;
      toneKeyRef.current = nextToneKey;
      return;
    }
    if (!toneChanged) {
      return;
    }
    toneKeyRef.current = nextToneKey;
    prevBgColor.value = currentBgColor.value;
    currentBgColor.value = bgColor;
    colorProgress.value = 0;
    colorProgress.value = withTiming(1, {
      duration: durations.checkboxChange,
      easing: Easing.out(Easing.ease),
    });
  }, [
    animateTransitions,
    bgColor,
    colorProgress,
    currentBgColor,
    iconColor,
    iconName,
    iconType,
    prevBgColor,
    state,
  ]);
  const circleStyle = useAnimatedStyle(() => {
    // Native evaluates this updater once on JS before installing its UI mapper.
    if (!USES_JS_ANIMATION_RUNTIME && !global._WORKLET) {
      return { backgroundColor: bgColor };
    }
    const bg = interpolateColor(
      colorProgress.value,
      [0, 1],
      [prevBgColor.value, currentBgColor.value],
    );
    return {
      backgroundColor: bg,
    };
  });
  const circleStaticStyle = !animateTransitions
    ? {
        backgroundColor: bgColor,
      }
    : null;
  const pressOverlayStyle = useAnimatedStyle(() => {
    if (!USES_JS_ANIMATION_RUNTIME && !global._WORKLET) {
      return { opacity: 0 };
    }
    return { opacity: pressOverlay.value };
  });
  const pressScaleStyle = useAnimatedStyle(() => {
    if (!USES_JS_ANIMATION_RUNTIME && !global._WORKLET) {
      return { transform: [{ scale: 1 }] };
    }
    return { transform: [{ scale: pressScale.value }] };
  });
  const handlePress = (event: GestureResponderEvent) => {
    event.stopPropagation();
    const isUnmarked = state === "unmarked" || state === "unmarkedPast";
    if (disabled || readOnly) {
      return;
    }
    if (!onPress()) return;
    cancelAnimation(pressOverlay);
    cancelAnimation(pressScale);
    pressOverlay.value = withTiming(0, {
      duration: 180,
      easing: Easing.out(Easing.ease),
    });
    pressScale.value = withSequence(
      withTiming(0.95, { duration: 45, easing: Easing.out(Easing.ease) }),
      withTiming(1, { duration: 170, easing: Easing.out(Easing.ease) }),
    );
    pressOverlay.value = withTiming(0, {
      duration: 120,
      easing: Easing.out(Easing.ease),
    });
    runAfterUiPaint(() => {
      if (useSettingsStore.getState().soundEnabled && isUnmarked) {
        void playHabitExecutionSound();
      }
      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
    });
  };
  const handleLongPress = (event: GestureResponderEvent) => {
    event.stopPropagation();
    if (disabled || readOnly) {
      return;
    }
    cancelAnimation(pressOverlay);
    cancelAnimation(pressScale);
    pressOverlay.value = withTiming(0, {
      duration: 180,
      easing: Easing.out(Easing.ease),
    });
    pressScale.value = withTiming(1, {
      duration: 180,
      easing: Easing.out(Easing.ease),
    });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onLongPress?.(event);
  };
  const circleElement = (
    <AnimatedPressable
      onPressIn={(event) => {
        event.stopPropagation();
        cancelAnimation(pressOverlay);
        cancelAnimation(pressScale);
        pressOverlay.value = withTiming(1, {
          duration: 70,
          easing: Easing.out(Easing.ease),
        });
        pressScale.value = withTiming(0.93, {
          duration: 90,
          easing: Easing.out(Easing.ease),
        });
      }}
      onPressOut={(event) => {
        event.stopPropagation();
        pressOverlay.value = withTiming(0, {
          duration: 220,
          easing: Easing.out(Easing.ease),
        });
        pressScale.value = withTiming(1, {
          duration: 220,
          easing: Easing.out(Easing.ease),
        });
      }}
      onPress={handlePress}
      onLongPress={handleLongPress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: accessibilityValue }}
      accessibilityState={{
        checked: state === "done" || state === "minimum" || state === "maximum",
        disabled: disabled || readOnly,
      }}
      delayLongPress={180}
      style={[
        {
          width: sizes.touchTargetMin,
          height: sizes.touchTargetMin,
          alignItems: "center",
          justifyContent: "center",
        },
      ]}
    >
      <Animated.View
        style={[
          animateTransitions ? circleStyle : circleStaticStyle,
          pressScaleStyle,
          {
            width: sizes.checkboxOuter,
            height: sizes.checkboxOuter,
            borderRadius: sizes.checkboxOuter / 2,
            borderWidth: hasBorder ? CHECKBOX_RING_WIDTH : 0,
            borderColor: hasBorder
              ? state === "unmarked"
                ? unmarkedBorderColor
                : iconName
                  ? darkenColor(iconColor, 0.12)
                  : markedBorderColor
              : "transparent",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          },
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
              borderRadius: sizes.checkboxOuter / 2,
              backgroundColor: isDark ? "rgba(0,0,0,0.34)" : "rgba(0,0,0,0.2)",
            },
            pressOverlayStyle,
          ]}
        />
        {iconName ? (
          <View>
            {iconType === "fontawesome6" ? (
              <FontAwesome6
                name={iconName as keyof typeof FontAwesome6.glyphMap}
                size={iconSize}
                color={iconColor}
              />
            ) : iconType === "ionicons" ? (
              <Ionicons
                name={iconName as keyof typeof Ionicons.glyphMap}
                size={iconSize}
                color={iconColor}
              />
            ) : iconType === "entypo" ? (
              <Entypo
                name={iconName as keyof typeof Entypo.glyphMap}
                size={iconSize}
                color={iconColor}
              />
            ) : (
              <MaterialIcons
                name={iconName as keyof typeof MaterialIcons.glyphMap}
                size={iconSize}
                color={iconColor}
              />
            )}
          </View>
        ) : null}
      </Animated.View>
    </AnimatedPressable>
  );
  return circleElement;
}
