import React from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { darkTheme, lightTheme } from "@/theme/colors";
import { radii, spacing } from "@/theme/tokens";
interface InlineErrorBannerProps {
  message: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  onDismiss?: () => void;
  dismissAccessibilityLabel?: string;
  containerStyle?: StyleProp<ViewStyle>;
}
export function InlineErrorBanner({
  message,
  onPress,
  accessibilityLabel,
  onDismiss,
  dismissAccessibilityLabel,
  containerStyle,
}: InlineErrorBannerProps) {
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const palette = isDark ? darkTheme : lightTheme;
  const content = (
    <>
      <MaterialIcons name="error-outline" size={20} color={palette.muted} />
      <Text style={[styles.message, { color: palette.muted }]}>{message}</Text>
      {onDismiss ? (
        <Pressable
          onPress={() => {
            onDismiss();
          }}
          accessibilityRole="button"
          accessibilityLabel={dismissAccessibilityLabel}
          style={styles.dismissButton}
        >
          <MaterialIcons name="close" size={19} color={palette.muted} />
        </Pressable>
      ) : null}
    </>
  );
  const sharedStyle: StyleProp<ViewStyle> = [
    styles.container,
    {
      borderColor: palette.divider,
      paddingRight: onDismiss ? 0 : spacing.md,
    },
    containerStyle,
  ];
  if (onPress) {
    return (
      <Pressable
        onPress={() => {
          onPress();
        }}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? message}
        style={sharedStyle}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={sharedStyle}
    >
      {content}
    </View>
  );
}
const styles = StyleSheet.create({
  container: {
    minHeight: 44,
    marginHorizontal: 14,
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: radii.listCard,
    paddingLeft: spacing.md,
  },
  message: {
    flex: 1,
    marginLeft: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: 14,
    lineHeight: 20,
  },
  dismissButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
