/** @jsxImportSource nativewind */
import React from "react";
import { View, Text, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import Octicons from "@expo/vector-icons/Octicons";
import { Icon } from "@/components/ui/Icon";
import { getAccentScheme, darkTheme, lightTheme } from "@/theme/colors";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { sizes } from "@/theme/tokens";
import { useNavigationIntentGate } from "@/hooks/useNavigationIntentGate";
interface HabitBreakdownRow {
  habitId: number;
  name: string;
  completionRate: number;
  currentStreak: number;
}
interface HabitBreakdownProps {
  habits: HabitBreakdownRow[];
}
interface HabitBreakdownItemProps extends HabitBreakdownRow {
  accent: string;
  accentSoft: string;
  progressTrackColor: string;
  streakColor: string;
  onOpenHabit: (habitId: number) => void;
}
const HabitBreakdownItem = React.memo(function HabitBreakdownItem({
  habitId,
  name,
  completionRate,
  currentStreak,
  accent,
  accentSoft,
  progressTrackColor,
  streakColor,
  onOpenHabit,
}: HabitBreakdownItemProps) {
  const handlePress = React.useCallback(
    () => onOpenHabit(habitId),
    [habitId, onOpenHabit],
  );
  return (
    <Pressable
      onPress={handlePress}
      className="px-md py-sm active:bg-press-highlight"
    >
      <View className="mb-xs flex-row items-center justify-between">
        <Text className="text-primary text-base flex-1" numberOfLines={1}>
          {name}
        </Text>

        <View className="ml-sm flex-row items-center">
          <View
            className="rounded-full px-[9px] py-[3px]"
            style={{ backgroundColor: accentSoft }}
          >
            <Text className="text-sm font-semibold" style={{ color: accent }}>
              {completionRate}%
            </Text>
          </View>
          <View className="ml-sm flex-row items-center">
            <Octicons name="link" size={13} color={accent} />
            <Text className="ml-[2px] text-sm" style={{ color: streakColor }}>
              {currentStreak}
            </Text>
          </View>
          <View style={{ marginLeft: 4 }}>
            <Icon name="chevron-right" size={18} variant="muted" />
          </View>
        </View>
      </View>

      <View
        className="overflow-hidden rounded-full"
        style={{
          height: sizes.progressBarHeight + 1,
          backgroundColor: progressTrackColor,
        }}
      >
        <View
          style={{
            height: "100%",
            width: `${completionRate}%`,
            backgroundColor: accent,
            borderRadius: (sizes.progressBarHeight + 1) / 2,
          }}
        />
      </View>
    </Pressable>
  );
});
// Habits are sorted by completion rate descending.
// Each row: name (left), completion % (right), streak (far right), progress bar below name.
// Tap -> navigate to habit detail.
// Streak is evaluated at the end of a past period and at today for the current
// period, so a historical breakdown remains internally consistent.
export function HabitBreakdown({ habits }: HabitBreakdownProps) {
  const router = useRouter();
  const runNavigationIntent = useNavigationIntentGate();
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
  const accentSoft = `${accent}${isDark ? "3D" : "28"}`;
  const progressTrackColor = isDark ? "#373737" : "#EAEAEA";
  const streakColor = isDark ? darkTheme.muted : lightTheme.muted;
  const handleOpenHabit = React.useCallback(
    (habitId: number) => {
      const target = `/habit/${habitId}`;
      const result = runNavigationIntent({
        target,
        dispatch: () => {
          router.push(`/habit/${habitId}`);
        },
      });
      if (result.status === "blocked") {
      } else if (result.status === "failed") {
        console.error("Failed to open habit from statistics", result.error);
      }
    },
    [router, runNavigationIntent],
  );
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
        <MaterialIcons name="list-alt" size={15} color={sectionTitleColor} />
        <Text
          className="ml-[7px] text-xs font-semibold uppercase"
          style={{ color: sectionTitleColor }}
        >
          {t("statistics.byHabit")}
        </Text>
      </View>

      {habits.map((habit) => (
        <HabitBreakdownItem
          key={habit.habitId}
          habitId={habit.habitId}
          name={habit.name}
          completionRate={habit.completionRate}
          currentStreak={habit.currentStreak}
          accent={accent}
          accentSoft={accentSoft}
          progressTrackColor={progressTrackColor}
          streakColor={streakColor}
          onOpenHabit={handleOpenHabit}
        />
      ))}
    </View>
  );
}
