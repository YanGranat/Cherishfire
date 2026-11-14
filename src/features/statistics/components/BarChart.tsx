/** @jsxImportSource nativewind */
import React from "react";
import { View, Text } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useTranslation } from "react-i18next";
import { getAccentScheme, lightTheme } from "@/theme/colors";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
interface BarDataPoint {
  label: string;
  value: number;
  isFuture: boolean;
  isToday: boolean;
}
interface BarChartProps {
  data: BarDataPoint[];
  labels: string[];
  period: "week" | "month" | "year";
}
function createBarChartSlots(
  data: readonly BarDataPoint[],
  slotCount: number,
): (BarDataPoint | null)[] {
  return Array.from({ length: slotCount }, (_, index) => data[index] ?? null);
}
// Bars use the accent for completed progress and the muted color for the remainder.
// Future days: empty/dotted outline. Current day: subtle neutral border in week view.
export function BarChart({ data, labels, period }: BarChartProps) {
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
  const chartTrackColor = isDark ? "#313131" : "#EDEDED";
  const futureTrackColor = isDark ? "#202020" : "#FAFAFA";
  const futureTrackBorderColor = isDark ? "#383838" : "#E8E8E8";
  const gridLineColor = isDark ? "#3A3A3A" : "#E7E7E7";
  const futureBarColor = isDark ? "#707070" : "#A0A0A0";
  const currentDayBorderColor = cardBorderColor;
  const accentSoft = `${accent}${isDark ? "3D" : "2A"}`;
  const maxBars = labels.length;
  const chartData = createBarChartSlots(data, maxBars);
  return (
    <View
      className="mx-[14px] mt-[10px] overflow-hidden rounded-section-card border"
      style={{
        backgroundColor: cardBackgroundColor,
        borderColor: cardBorderColor,
        borderWidth: 0.5,
      }}
    >
      <View
        className="flex-row items-center border-b border-divider px-md py-sm"
        style={{
          backgroundColor: sectionHeaderBackgroundColor,
          borderBottomColor: sectionDividerColor,
          borderBottomWidth: 0.5,
        }}
      >
        <MaterialIcons name="bar-chart" size={15} color={sectionTitleColor} />
        <Text
          className="ml-[7px] text-xs font-semibold uppercase"
          style={{ color: sectionTitleColor }}
        >
          {t("statistics.completionRate")}
        </Text>
      </View>

      <View className="px-sm pb-sm pt-md">
        <View style={{ height: 126, position: "relative" }}>
          {[0, 1, 2, 3].map((line) => (
            <View
              key={line}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: line * 30,
                height: 0.5,
                backgroundColor: gridLineColor,
              }}
            />
          ))}

          <View
            className="flex-row items-end justify-around"
            style={{ height: 120 }}
          >
            {chartData.map((point, i) => {
              if (point == null) {
                return <View key={i} className="mx-[2px] flex-1" />;
              }
              const barHeight = Math.max(2, (point.value / 100) * 112);
              const isCurrentDay = period === "week" && point.isToday;
              return (
                <View key={i} className="items-center flex-1 mx-[2px]">
                  <View
                    style={{
                      height: 112,
                      width: "72%",
                      borderRadius: 6,
                      overflow: "hidden",
                      justifyContent: "flex-end",
                      backgroundColor: point.isFuture
                        ? futureTrackColor
                        : chartTrackColor,
                      borderWidth: isCurrentDay
                        ? 0.5
                        : point.isFuture
                          ? 0.5
                          : 0,
                      borderColor: isCurrentDay
                        ? currentDayBorderColor
                        : point.isFuture
                          ? futureTrackBorderColor
                          : "transparent",
                    }}
                  >
                    <View
                      style={{
                        height: barHeight,
                        width: "100%",
                        borderRadius: 6,
                        backgroundColor: point.isFuture ? accentSoft : accent,
                        borderWidth: point.isFuture ? 0.5 : 0,
                        borderColor: point.isFuture
                          ? futureBarColor
                          : "transparent",
                        borderStyle: point.isFuture ? "dashed" : "solid",
                        opacity: point.isFuture ? 0.75 : 1,
                      }}
                    />
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        <View className="flex-row justify-around mt-xs">
          {labels.map((label, i) => {
            const isCurrentDay = period === "week" && chartData[i]?.isToday;
            return (
              <Text
                key={i}
                className="text-muted text-center flex-1"
                style={[
                  { fontSize: 11 },
                  isCurrentDay ? { color: accent } : null,
                ]}
                numberOfLines={1}
              >
                {label}
              </Text>
            );
          })}
        </View>
      </View>
    </View>
  );
}
