/** @jsxImportSource nativewind */
import React, { useLayoutEffect, useRef, useState } from "react";
import {
  GestureResponderEvent,
  LayoutChangeEvent,
  View,
  Text,
  Pressable,
  ScrollView,
  useWindowDimensions,
  StyleProp,
  TextStyle,
  ViewStyle,
  Keyboard,
  Platform,
  AccessibilityInfo,
} from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { borders, radii, sizes } from "@/theme/tokens";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import {
  scrimColor,
  getAccentScheme,
  lightTheme,
  darkTheme,
} from "@/theme/colors";
import { AppModal } from "@/components/ui/AppModal";
import { getDialogViewportHeight } from "./dialog-layout";
interface DialogAction {
  label: string;
  onPress: () => void;
  variant?: "default" | "destructive";
  role?: "cancel";
  tone?: "accent" | "muted";
  disabled?: boolean;
  buttonStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}
interface DialogTitleAction {
  icon: keyof typeof MaterialIcons.glyphMap;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: (event: GestureResponderEvent) => void;
  disabled?: boolean;
}
interface DialogProps {
  visible: boolean;
  title: string;
  message?: string;
  actions: DialogAction[];
  variant?: "standard" | "about";
  children?: React.ReactNode;
  contentBackgroundColor?: string;
  contentStyle?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
  actionsContainerStyle?: StyleProp<ViewStyle>;
  actionButtonStyle?: StyleProp<ViewStyle>;
  titleAction?: DialogTitleAction;
  titleAccessory?: React.ReactNode;
  onContentLayout?: (event: LayoutChangeEvent) => void;
  onAvailableHeightChange?: (height: number) => void;
  onDismiss?: () => void;
}
function readInitialKeyboardScreenY(): number | null {
  const screenY = Keyboard.metrics?.()?.screenY ?? null;
  return Platform.OS === "ios" && screenY === 0 ? null : screenY;
}
// Centered modal with window-bounded width and shared content padding.
export function Dialog({
  visible,
  title,
  message,
  actions,
  variant = "standard",
  children,
  contentBackgroundColor,
  contentStyle,
  titleStyle,
  actionsContainerStyle,
  actionButtonStyle,
  titleAction,
  titleAccessory,
  onContentLayout,
  onAvailableHeightChange,
  onDismiss,
}: DialogProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const rootRef = useRef<View>(null);
  const rootMeasurementRef = useRef(0);
  const visibleRef = useRef(visible);
  const [rootFrame, setRootFrame] = useState({ height: windowHeight, screenY: 0, windowHeight });
  const [keyboardScreenY, setKeyboardScreenY] = useState<number | null>(
    () => visible ? readInitialKeyboardScreenY() : null,
  );
  useLayoutEffect(() => {
    visibleRef.current = visible;
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const owner = { active: true, request: 0 };
    const updateScreenY = (screenY: number | null) => {
      if (!owner.active || !visibleRef.current) return;
      const request = ++owner.request;
      if (Platform.OS !== "ios" || screenY !== 0) {
        setKeyboardScreenY(screenY);
        return;
      }
      const commitPreference = (prefersCrossFade: boolean) => {
        if (!owner.active || !visibleRef.current || owner.request !== request) return;
        setKeyboardScreenY(prefersCrossFade ? null : screenY);
      };
      void AccessibilityInfo.prefersCrossFadeTransitions().then(
        commitPreference,
        () => commitPreference(false),
      );
    };
    const updateKeyboard = () => {
      updateScreenY(Keyboard.metrics?.()?.screenY ?? null);
    };
    updateKeyboard();
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow",
      (event) => {
        updateScreenY(event.endCoordinates.screenY);
      },
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => {
        updateScreenY(null);
      },
    );
    const terminalSubscriptions = Platform.OS === "ios" ? [
      Keyboard.addListener("keyboardDidShow", (event) => {
        updateScreenY(event.endCoordinates.screenY);
      }),
      Keyboard.addListener("keyboardDidHide", () => {
        updateScreenY(null);
      }),
    ] : [];
    return () => {
      owner.active = false;
      owner.request += 1;
      show.remove();
      hide.remove();
      terminalSubscriptions.forEach((subscription) => subscription.remove());
    };
  }, [visible]);
  const viewportHeight = getDialogViewportHeight(
    rootFrame.windowHeight === windowHeight ? rootFrame.height : windowHeight,
    rootFrame.windowHeight === windowHeight ? rootFrame.screenY : 0,
    keyboardScreenY,
  );
  const availableCardHeight = Math.max(0, viewportHeight - 48);
  useLayoutEffect(() => {
    if (visible) onAvailableHeightChange?.(availableCardHeight);
  }, [availableCardHeight, onAvailableHeightChange, visible]);
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  const accent = getAccentScheme(colorScheme).base;
  const resolvedContentBackgroundColor =
    contentBackgroundColor ??
    (isDarkTheme ? palette.menuSurface : palette.surfaceElevated);
  const cancelAction =
    actions.find((action) => action.role === "cancel") ?? null;
  const isAboutVariant = variant === "about";
  return (
    <AppModal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onDismiss={() => {
        if (!visibleRef.current) {
          rootMeasurementRef.current += 1;
          setRootFrame({ height: windowHeight, screenY: 0, windowHeight });
          setKeyboardScreenY(readInitialKeyboardScreenY());
        }
        onDismiss?.();
      }}
      onRequestClose={() => {
        if (!cancelAction || cancelAction.disabled) return false;
        cancelAction.onPress();
        return true;
      }}
    >
      <Pressable
        ref={rootRef}
        onLayout={() => {
          const root = rootRef.current;
          const measurement = ++rootMeasurementRef.current;
          root?.measureInWindow((_x, screenY, _width, height) => {
            if (!visibleRef.current || rootRef.current !== root || measurement !== rootMeasurementRef.current ||
              !Number.isFinite(height) || height <= 0 || !Number.isFinite(screenY)) return;
            setRootFrame((current) =>
              current.height === height && current.screenY === screenY && current.windowHeight === windowHeight
                ? current
                : { height, screenY, windowHeight },
            );
          });
        }}
        className="flex-1"
        style={{ backgroundColor: scrimColor }}
        onPress={() => {
          if (!cancelAction || cancelAction.disabled) {
            return;
          }
          cancelAction.onPress();
        }}
      >
        <View
          pointerEvents="box-none"
          style={{ height: viewportHeight, alignItems: "center", justifyContent: "center" }}
        >
        <Pressable
          onLayout={onContentLayout}
          onPress={(event) => {
            event.stopPropagation();
          }}
          style={[
            {
              width: Math.min(sizes.dialogWidth, windowWidth - 32),
              maxHeight: availableCardHeight,
              paddingHorizontal: sizes.dialogPadding,
              paddingTop: sizes.dialogPadding,
              paddingBottom: isAboutVariant ? sizes.dialogPadding : 12,
              borderRadius: radii.dialog,
              backgroundColor: resolvedContentBackgroundColor,
              borderWidth: borders.hairline,
              borderColor: palette.border,
              shadowColor: "#000",
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.2,
              shadowRadius: 24,
              elevation: 8,
            },
            contentStyle,
          ]}
        >
          <ScrollView
            style={{ flexShrink: 1 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View
              style={[
                titleAction ? { position: "relative" } : null,
                titleAccessory
                  ? {
                      flexDirection: "row",
                      alignItems: "center",
                      marginBottom: 12,
                    }
                  : null,
              ]}
            >
              <Text
                className="text-lg font-semibold mb-sm"
                style={[
                  { color: palette.primary },
                  isAboutVariant
                    ? null
                    : { fontSize: 19, lineHeight: 25, marginBottom: 12 },
                  titleAccessory ? { flex: 1, marginBottom: 0 } : null,
                  titleAction ? { paddingRight: 36 } : null,
                  titleStyle,
                ]}
              >
                {title}
              </Text>
              {titleAccessory ? (
                <View style={{ marginLeft: 12 }}>{titleAccessory}</View>
              ) : null}
              {titleAction ? (
                <Pressable
                  onPress={
                    titleAction.disabled
                      ? undefined
                      : (event) => {
                          titleAction.onPress(event);
                        }
                  }
                  disabled={titleAction.disabled}
                  accessibilityRole="button"
                  accessibilityLabel={titleAction.accessibilityLabel}
                  accessibilityHint={titleAction.accessibilityHint}
                  accessibilityState={{ disabled: titleAction.disabled }}
                  className="active:opacity-60"
                  style={{
                    position: "absolute",
                    top: -10,
                    right: -10,
                    width: sizes.touchTargetMin,
                    height: sizes.touchTargetMin,
                    alignItems: "center",
                    justifyContent: "center",
                    opacity: titleAction.disabled ? 0.45 : undefined,
                  }}
                >
                  <MaterialIcons
                    name={titleAction.icon}
                    size={24}
                    color={palette.icon}
                  />
                </Pressable>
              ) : null}
            </View>

            {message ? (
              <Text className="text-sm mb-lg" style={{ color: palette.muted }}>
                {message}
              </Text>
            ) : null}

            {children}
          </ScrollView>

          <View
            className="flex-row justify-end gap-sm mt-lg"
            style={[
              isAboutVariant ? null : { marginTop: 22 },
              { flexWrap: "wrap" },
              actionsContainerStyle,
            ]}
          >
            {actions.map((action, i) => (
              <Pressable
                key={i}
                onPress={
                  action.disabled
                    ? undefined
                    : () => {
                        action.onPress();
                      }
                }
                disabled={action.disabled}
                accessibilityRole="button"
                accessibilityState={{ disabled: action.disabled }}
                className={
                  isAboutVariant
                    ? "min-h-[44px] px-md items-center justify-center active:opacity-60"
                    : "min-h-[46px] px-[14px] items-center justify-center active:opacity-60"
                }
                style={[
                  { maxWidth: "100%" },
                  actionButtonStyle,
                  action.buttonStyle,
                  action.disabled ? { opacity: 0.45 } : null,
                ]}
              >
                <Text
                  className="text-sm"
                  style={[
                    isAboutVariant
                      ? { fontWeight: "600" }
                      : {
                          fontSize: 14.5,
                          lineHeight: 20,
                          fontWeight: "500",
                        },
                    {
                      color:
                        action.variant === "destructive"
                          ? "#EF4444"
                          : action.tone === "accent"
                            ? accent
                            : action.tone === "muted" ||
                                action.role === "cancel"
                              ? palette.muted
                              : i === actions.length - 1
                                ? accent
                                : palette.muted,
                    },
                    action.textStyle,
                  ]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
        </View>
      </Pressable>
    </AppModal>
  );
}
