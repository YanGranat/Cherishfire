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
import type MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type Ionicons from "@expo/vector-icons/Ionicons";
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
import { AppModal } from "@/components/ui/AppModal";
import { Icon } from "@/components/ui/Icon";
export interface MenuItem {
  label: string;
  icon: keyof typeof MaterialIcons.glyphMap | keyof typeof Ionicons.glyphMap;
  iconFamily?: "material" | "ionicons";
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  /** Run the command only after the menu card has fully disappeared. */
  deferUntilClosed?: boolean;
}
interface DropdownMenuProps {
  visible: boolean;
  /** Pre-attach only the Android portal host during idle time. */
  preloadOnAndroid?: boolean;
  onClose: () => void;
  items: MenuItem[];
  anchorRight?: number;
  anchorTop?: number;
  menuWidth?: number;
}
const MENU_OPEN_MS = 115;
const MENU_CLOSE_MS = 85;
const SCRIM_OPEN_MS = 75;
const SCRIM_CLOSE_MS = 65;
const MENU_START_SCALE = 0.6;
const LAST_ITEM_BOTTOM_INSET = 2;
const SCREEN_MARGIN = 12;
// Floating card anchored to trigger icon. Scrim closes menu.
// Width, item height and corner radius use the shared menu tokens.
export function DropdownMenu({
  visible,
  preloadOnAndroid = false,
  onClose,
  items,
  anchorRight = 16,
  anchorTop = 56,
  menuWidth = sizes.menuWidthDropdown,
}: DropdownMenuProps) {
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  const menuDividerColor = isDarkTheme ? "#3A3A3A" : "#E0E0E0";
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const resolvedMenuWidth = Math.min(
    menuWidth,
    Math.max(1, windowWidth - insets.left - insets.right - SCREEN_MARGIN * 2),
  );
  const menuHeight = items.length * sizes.menuItemHeight;
  const minRight = insets.right + SCREEN_MARGIN;
  const maxRight = Math.max(
    minRight,
    windowWidth - insets.left - SCREEN_MARGIN - resolvedMenuWidth,
  );
  const resolvedRight = Math.min(Math.max(anchorRight, minRight), maxRight);
  const minTop = insets.top + SCREEN_MARGIN;
  const maxTop = Math.max(
    minTop,
    windowHeight - insets.bottom - SCREEN_MARGIN - menuHeight,
  );
  const resolvedTop = Math.min(Math.max(anchorTop, minTop), maxTop);
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
  const retainHiddenAndroidHost = Platform.OS === "android" && preloadOnAndroid;
  const shouldRender = shouldMount || retainHiddenAndroidHost;
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
        // The product command may synchronously throw, navigate or open a new
        // overlay. The old parent-owned visibility must still be retired so it
        // cannot leave an invisible full-screen blocker behind.
        onCloseRef.current();
      }
    }
  }, []);
  const finishClose = React.useCallback(
    (generation: number) => {
      if (transitionGenerationRef.current !== generation) return;
      closeStartedRef.current = false;
      if (usesIOSNativeHost) {
        // UIKit dismisses one native Modal asynchronously. Keep this exact menu
        // instance alive and do not mount the next dialog until AppModal reports
        // the real native onDismiss; otherwise two different controllers race.
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
      // A new opening starts hidden. A close -> open reversal must instead
      // continue from the currently rendered progress; resetting to zero here
      // would produce one fully hidden, semantically wrong frame.
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
  const animatedMenuStyle = useAnimatedStyle(() => {
    const scale =
      MENU_START_SCALE + (1 - MENU_START_SCALE) * menuProgress.value;
    return {
      opacity: menuProgress.value,
      transform: [{ scale }],
    };
  });
  if (!shouldRender) return null;
  return (
    <AppModal
      transparent
      visible={shouldMount && !nativeDismissPending}
      keepMountedOnAndroid={retainHiddenAndroidHost}
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
        // The card and scrim stop accepting actions as soon as close starts,
        // while the full-screen host remains the sole hit target until the
        // tuned close animation has actually unmounted it.
        pointerEvents={visible && !isClosing ? "auto" : "box-only"}
        accessibilityElementsHidden={!visible || isClosing}
        importantForAccessibility={
          visible && !isClosing ? "yes" : "no-hide-descendants"
        }
        style={{ backgroundColor: "transparent" }}
      >
        {/* Scrim - tap closes menu */}
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

        {/* Menu card */}
        <Animated.View
          accessibilityRole="menu"
          style={[
            animatedMenuStyle,
            {
              position: "absolute",
              right: resolvedRight,
              top: resolvedTop,
              width: resolvedMenuWidth,
              transformOrigin: ["100%", "0%", 0],
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
                        onClose();
                        item.onPress();
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
                  <Icon
                    name={item.icon}
                    family={item.iconFamily}
                    size={sizes.menuItemIcon - 2}
                    color={itemIconColor}
                    style={{ marginTop: 2 }}
                  />
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
