/** @jsxImportSource nativewind */
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/Icon";
import { Toggle } from "@/components/ui/Toggle";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useVisualColorScheme,
  useVisualLanguage,
  useVisualTheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { getLanguageNativeLabel } from "@/i18n/languages";
import { darkTheme, isCustomColorScheme, lightTheme } from "@/theme/colors";
import { SettingsErrorBanner } from "@/features/settings/components/SettingsErrorBanner";
import { SettingsScreenShell } from "@/features/settings/components/SettingsScreenShell";
import { FocusedRouteModuleWarmup } from "@/components/FocusedRouteModuleWarmup";
import { useNavigationIntentGate } from "@/hooks/useNavigationIntentGate";
const SETTINGS_ROUTE_MODULE_WARMUPS = [
  { route: "/settings/theme", load: () => import("./theme") },
  { route: "/settings/color-scheme", load: () => import("./color-scheme") },
  { route: "/settings/language", load: () => import("./language") },
] as const;
// Settings rows expose either a destination value or an inline toggle.
// Clean list layout with compact leading icons on key settings rows.
const SETTINGS_ROW_HEIGHT = 56;
const styles = StyleSheet.create({
  multilineRow: {
    minHeight: 68,
    paddingVertical: 8,
  },
  skipReasonIconSlot: {
    width: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  skipReasonChevron: {
    width: 10,
    height: 10,
    left: -3.5,
    borderRightWidth: 1.75,
    borderBottomWidth: 1.75,
    transform: [{ rotate: "-45deg" }],
  },
  standardRow: {
    minHeight: SETTINGS_ROW_HEIGHT,
  },
});
function SettingsNavigationRows() {
  const router = useRouter();
  const { t } = useTranslation();
  const theme = useVisualTheme();
  const colorScheme = useVisualColorScheme();
  const language = useVisualLanguage();
  const runNavigationIntent = useNavigationIntentGate();
  const themeLabel =
    theme === "system"
      ? t("themeScreen.system")
      : theme === "dark"
        ? t("themeScreen.dark")
        : t("themeScreen.light");
  const colorLabel = isCustomColorScheme(colorScheme)
    ? colorScheme
    : t(`colorSchemeScreen.${colorScheme}`);
  const langLabel = getLanguageNativeLabel(language);
  const navRows = [
    {
      icon: "brightness-6" as const,
      label: t("settings.theme"),
      value: themeLabel,
      route: "/settings/theme" as const,
    },
    {
      icon: "palette" as const,
      label: t("settings.colorScheme"),
      value: colorLabel,
      route: "/settings/color-scheme" as const,
    },
    {
      icon: "language" as const,
      label: t("settings.language"),
      value: langLabel,
      route: "/settings/language" as const,
    },
  ];
  return navRows.map((row) => (
    <Pressable
      key={row.route}
      onPress={() => {
        const result = runNavigationIntent({
          target: row.route,
          dispatch: () => {
            router.push(row.route);
          },
        });
        if (result.status === "blocked") {
          return;
        }
        if (result.status === "failed") {
          console.error("Failed to open Settings destination", result.error);
        }
      }}
      accessibilityRole="button"
      accessibilityLabel={`${row.label}: ${row.value}`}
      className="flex-row items-center justify-between bg-surface px-base border-b border-divider active:opacity-70"
      style={styles.standardRow}
    >
      <View
        className="flex-row flex-1 items-center pr-sm"
        style={{ minWidth: 0 }}
      >
        <Icon name={row.icon} size={20} variant="primary" />
        <Text
          className="ml-[9px] flex-shrink text-primary text-base"
          style={{ minWidth: 0 }}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {row.label}
        </Text>
      </View>
      <View
        className="max-w-[45%] flex-row items-center"
        style={{ flexShrink: 0 }}
      >
        <Text
          className="flex-shrink text-right text-muted text-sm mr-xs"
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {row.value}
        </Text>
        <Icon name="chevron-right" size={24} variant="muted" />
      </View>
    </Pressable>
  ));
}
function SkipReasonChevron() {
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  return (
    <View style={[styles.skipReasonChevron, { borderColor: palette.icon }]} />
  );
}
interface SettingsToggleRowProps {
  label: string;
  icon: React.ReactNode;
  value: boolean;
  onValueChange: (value: boolean) => void;
  multiline?: boolean;
}
function SettingsToggleRow({
  label,
  icon,
  value,
  onValueChange,
  multiline = false,
}: SettingsToggleRowProps) {
  return (
    <View
      className="flex-row items-center justify-between bg-surface px-base border-b border-divider"
      style={multiline ? styles.multilineRow : styles.standardRow}
    >
      <View className="flex-row flex-1 items-center pr-sm">
        {icon}
        <Text
          className="ml-[9px] flex-shrink text-primary text-base"
          numberOfLines={multiline ? 2 : undefined}
        >
          {label}
        </Text>
      </View>
      <Toggle
        value={value}
        onValueChange={onValueChange}
        accessibilityLabel={label}
      />
    </View>
  );
}
function SoundSettingsRow() {
  const { t } = useTranslation();
  const value = useSettingsStore((state) => state.soundEnabled);
  const setValue = useSettingsStore((state) => state.setSoundEnabled);
  return (
    <SettingsToggleRow
      label={t("settings.sound")}
      icon={<Icon name="volume-up" size={20} variant="primary" />}
      value={value}
      onValueChange={setValue}
    />
  );
}
function ReminderSettingsRow() {
  const { t } = useTranslation();
  const value = useSettingsStore((state) => state.reminderNotificationsEnabled);
  const setValue = useSettingsStore(
    (state) => state.setReminderNotificationsEnabled,
  );
  return (
    <SettingsToggleRow
      label={t("settings.reminders")}
      icon={<Icon name="notifications-active" size={20} variant="primary" />}
      value={value}
      onValueChange={setValue}
    />
  );
}
function FailureReasonSettingsRow() {
  const { t } = useTranslation();
  const value = useSettingsStore((state) => state.askFailureReason);
  const setValue = useSettingsStore((state) => state.setAskFailureReason);
  return (
    <SettingsToggleRow
      label={t("settings.askFailureReason")}
      icon={<Icon name="close" size={21} variant="primary" />}
      value={value}
      onValueChange={setValue}
    />
  );
}
function SkipReasonSettingsRow() {
  const { t } = useTranslation();
  const value = useSettingsStore((state) => state.askSkipReason);
  const setValue = useSettingsStore((state) => state.setAskSkipReason);
  return (
    <SettingsToggleRow
      label={t("settings.askSkipReason")}
      icon={
        <View style={styles.skipReasonIconSlot}>
          <SkipReasonChevron />
        </View>
      }
      value={value}
      onValueChange={setValue}
    />
  );
}
function ArchiveStatisticsSettingsRow() {
  const { t } = useTranslation();
  const value = useSettingsStore(
    (state) => state.showArchivedHabitsInStatistics,
  );
  const setValue = useSettingsStore(
    (state) => state.setShowArchivedHabitsInStatistics,
  );
  return (
    <SettingsToggleRow
      label={t("settings.showArchivedHabitsInStatistics")}
      icon={<Icon name="bar-chart" size={20} variant="primary" />}
      value={value}
      onValueChange={setValue}
      multiline
    />
  );
}
function SettingsScreenContent() {
  const { t } = useTranslation();
  const router = useRouter();
  const runNavigationIntent = useNavigationIntentGate();
  return (
    <SettingsScreenShell title={t("settings.title")}>
      <SettingsErrorBanner />

      <View className="border-t border-divider">
        {/* Navigation rows keep the label left and the current value with chevron right. */}
        <SettingsNavigationRows />

        {/* Toggle rows apply their setting inline. */}
        <SoundSettingsRow />
        <ReminderSettingsRow />
        <FailureReasonSettingsRow />
        <SkipReasonSettingsRow />
        <ArchiveStatisticsSettingsRow />
        <Pressable
          onPress={() => {
            const result = runNavigationIntent({
              target: "/settings/privacy",
              dispatch: () => router.push("/settings/privacy"),
            });
            if (result.status === "failed") {
              console.error("Failed to open privacy policy", result.error);
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={t("settings.privacyPolicy")}
          className="flex-row items-center justify-between bg-surface px-base border-b border-divider active:opacity-70"
          style={styles.standardRow}
        >
          <View className="flex-row flex-1 items-center pr-sm">
            <Icon name="privacy-tip" size={20} variant="primary" />
            <Text className="ml-[9px] flex-shrink text-primary text-base">
              {t("settings.privacyPolicy")}
            </Text>
          </View>
          <Icon name="chevron-right" size={24} variant="muted" />
        </Pressable>
      </View>
    </SettingsScreenShell>
  );
}
export default function SettingsScreen() {
  return (
    <>
      <FocusedRouteModuleWarmup entries={SETTINGS_ROUTE_MODULE_WARMUPS} />
      <SettingsScreenContent />
    </>
  );
}
