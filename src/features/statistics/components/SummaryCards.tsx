/** @jsxImportSource nativewind */
import React from "react";
import { View, Text } from "react-native";
import Entypo from "@expo/vector-icons/Entypo";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useTranslation } from "react-i18next";
import { getAccentScheme, lightTheme } from "@/theme/colors";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
interface SummaryCardsProps {
  periodProgress: string;
  perfectDays: {
    count: number;
    total: number;
  };
  showProgress?: boolean;
}
// Two summary cards show period progress and perfect-day counts.
export function SummaryCards({
  periodProgress,
  perfectDays,
  showProgress = true,
}: SummaryCardsProps) {
  const { t } = useTranslation();
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const accent = getAccentScheme(colorScheme).base;
  const cardBackgroundColor = isDark ? "#262626" : lightTheme.surfaceElevated;
  const cardBorderColor = isDark ? "#5F5F5F" : lightTheme.border;
  const sectionHeaderBackgroundColor = isDark ? "#2F2F2F" : lightTheme.surface;
  const sectionDividerColor = isDark ? "#6B6B6B" : lightTheme.divider;
  const sectionTitleColor = isDark ? "#D8D8D8" : lightTheme.muted;
  const accentSoft = `${accent}${isDark ? "30" : "24"}`;
  return (
    <View className="mx-[14px] mt-[10px]">
      <View
        className="overflow-hidden rounded-section-card border"
        style={{
          backgroundColor: cardBackgroundColor,
          borderColor: cardBorderColor,
          borderWidth: 0.5,
        }}
      >
        <View className="flex-row">
          {showProgress ? (
            <View className="flex-1">
              <View
                className="flex-row items-center border-b border-divider px-md py-sm"
                style={{
                  backgroundColor: sectionHeaderBackgroundColor,
                  borderBottomColor: sectionDividerColor,
                  borderBottomWidth: 0.5,
                }}
              >
                <Entypo name="bar-graph" size={15} color={sectionTitleColor} />
                <Text
                  className="ml-[7px] text-xs font-semibold uppercase"
                  style={{ color: sectionTitleColor }}
                >
                  {t("statistics.progress")}
                </Text>
              </View>
              <View className="items-center px-md pb-md pt-[14px]">
                <View
                  className="mb-xs rounded-full px-sm py-[2px]"
                  style={{ backgroundColor: accentSoft }}
                >
                  <Text
                    style={{ fontSize: 28, fontWeight: "700", color: accent }}
                  >
                    {periodProgress === "—"
                      ? periodProgress
                      : `${periodProgress}%`}
                  </Text>
                </View>
              </View>
            </View>
          ) : null}

          <View
            className={
              showProgress ? "flex-1 border-l border-divider" : "flex-1"
            }
            style={
              showProgress
                ? {
                    borderLeftColor: sectionDividerColor,
                    borderLeftWidth: 0.5,
                  }
                : undefined
            }
          >
            <View
              className="flex-row items-center border-b border-divider px-md py-sm"
              style={{
                backgroundColor: sectionHeaderBackgroundColor,
                borderBottomColor: sectionDividerColor,
                borderBottomWidth: 0.5,
              }}
            >
              <MaterialIcons
                name="check-circle-outline"
                size={15}
                color={sectionTitleColor}
              />
              <Text
                className="ml-[7px] text-xs font-semibold uppercase"
                style={{ color: sectionTitleColor }}
              >
                {t("statistics.perfectDays")}
              </Text>
            </View>
            <View className="items-center px-md pb-md pt-[14px]">
              <Text
                className="text-primary"
                style={{ fontSize: 28, fontWeight: "700" }}
              >
                {perfectDays.count}
              </Text>
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
