/** @jsxImportSource nativewind */
import React from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { darkTheme, lightTheme } from "@/theme/colors";
interface ProgressStatsProps {
  currentStreak: number;
  bestStreak: number;
  totalCompletions: number;
}
export const ProgressStats = React.memo(function ProgressStats({
  currentStreak,
  bestStreak,
  totalCompletions,
}: ProgressStatsProps) {
  const { t } = useTranslation();
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const dividerColor = isDark ? "#6B6B6B" : lightTheme.divider;
  const sectionTitleColor = isDark ? "#D8D8D8" : lightTheme.muted;
  const cardBackgroundColor = isDark ? "#262626" : lightTheme.surfaceElevated;
  const sectionHeaderBackgroundColor = isDark ? "#2F2F2F" : lightTheme.surface;
  const cardBorderColor = isDark ? "#5F5F5F" : lightTheme.border;
  const statValueColor = isDark ? darkTheme.metric : lightTheme.metric;
  const stats = [
    { label: t("detail.streak"), value: currentStreak },
    { label: t("detail.record"), value: bestStreak },
    { label: t("detail.total"), value: totalCompletions },
  ];
  return (
    <View
      className="mx-[14px] mt-[10px] overflow-hidden rounded-section-card border border-border"
      style={{
        backgroundColor: cardBackgroundColor,
        borderColor: cardBorderColor,
        borderWidth: 0.5,
      }}
    >
      <View
        className="border-b border-divider px-md pb-sm pt-md"
        style={{
          backgroundColor: sectionHeaderBackgroundColor,
          borderBottomColor: dividerColor,
          borderBottomWidth: 0.5,
        }}
      >
        <Text
          className="text-xs font-semibold uppercase"
          style={{ color: sectionTitleColor }}
        >
          {t("detail.progress")}
        </Text>
      </View>

      <View className="flex-row">
        {stats.map((stat, index) => (
          <View
            key={stat.label}
            className="flex-1 items-center px-xs py-md"
            style={
              index > 0
                ? { borderLeftWidth: 0.5, borderLeftColor: dividerColor }
                : undefined
            }
          >
            <Text
              style={{
                color: statValueColor,
                fontSize: 22,
                fontWeight: "700",
              }}
            >
              {stat.value}
            </Text>
            <Text className="mt-xs text-center text-xs text-muted">
              {stat.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
});
