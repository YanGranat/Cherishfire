/** @jsxImportSource nativewind */
import React, { useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useTranslation } from "react-i18next";
import { sizes } from "@/theme/tokens";
import { getAccentScheme } from "@/theme/colors";
import { useVisualColorScheme } from "@/components/ScreenPreferencesBoundary";
const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
interface RepeatDaysTabProps {
  selectedDays: number[]; // 1=Mon..7=Sun
  /** Returns the actual selected state after applying the latest draft. */
  onToggleDay: (day: number) => boolean;
}
const REPEAT_DAY_ROW_HEIGHT = 50;
interface RepeatDayRowProps {
  accent: string;
  canToggle: boolean;
  day: number;
  isSelected: boolean;
  label: string;
  onToggleDay: (day: number) => boolean;
}
const RepeatDayRow = React.memo(function RepeatDayRow({
  accent,
  canToggle,
  day,
  isSelected,
  label,
  onToggleDay,
}: RepeatDayRowProps) {
  const handlePress = useCallback(() => {
    if (!canToggle) return;
    onToggleDay(day);
  }, [canToggle, day, onToggleDay]);
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked: isSelected, disabled: !canToggle }}
      disabled={!canToggle}
      className="border-b border-divider justify-center"
      style={{ minHeight: Math.min(sizes.rowHeight, REPEAT_DAY_ROW_HEIGHT) }}
    >
      <View className="flex-row items-center justify-between px-base">
        <Text className="text-primary text-base">{label}</Text>
        {isSelected ? (
          <MaterialIcons name="check" size={24} color={accent} />
        ) : null}
      </View>
    </Pressable>
  );
});
// At least one weekday must remain selected.
export const RepeatDaysTab = React.memo(function RepeatDaysTab({
  selectedDays,
  onToggleDay,
}: RepeatDaysTabProps) {
  const { t } = useTranslation();
  const colorScheme = useVisualColorScheme();
  const accent = getAccentScheme(colorScheme).base;
  return (
    <View>
      {WEEKDAY_KEYS.map((key, i) => {
        const dayNum = i + 1;
        const isSelected = selectedDays.includes(dayNum);
        // Prevent deselecting the last remaining day
        const canToggle = isSelected ? selectedDays.length > 1 : true;
        return (
          <RepeatDayRow
            key={key}
            accent={accent}
            canToggle={canToggle}
            day={dayNum}
            isSelected={isSelected}
            label={t(`weekdays.${key}` as any)}
            onToggleDay={onToggleDay}
          />
        );
      })}
    </View>
  );
});
