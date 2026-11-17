import React, { useEffect, useSyncExternalStore } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/Icon";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { reminderPermissionStatus } from "@/composition/reminders";
import { darkTheme, lightTheme } from "@/theme/colors";
import { sizes, spacing, typography } from "@/theme/tokens";

const noSubscription = () => () => undefined;

export function ReminderPermissionNotice({
  observePermission,
}: {
  observePermission: boolean;
}) {
  const { t } = useTranslation();
  const isDark = useVisualEffectiveMode() === "dark";
  const palette = isDark ? darkTheme : lightTheme;
  const status = useSyncExternalStore(
    observePermission ? reminderPermissionStatus.subscribe : noSubscription,
    reminderPermissionStatus.getSnapshot,
    reminderPermissionStatus.getSnapshot,
  );

  useEffect(() => {
    if (!observePermission) return;
    void reminderPermissionStatus.refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void reminderPermissionStatus.refresh();
    });
    return () => subscription.remove();
  }, [observePermission]);

  if (status !== "denied" && status !== "error") return null;
  const message = t(
    status === "denied"
      ? "reminderScreen.permissionBlocked"
      : "reminderScreen.permissionUnavailable",
  );
  const action = t("reminderScreen.openSystemSettings");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${message} ${action}`}
      disabled={!observePermission}
      onPress={() => { void reminderPermissionStatus.openSystemSettings(); }}
      style={({ pressed }) => [styles.container, { opacity: pressed ? 0.6 : 1 }]}
    >
      <View style={styles.content}>
        <Text style={[styles.message, { color: palette.muted }]}>{message}</Text>
        <Text style={[styles.action, { color: palette.primary }]}>{action}</Text>
      </View>
      <Icon name="chevron-right" size={20} variant="muted" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: sizes.touchTargetMin,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  content: { flex: 1 },
  message: {
    fontSize: typography.bodySmall.size,
    lineHeight: typography.bodySmall.size * typography.bodySmall.lineHeight,
  },
  action: {
    marginTop: spacing.xs,
    fontSize: typography.button.size,
    fontWeight: typography.button.weight,
  },
});
