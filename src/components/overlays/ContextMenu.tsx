/** @jsxImportSource nativewind */
import React, { useLayoutEffect, useState } from "react";
import {
  View,
  Text,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { sizes, radii } from "@/theme/tokens";
import { scrimColor, lightTheme, darkTheme } from "@/theme/colors";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import type { MenuItem } from "./DropdownMenu";
import { AppModal } from "@/components/ui/AppModal";
import { Icon } from "@/components/ui/Icon";
interface ContextMenuProps {
  visible: boolean;
  onClose: () => void;
  items: MenuItem[];
  // Position near the pressed element
  x: number;
  y: number;
}
// Same card style as DropdownMenu, triggered by long press at position.
// Width is bounded by the shared context-menu token and safe-area margins.
const MENU_OPEN_MS = 115;
const MENU_CLOSE_MS = 85;
const SCRIM_OPEN_MS = 75;
const SCRIM_CLOSE_MS = 65;
const START_SCALE = 0.92;
const START_TRANSLATE_Y = 8;
const LAST_ITEM_BOTTOM_INSET = 2;
export function ContextMenu({
  visible,
  onClose,
  items,
  x,
  y,
}: ContextMenuProps) {
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  const menuDividerColor = isDarkTheme ? "#3A3A3A" : "#E0E0E0";
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const menuHeight = items.length * sizes.menuItemHeight;
  const screenMargin = 12;
  const menuWidth = Math.min(
    sizes.menuWidthContext,
    Math.max(1, windowWidth - insets.left - insets.right - screenMargin * 2),
  );
  const minX = insets.left + screenMargin;
  const maxX = Math.max(
    minX,
    windowWidth - insets.right - menuWidth - screenMargin,
  );
  const minY = insets.top + screenMargin;
  const maxY = Math.max(
    minY,
    windowHeight - insets.bottom - menuHeight - screenMargin,
  );
  const resolvedX = Math.min(Math.max(minX, x - 24), maxX);
  const resolvedY = Math.min(Math.max(minY, y - 24), maxY);
  const [isMounted, setIsMounted] = useState(visible);
  const [isClosing, setIsClosing] = useState(false);
  const usesIOSNativeHost = Platform.OS === "ios";
  const [nativeDismissPending, setNativeDismissPending] = useState(false);
  const nativeDismissPendingRef = React.useRef(false);
  const nativeDismissGenerationRef = React.useRef<number | null>(null);
  const closeStartedRef = React.useRef(false);
  const processedProductVisibilityRef = React.useRef<boolean | null>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const transitionGenerationRef = React.useRef(visible ? 1 : 0);
  const shouldMount = visible || isMounted;
  const menuProgress = useSharedValue(visible ? 1 : 0);
  const scrimProgress = useSharedValue(visible ? 1 : 0);
  const pendingItemActivationRef = React.useRef<{
    generation: number;
    onPress: () => void;
  } | null>(null);
  const finalizeClose = React.useCallback((generation: number) => {
    if (transitionGenerationRef.current !== generation) return;
    nativeDismissPendingRef.current = false;
    nativeDismissGenerationRef.current = null;
    setNativeDismissPending(false);
    closeStartedRef.current = false;
    setIsClosing(false);
    setIsMounted(false);
    const pendingActivation = pendingItemActivationRef.current;
    if (pendingActivation?.generation === generation) {
      pendingItemActivationRef.current = null;
    }
    if (pendingActivation?.generation === generation) {
      try {
        pendingActivation.onPress();
      } finally {
        onCloseRef.current();
      }
    }
  }, []);
  const finishClose = React.useCallback(
    (generation: number) => {
      if (transitionGenerationRef.current !== generation) return;
      closeStartedRef.current = false;
      if (usesIOSNativeHost) {
        nativeDismissPendingRef.current = true;
        nativeDismissGenerationRef.current = generation;
        setNativeDismissPending(true);
        return;
      }
      finalizeClose(generation);
    },
    [finalizeClose, usesIOSNativeHost],
  );
  const finishNativeDismiss = React.useCallback(() => {
    const generation = nativeDismissGenerationRef.current;
    if (generation == null) return;
    finalizeClose(generation);
  }, [finalizeClose]);
  useLayoutEffect(
    () => () => {
      transitionGenerationRef.current += 1;
      closeStartedRef.current = false;
      nativeDismissPendingRef.current = false;
      nativeDismissGenerationRef.current = null;
      cancelAnimation(menuProgress);
      cancelAnimation(scrimProgress);
      pendingItemActivationRef.current = null;
    },
    [menuProgress, scrimProgress],
  );
  const beginClose = React.useCallback(() => {
    if (closeStartedRef.current) {
      return false;
    }
    closeStartedRef.current = true;
    setIsClosing(true);
    const generation = transitionGenerationRef.current + 1;
    transitionGenerationRef.current = generation;
    menuProgress.value = withTiming(
      0,
      {
        duration: MENU_CLOSE_MS,
        easing: Easing.in(Easing.quad),
      },
      (finished) => {
        "worklet";
        if (finished) {
          runOnJS(finishClose)(generation);
        }
      },
    );
    scrimProgress.value = withTiming(0, {
      duration: SCRIM_CLOSE_MS,
      easing: Easing.in(Easing.quad),
    });
    return true;
  }, [finishClose, menuProgress, scrimProgress]);
  useLayoutEffect(() => {
    if (processedProductVisibilityRef.current === visible) return;
    processedProductVisibilityRef.current = visible;
    if (visible) {
      const isReversingNativeDismiss = nativeDismissPendingRef.current;
      if (isReversingNativeDismiss) {
        nativeDismissPendingRef.current = false;
        nativeDismissGenerationRef.current = null;
        setNativeDismissPending(false);
      }
      const isReversingClose =
        closeStartedRef.current || isReversingNativeDismiss;
      closeStartedRef.current = false;
      setIsClosing(false);
      pendingItemActivationRef.current = null;
      setIsMounted(true);
      const generation = transitionGenerationRef.current + 1;
      transitionGenerationRef.current = generation;
      // Preserve the visible in-flight progress when an immediate reopen
      // reverses a close. Resetting to zero would flash a hidden menu first.
      if (!isReversingClose) {
        menuProgress.value = 0;
        scrimProgress.value = 0;
      }
      const openingAnimationConfig = {
        duration: MENU_OPEN_MS,
        easing: Easing.out(Easing.cubic),
      };
      {
        menuProgress.value = withTiming(1, openingAnimationConfig);
      }
      scrimProgress.value = withTiming(1, {
        duration: SCRIM_OPEN_MS,
        easing: Easing.out(Easing.quad),
      });
      return;
    }
    if (!shouldMount) return;
    beginClose();
  }, [beginClose, menuProgress, scrimProgress, shouldMount, visible]);
  const animatedScrimStyle = useAnimatedStyle(() => ({
    opacity: scrimProgress.value * 0.16,
  }));
  const animatedMenuStyle = useAnimatedStyle(() => ({
    opacity: menuProgress.value,
    transform: [
      { scale: START_SCALE + (1 - START_SCALE) * menuProgress.value },
      { translateY: START_TRANSLATE_Y * (1 - menuProgress.value) },
    ],
  }));
  if (!shouldMount) return null;
  return (
    <AppModal
      transparent
      visible={shouldMount && !nativeDismissPending}
      animationType="none"
      statusBarTranslucent
      onDismiss={usesIOSNativeHost ? finishNativeDismiss : undefined}
      onRequestClose={() => {
        if (!beginClose()) return true;
        onClose();
        return true;
      }}
    >
      <View
        className="flex-1"
        // Block both stale menu actions and touch-through to the underlying
        // screen for the complete custom close animation.
        pointerEvents={visible && !isClosing ? "auto" : "box-only"}
        accessibilityElementsHidden={!visible || isClosing}
        importantForAccessibility={
          visible && !isClosing ? "yes" : "no-hide-descendants"
        }
        style={{ backgroundColor: "transparent" }}
      >
        <Pressable
          style={StyleSheet.absoluteFillObject}
          onPress={() => {
            if (!beginClose()) return;
            onClose();
          }}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFillObject,
              { backgroundColor: scrimColor },
              animatedScrimStyle,
            ]}
          />
        </Pressable>

        <Animated.View
          accessibilityRole="menu"
          style={[
            animatedMenuStyle,
            {
              position: "absolute",
              left: resolvedX,
              top: resolvedY,
              width: menuWidth,
              backgroundColor: palette.menuSurface,
              borderRadius: radii.menu,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.15,
              shadowRadius: 12,
              elevation: 4,
            },
          ]}
        >
          {items.map((item, i) => {
            const itemTextColor = item.disabled
              ? palette.disabled
              : item.destructive
                ? "#EF4444"
                : palette.primary;
            const itemIconColor = item.disabled
              ? palette.disabled
              : item.destructive
                ? "#EF4444"
                : palette.icon;
            const isFirst = i === 0;
            const isLast = i === items.length - 1;
            return (
              <Pressable
                key={i}
                onPress={
                  item.disabled
                    ? undefined
                    : () => {
                        if (!beginClose()) return;
                        if (item.deferUntilClosed) {
                          pendingItemActivationRef.current = {
                            generation: transitionGenerationRef.current,
                            onPress: item.onPress,
                          };
                          return;
                        }
                        item.onPress();
                        onClose();
                      }
                }
                disabled={item.disabled}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityHint={item.accessibilityHint}
                accessibilityState={{ disabled: item.disabled }}
                className="flex-row items-center px-base active:bg-press-highlight"
                style={{
                  height: sizes.menuItemHeight,
                  borderTopLeftRadius: isFirst ? radii.menu : 0,
                  borderTopRightRadius: isFirst ? radii.menu : 0,
                  borderBottomLeftRadius: isLast ? radii.menu : 0,
                  borderBottomRightRadius: isLast ? radii.menu : 0,
                  borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
                  borderBottomColor: menuDividerColor,
                  paddingBottom: isLast ? LAST_ITEM_BOTTOM_INSET : 0,
                }}
              >
                <View
                  style={{
                    width: sizes.menuItemIcon - 2,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {item.icon === "navigate-next" ? (
                    <View
                      style={[
                        styles.thinChevron,
                        { borderColor: itemIconColor },
                      ]}
                    />
                  ) : (
                    <Icon
                      name={item.icon}
                      family={item.iconFamily}
                      size={sizes.menuItemIcon - 2}
                      color={itemIconColor}
                      style={{ marginTop: 2 }}
                    />
                  )}
                </View>
                <Text
                  className="ml-sm flex-1"
                  style={{ color: itemTextColor, fontSize: 14, minWidth: 0 }}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </Animated.View>
      </View>
    </AppModal>
  );
}
const styles = StyleSheet.create({
  thinChevron: {
    width: 10,
    height: 10,
    left: -3.5,
    borderRightWidth: 1.75,
    borderBottomWidth: 1.75,
    transform: [{ rotate: "-45deg" }],
  },
});
