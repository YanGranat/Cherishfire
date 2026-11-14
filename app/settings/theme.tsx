/** @jsxImportSource nativewind */
import React from "react";
import { View, Text, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useVisualColorScheme,
  useVisualTheme,
} from "@/components/ScreenPreferencesBoundary";
import { getAccentScheme } from "@/theme/colors";
import type { ThemeMode } from "@/types/settings";
import { SettingsErrorBanner } from "@/features/settings/components/SettingsErrorBanner";
import { SettingsScreenShell } from "@/features/settings/components/SettingsScreenShell";
const THEME_OPTIONS: ThemeMode[] = ["system", "dark", "light"];
const SETTINGS_ROW_HEIGHT = 56;
interface ThemeRowProps {
  option: ThemeMode;
  label: string;
  selected: boolean;
  accent: string;
  onSelect: (option: ThemeMode) => boolean;
}
const ThemeRow = React.memo(function ThemeRow({
  option,
  label,
  selected,
  accent,
  onSelect,
}: ThemeRowProps) {
  return (
    <Pressable
      onPress={() => {
        onSelect(option);
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      className="flex-row items-center justify-between px-base border-b border-divider active:bg-press-highlight"
      style={{ minHeight: SETTINGS_ROW_HEIGHT, paddingVertical: 8 }}
    >
      <Text
        className="flex-1 text-primary text-base"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {label}
      </Text>
      {selected ? (
        <MaterialIcons
          name="check"
          size={24}
          color={accent}
          style={{ marginLeft: 8 }}
        />
      ) : null}
    </Pressable>
  );
});
// System, dark, and light options use a radio list with an accent checkmark;
// tap applies immediately, screen itself reflects new theme.
export default function ThemeScreen() {
  const { t } = useTranslation();
  const theme = useVisualTheme();
  const setTheme = useSettingsStore((state) => state.setTheme);
  const colorScheme = useVisualColorScheme();
  const accent = getAccentScheme(colorScheme).base;
  const labels = React.useMemo<Record<ThemeMode, string>>(
    () => ({
      system: t("themeScreen.system"),
      dark: t("themeScreen.dark"),
      light: t("themeScreen.light"),
    }),
    [t],
  );
  const selectTheme = React.useCallback(
    (option: ThemeMode) => {
      if (useSettingsStore.getState().theme === option) return false;
      void setTheme(option);
      return true;
    },
    [setTheme],
  );
  return (
    <SettingsScreenShell title={t("themeScreen.title")}>
      <SettingsErrorBanner />

      <View className="border-t border-divider">
        {THEME_OPTIONS.map((option) => (
          <ThemeRow
            key={option}
            option={option}
            label={labels[option]}
            selected={theme === option}
            accent={accent}
            onSelect={selectTheme}
          />
        ))}
      </View>
    </SettingsScreenShell>
  );
}
