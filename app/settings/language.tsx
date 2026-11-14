/** @jsxImportSource nativewind */
import React from "react";
import { Text, Pressable, View } from "react-native";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useVisualColorScheme,
  useVisualLanguage,
} from "@/components/ScreenPreferencesBoundary";
import { getAccentScheme } from "@/theme/colors";
import { LANGUAGE_OPTIONS } from "@/i18n/languages";
import { SettingsErrorBanner } from "@/features/settings/components/SettingsErrorBanner";
import { SettingsScreenShell } from "@/features/settings/components/SettingsScreenShell";
const SETTINGS_ROW_HEIGHT = 56;
interface LanguageRowProps {
  code: string;
  nativeLabel: string;
  selected: boolean;
  accent: string;
  onSelect: (language: string) => boolean;
}
const LanguageRow = React.memo(function LanguageRow({
  code,
  nativeLabel,
  selected,
  accent,
  onSelect,
}: LanguageRowProps) {
  return (
    <Pressable
      onPress={() => {
        onSelect(code);
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={nativeLabel}
      className="flex-row items-center justify-between px-base border-b border-divider active:bg-press-highlight"
      style={{ minHeight: SETTINGS_ROW_HEIGHT, paddingVertical: 8 }}
    >
      <Text
        className="flex-1 text-primary text-base"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {nativeLabel}
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
// Language options use native names; selection applies immediately,
// checkmark in accent color. Header and labels update immediately.
export default function LanguageScreen() {
  const { t } = useTranslation();
  const language = useVisualLanguage();
  const setLanguage = useSettingsStore((state) => state.setLanguage);
  const colorScheme = useVisualColorScheme();
  const accent = getAccentScheme(colorScheme).base;
  const selectLanguage = React.useCallback(
    (nextLanguage: string) => {
      if (useSettingsStore.getState().language === nextLanguage) return false;
      void setLanguage(nextLanguage);
      return true;
    },
    [setLanguage],
  );
  return (
    <SettingsScreenShell title={t("languageScreen.title")}>
      <SettingsErrorBanner />

      <View className="border-t border-divider">
        {LANGUAGE_OPTIONS.map((lang) => (
          <LanguageRow
            key={lang.code}
            code={lang.code}
            nativeLabel={lang.nativeLabel}
            selected={language === lang.code}
            accent={accent}
            onSelect={selectLanguage}
          />
        ))}
      </View>
    </SettingsScreenShell>
  );
}
