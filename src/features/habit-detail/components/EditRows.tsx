/** @jsxImportSource nativewind */
import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useTranslation } from "react-i18next";
import {
  getRepeatLabel,
  WEEKDAY_SHORT_KEYS,
} from "@/features/habits/presentation/repeat-labels";
import { getReminderSummary } from "@/domain/reminders/reminder-time";
import {
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { formatLocalizedDate } from "@/utils/date";
import { lightTheme, darkTheme } from "@/theme/colors";
import type { RepeatSchedule } from "@/types/habit";
const ROW_HIGHLIGHT_HOLD_MS = 10;
interface EditRowsProps {
  repeatSchedule: RepeatSchedule;
  startDate: string;
  reminderEnabled: boolean;
  reminderTime: string | null;
  onRepeatPress: () => void;
  onStartDatePress: () => void;
  onReminderPress: () => void;
  showHeader?: boolean;
  disabled?: boolean;
}
export const EditRows = React.memo(function EditRows({
  repeatSchedule,
  startDate,
  reminderEnabled,
  reminderTime,
  onRepeatPress,
  onStartDatePress,
  onReminderPress,
  showHeader = true,
  disabled = false,
}: EditRowsProps) {
  const { t } = useTranslation();
  const language = useVisualLanguage();
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const rows = [
    {
      icon: "repeat" as const,
      label: t("creation.repeat"),
      value: getRepeatLabel(
        repeatSchedule,
        t,
        [...WEEKDAY_SHORT_KEYS],
        language,
      ),
      onPress: onRepeatPress,
    },
    {
      icon: "event" as const,
      label: t("creation.startDate"),
      value: formatLocalizedDate(startDate, language),
      onPress: onStartDatePress,
    },
    {
      icon: "notifications-active" as const,
      label: t("creation.reminder"),
      value: reminderEnabled
        ? (getReminderSummary(reminderTime) ?? t("creation.reminderOff"))
        : t("creation.reminderOff"),
      onPress: onReminderPress,
    },
  ];
  const chevronColor = isDark ? darkTheme.muted : lightTheme.muted;
  const rowDividerColor = isDark ? "#6B6B6B" : lightTheme.divider;
  const sectionTitleColor = isDark ? "#D8D8D8" : lightTheme.muted;
  const cardBackgroundColor = isDark ? "#262626" : lightTheme.surfaceElevated;
  const sectionHeaderBackgroundColor = isDark ? "#2F2F2F" : lightTheme.surface;
  const cardBorderColor = isDark ? "#5F5F5F" : lightTheme.border;
  const rowIconColor = isDark ? darkTheme.icon : lightTheme.icon;
  const [pressedRowIndex, setPressedRowIndex] = useState<number | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (releaseTimerRef.current != null) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
    };
  }, []);
  return (
    <View
      className="mx-[14px] mt-[10px] overflow-hidden rounded-section-card border border-border"
      style={{
        backgroundColor: cardBackgroundColor,
        borderColor: cardBorderColor,
        borderWidth: 0.5,
      }}
    >
      {showHeader ? (
        <View
          className="border-b border-divider px-md pb-sm pt-md"
          style={{
            backgroundColor: sectionHeaderBackgroundColor,
            borderBottomColor: rowDividerColor,
            borderBottomWidth: 0.5,
          }}
        >
          <Text
            className="text-xs font-semibold uppercase"
            style={{ color: sectionTitleColor }}
          >
            {t("detail.edit")}
          </Text>
        </View>
      ) : null}

      <View>
        {rows.map((row, index) => (
          <View key={row.label}>
            <Pressable
              onPress={
                disabled
                  ? undefined
                  : () => {
                      row.onPress();
                    }
              }
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`${row.label}: ${row.value}`}
              accessibilityState={{ disabled }}
              onPressIn={() => {
                if (disabled) return;
                if (releaseTimerRef.current != null) {
                  clearTimeout(releaseTimerRef.current);
                  releaseTimerRef.current = null;
                }
                setPressedRowIndex(index);
              }}
              onPressOut={() => {
                if (disabled) return;
                if (releaseTimerRef.current != null) {
                  clearTimeout(releaseTimerRef.current);
                }
                // Keep highlight for a short moment so quick taps are visible.
                releaseTimerRef.current = setTimeout(() => {
                  setPressedRowIndex((current) =>
                    current === index ? null : current,
                  );
                  releaseTimerRef.current = null;
                }, ROW_HIGHLIGHT_HOLD_MS);
              }}
              className="flex-row items-center justify-between px-md"
              style={{
                minHeight: 40,
                opacity: disabled ? 0.7 : 1,
                backgroundColor:
                  pressedRowIndex === index
                    ? isDark
                      ? "rgba(255,255,255,0.16)"
                      : "rgba(0,0,0,0.07)"
                    : "transparent",
              }}
            >
              <View className="flex-shrink-0 flex-row items-center">
                <MaterialIcons name={row.icon} size={20} color={rowIconColor} />
                <Text className="ml-[9px] text-base text-primary">
                  {row.label}
                </Text>
              </View>

              <View
                className="ml-sm flex-1 flex-row items-center justify-end"
                style={{ minWidth: 0 }}
              >
                <Text
                  className="mr-xs text-sm text-muted"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  style={{ flexShrink: 1, minWidth: 0, textAlign: "right" }}
                >
                  {row.value}
                </Text>
                {disabled ? null : (
                  <MaterialIcons
                    name="chevron-right"
                    size={20}
                    color={chevronColor}
                  />
                )}
              </View>
            </Pressable>

            {index < rows.length - 1 ? (
              <View>
                <View
                  style={{
                    height: 0.5,
                    backgroundColor: rowDividerColor,
                  }}
                />
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
});
