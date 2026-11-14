/** @jsxImportSource nativewind */
import React from "react";
import { View, Text, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/Icon";
import { getPeriodLabel } from "@/utils/date";
import { getAccentScheme, darkTheme, lightTheme } from "@/theme/colors";
import {
  useVisualColorScheme,
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import type { StatisticsPeriodRange } from "@/domain/statistics/statistics-period";
type Period = "week" | "month" | "year";
interface PeriodSelectorProps {
  period: Period;
  periodRange: StatisticsPeriodRange;
  canNavigatePrevious: boolean;
  canNavigateNext: boolean;
  onPeriodChange: (period: Period) => void;
  resolveNavigationTarget: (direction: "prev" | "next") => {
    period: Period;
    periodOffset: number;
  };
  onNavigate: (
    direction: "prev" | "next",
    target: {
      period: Period;
      periodOffset: number;
    },
  ) => void;
}
const PERIODS: Period[] = ["week", "month", "year"];
// The segment control uses an accent fill for the active period and a transparent inactive state;
// period navigation arrows with label. Sticky, does not scroll.
export function PeriodSelector({
  period,
  periodRange,
  canNavigatePrevious,
  canNavigateNext,
  onPeriodChange,
  resolveNavigationTarget,
  onNavigate,
}: PeriodSelectorProps) {
  const { t } = useTranslation();
  const colorScheme = useVisualColorScheme();
  const language = useVisualLanguage();
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const accent = getAccentScheme(colorScheme).base;
  const cardBackgroundColor = isDark ? "#262626" : lightTheme.surfaceElevated;
  const cardBorderColor = isDark ? "#5F5F5F" : lightTheme.border;
  const sectionDividerColor = isDark ? "#6B6B6B" : lightTheme.divider;
  const segmentedBackgroundColor = isDark ? "#202020" : "#F5F5F5";
  const segmentedBorderColor = isDark ? "#4E4E4E" : "#D9D9D9";
  const navBackgroundColor = isDark ? "#2B2B2B" : "#F6F6F6";
  const navButtonBackgroundColor = isDark ? "#353535" : "#ECECEC";
  const accentSoft = `${accent}${isDark ? "4D" : "2E"}`;
  const isPreviousDisabled = !canNavigatePrevious;
  const isNextDisabled = !canNavigateNext;
  const periodLabels: Record<Period, string> = {
    week: t("statistics.week"),
    month: t("statistics.month"),
    year: t("statistics.year"),
  };
  return (
    <View
      className="mx-[14px] mt-[6px] overflow-hidden rounded-section-card border"
      style={{
        backgroundColor: cardBackgroundColor,
        borderColor: cardBorderColor,
        borderWidth: 0.5,
      }}
    >
      <View className="px-sm py-sm">
        <View
          className="flex-row overflow-hidden rounded-[10px] border"
          style={{
            backgroundColor: segmentedBackgroundColor,
            borderColor: segmentedBorderColor,
            borderWidth: 0.5,
          }}
        >
          {PERIODS.map((p, index) => (
            <View key={p} className="flex-1">
              <Pressable
                onPress={() => {
                  onPeriodChange(p);
                }}
                accessibilityRole="tab"
                accessibilityLabel={periodLabels[p]}
                accessibilityState={{ selected: period === p }}
                className="items-center justify-center py-[7px]"
                style={{
                  backgroundColor: period === p ? accentSoft : "transparent",
                }}
              >
                <Text
                  className="text-sm font-semibold"
                  style={{
                    color:
                      period === p
                        ? isDark
                          ? darkTheme.primary
                          : lightTheme.primary
                        : isDark
                          ? darkTheme.muted
                          : lightTheme.muted,
                  }}
                >
                  {periodLabels[p]}
                </Text>
              </Pressable>
              {index < PERIODS.length - 1 ? (
                <View
                  style={{
                    position: "absolute",
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: 0.5,
                    backgroundColor: sectionDividerColor,
                  }}
                />
              ) : null}
            </View>
          ))}
        </View>

        <View
          className="mt-sm flex-row items-center justify-between rounded-[10px] border px-xs py-[6px]"
          style={{
            backgroundColor: navBackgroundColor,
            borderColor: segmentedBorderColor,
            borderWidth: 0.5,
          }}
        >
          <Pressable
            onPress={() => {
              const target = resolveNavigationTarget("prev");
              onNavigate("prev", target);
            }}
            disabled={isPreviousDisabled}
            className="h-[30px] w-[30px] items-center justify-center rounded-full"
            style={{
              backgroundColor: navButtonBackgroundColor,
              ...(isPreviousDisabled ? { opacity: 0.35 } : null),
            }}
            accessibilityRole="button"
            accessibilityLabel={t("statistics.previousPeriod")}
            accessibilityState={{ disabled: isPreviousDisabled }}
          >
            <Icon name="chevron-left" size={19} variant="primary" />
          </Pressable>
          <Text className="text-primary font-semibold text-base">
            {getPeriodLabel(period, language, periodRange)}
          </Text>
          <Pressable
            onPress={() => {
              const target = resolveNavigationTarget("next");
              onNavigate("next", target);
            }}
            disabled={isNextDisabled}
            className="h-[30px] w-[30px] items-center justify-center rounded-full"
            style={{
              backgroundColor: navButtonBackgroundColor,
              opacity: isNextDisabled ? 0.35 : 1,
            }}
            accessibilityRole="button"
            accessibilityLabel={t("statistics.nextPeriod")}
            accessibilityState={{ disabled: isNextDisabled }}
          >
            <Icon name="chevron-right" size={19} variant="primary" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
