/** @jsxImportSource nativewind */
import React from "react";
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
  onDismiss?: () => void;
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
  onDismiss,
}: DialogProps) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
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
      onDismiss={onDismiss}
      onRequestClose={() => {
        if (!cancelAction || cancelAction.disabled) return false;
        cancelAction.onPress();
        return true;
      }}
    >
      <Pressable
        className="flex-1 items-center justify-center"
        style={{ backgroundColor: scrimColor }}
        onPress={() => {
          if (!cancelAction || cancelAction.disabled) {
            return;
          }
          cancelAction.onPress();
        }}
      >
        <Pressable
          onLayout={onContentLayout}
          onPress={(event) => {
            event.stopPropagation();
          }}
          style={[
            {
              width: Math.min(sizes.dialogWidth, windowWidth - 32),
              maxHeight: windowHeight - 48,
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
      </Pressable>
    </AppModal>
  );
}
