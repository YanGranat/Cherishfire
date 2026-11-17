/** @jsxImportSource nativewind */
import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { View, Text, Pressable } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useTranslation } from "react-i18next";
import { addMonths } from "date-fns/addMonths";
import { parseISO } from "date-fns/parseISO";
import { startOfMonth } from "date-fns/startOfMonth";
import { subMonths } from "date-fns/subMonths";
import {
  useVisualColorScheme,
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import {
  semantic,
  lightTheme,
  darkTheme,
  getAccentScheme,
} from "@/theme/colors";
import { borders } from "@/theme/tokens";
import type {
  ArchivePeriod,
  DayStatus,
  RepeatSchedule,
  ScheduleHistoryEntry,
} from "@/types/habit";
import { getWeekdayLabels } from "@/utils/date";
import { isDateInArchiveHistory } from "@/domain/habits/archive-periods";
import {
  createHabitScheduleMatcher,
  getEarliestScheduleStartDate,
} from "@/domain/habits/schedule";
import { useCurrentLocalDate } from "@/hooks/useCurrentLocalDate";
import { getDatePickerMonthModel } from "@/features/habit-form/utils/date-picker-month-model";
interface DayData {
  date: string;
  status: DayStatus | null;
  isArchived: boolean;
}
interface MonthCalendarProps {
  dayData: DayData[];
  startDate: string;
  repeatSchedule: RepeatSchedule;
  scheduleHistory?: ScheduleHistoryEntry[];
  isHabitArchived: boolean;
  archiveHistory: ArchivePeriod[];
  onDayPress: (date: string) => void;
  onDayLongPress: (date: string, pageX: number, pageY: number) => void;
}
function getDayCellColor(
  status: DayStatus | null,
  isArchived: boolean,
  isDark: boolean,
): string {
  if (isArchived) return isDark ? "#5F5F5F" : "#B8B8B8";
  if (!status) return "transparent";
  switch (status) {
    case "done":
      // Heatmap-aligned intensity: medium green for regular completion.
      return "#26A641";
    case "minimum":
      // Weakest positive signal (below regular done).
      return isDark ? "#0E4429" : "#1E5B3A";
    case "maximum":
      // Strongest positive signal, same direction as statistics heatmap.
      return "#39D353";
    case "skipped":
      return isDark ? darkTheme.neutral : lightTheme.neutral;
    case "failure":
      return semantic.failure;
    default:
      return "transparent";
  }
}
interface CalendarDayCellProps {
  dateStr: string;
  dayNumber: number;
  status: DayStatus | null;
  isArchivedPeriod: boolean;
  isBeforeStart: boolean;
  isFutureDay: boolean;
  isTodayDay: boolean;
  isScheduled: boolean;
  hasExistingStatus: boolean;
  isInteractionDisabled: boolean;
  isDark: boolean;
  accessibilityLabel: string;
  emptyCellBg: string;
  emptyCellBorder: string;
  monthTextColor: string;
  accent: string;
  onDayPress: (date: string) => void;
  onDayLongPress: (date: string, pageX: number, pageY: number) => void;
}
const CalendarDayCell = React.memo(function CalendarDayCell({
  dateStr,
  dayNumber,
  status,
  isArchivedPeriod,
  isBeforeStart,
  isFutureDay,
  isTodayDay,
  isScheduled,
  hasExistingStatus,
  isInteractionDisabled,
  isDark,
  accessibilityLabel,
  emptyCellBg,
  emptyCellBorder,
  monthTextColor,
  accent,
  onDayPress,
  onDayLongPress,
}: CalendarDayCellProps) {
  const statusBgColor =
    isBeforeStart || isFutureDay
      ? "transparent"
      : getDayCellColor(status, isArchivedPeriod, isDark);
  const useNeutralCell = statusBgColor === "transparent";
  const showTodayBorder = isTodayDay && useNeutralCell;
  return (
    <Pressable
      cssInterop={false}
      onPress={() => {
        if (isInteractionDisabled) return;
        onDayPress(dateStr);
      }}
      onLongPress={(event) => {
        if (isInteractionDisabled || !isScheduled) return;
        onDayLongPress(
          dateStr,
          event.nativeEvent.pageX,
          event.nativeEvent.pageY,
        );
      }}
      delayLongPress={180}
      style={{
        width: "14.28%",
        height: 38,
        alignItems: "center",
        justifyContent: "center",
      }}
      disabled={isInteractionDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: isInteractionDisabled }}
    >
      <View
        cssInterop={false}
        style={{
          width: "90%",
          height: 34,
          borderRadius: 6,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: useNeutralCell ? emptyCellBg : statusBgColor,
          borderWidth: showTodayBorder ? borders.todayIndicator : 0.5,
          borderColor: showTodayBorder ? accent : emptyCellBorder,
          opacity:
            isBeforeStart || isFutureDay || (!isScheduled && !hasExistingStatus)
              ? 0.35
              : 1,
        }}
      >
        <Text
          cssInterop={false}
          style={{
            fontSize: 14,
            fontWeight: "500",
            color: useNeutralCell ? monthTextColor : "#FFFFFF",
          }}
        >
          {dayNumber}
        </Text>
      </View>
    </Pressable>
  );
});
export const MonthCalendar = React.memo(function MonthCalendar({
  dayData,
  startDate,
  repeatSchedule,
  scheduleHistory,
  isHabitArchived,
  archiveHistory,
  onDayPress,
  onDayLongPress,
}: MonthCalendarProps) {
  const { t } = useTranslation();
  const language = useVisualLanguage();
  const effectiveMode = useVisualEffectiveMode();
  const colorScheme = useVisualColorScheme();
  const todayDate = useCurrentLocalDate();
  const today = useMemo(() => parseISO(todayDate), [todayDate]);
  const isDark = effectiveMode === "dark";
  const weekdays = getWeekdayLabels(language);
  const accent = getAccentScheme(colorScheme).base;
  const monthTextColor = isDark ? darkTheme.primary : lightTheme.primary;
  const mutedTextColor = isDark ? darkTheme.muted : lightTheme.muted;
  const emptyCellBg = isDark ? "#303030" : "#F5F5F5";
  const emptyCellBorder = isDark ? "#6D6D6D" : "#E3E3E3";
  const cardBackgroundColor = isDark ? "#262626" : lightTheme.surfaceElevated;
  const sectionHeaderBackgroundColor = isDark ? "#2F2F2F" : lightTheme.surface;
  const cardBorderColor = isDark ? "#5F5F5F" : lightTheme.border;
  const sectionDividerColor = isDark ? "#6B6B6B" : lightTheme.divider;
  const dayCellOuterHeight = 38;
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(today));
  const currentMonthRef = useRef(currentMonth);
  currentMonthRef.current = currentMonth;
  const onDayPressRef = useRef(onDayPress);
  const onDayLongPressRef = useRef(onDayLongPress);
  onDayPressRef.current = onDayPress;
  onDayLongPressRef.current = onDayLongPress;
  const handleCellPress = useCallback((date: string) => {
    onDayPressRef.current(date);
  }, []);
  const handleCellLongPress = useCallback(
    (date: string, pageX: number, pageY: number) => {
      onDayLongPressRef.current(date, pageX, pageY);
    },
    [],
  );
  // Home warms this immutable month model while idle. Reusing it here avoids
  // rebuilding and relocalizing every calendar date during the first habit
  // detail frame, while preserving the exact same number of native cells.
  const monthModel = useMemo(
    () => getDatePickerMonthModel(currentMonth, language).model,
    [currentMonth, language],
  );
  const { dataMap, scheduleRecords } = useMemo(() => {
    const nextDataMap = new Map<string, DayData>();
    const nextScheduleRecords: (DayData & {
      status: DayStatus;
    })[] = [];
    for (const item of dayData) {
      nextDataMap.set(item.date, item);
      if (item.status != null) {
        nextScheduleRecords.push({ ...item, status: item.status });
      }
    }
    return {
      dataMap: nextDataMap,
      scheduleRecords: nextScheduleRecords,
    };
  }, [dayData]);
  const isScheduledForDate = useMemo(
    () =>
      createHabitScheduleMatcher(
        repeatSchedule,
        startDate,
        scheduleRecords,
        scheduleHistory,
      ),
    [repeatSchedule, scheduleHistory, scheduleRecords, startDate],
  );
  const habitStartDate = getEarliestScheduleStartDate(
    startDate,
    scheduleHistory,
  );
  const currentCalendarMonth = startOfMonth(today);
  const isNextMonthDisabled = currentMonth >= currentCalendarMonth;
  const calendar = (
    <View
      className="mx-[14px] mt-[10px] overflow-hidden rounded-section-card border border-border"
      style={{
        backgroundColor: cardBackgroundColor,
        borderColor: cardBorderColor,
        borderWidth: 0.5,
      }}
    >
      <View
        className="flex-row items-center justify-between border-b border-divider px-md py-sm"
        style={{
          backgroundColor: sectionHeaderBackgroundColor,
          borderBottomColor: sectionDividerColor,
          borderBottomWidth: 0.5,
        }}
      >
        <Pressable
          onPress={() => {
            const nextMonth = subMonths(currentMonthRef.current, 1);
            currentMonthRef.current = nextMonth;
            setCurrentMonth(nextMonth);
          }}
          accessibilityRole="button"
          accessibilityLabel={t("datePicker.previousMonth")}
          className="items-center justify-center"
          style={{ width: 24, height: 24 }}
          hitSlop={10}
        >
          <MaterialIcons name="chevron-left" size={18} color={monthTextColor} />
        </Pressable>

        <Text
          className="text-primary font-semibold"
          style={{ fontSize: 16, transform: [{ translateY: -1 }] }}
        >
          {monthModel.label}
        </Text>

        <Pressable
          onPress={() => {
            if (isNextMonthDisabled) return;
            const nextMonth = addMonths(currentMonthRef.current, 1);
            if (nextMonth > currentCalendarMonth) {
              return;
            }
            currentMonthRef.current = nextMonth;
            setCurrentMonth(nextMonth);
          }}
          disabled={isNextMonthDisabled}
          accessibilityRole="button"
          accessibilityLabel={t("datePicker.nextMonth")}
          accessibilityState={{ disabled: isNextMonthDisabled }}
          className="items-center justify-center"
          style={{
            width: 24,
            height: 24,
            opacity: isNextMonthDisabled ? 0.35 : 1,
          }}
          hitSlop={10}
        >
          <MaterialIcons
            name="chevron-right"
            size={18}
            color={monthTextColor}
          />
        </Pressable>
      </View>

      <View className="flex-row px-sm pb-xs pt-sm">
        {weekdays.map((wd) => (
          <View key={wd} className="flex-1 items-center">
            <Text className="text-xs" style={{ color: mutedTextColor }}>
              {wd}
            </Text>
          </View>
        ))}
      </View>

      <View className="flex-row flex-wrap px-sm pb-sm">
        {monthModel.gridSlots.slice(0, monthModel.offset).map((slot) => (
          <View
            key={slot.key}
            style={{ width: "14.28%", height: dayCellOuterHeight }}
          />
        ))}

        {monthModel.days.map((day) => {
          const dateStr = day.dateString;
          const data = dataMap.get(dateStr);
          const isBeforeStart = dateStr < habitStartDate;
          const isFutureDay = dateStr > todayDate;
          const isTodayDay = dateStr === todayDate;
          const isArchivedPeriod = isDateInArchiveHistory(
            dateStr,
            archiveHistory,
          );
          const isScheduled = isScheduledForDate(dateStr);
          const hasExistingStatus = data?.status != null;
          const isReadOnlyDay = isHabitArchived || isArchivedPeriod;
          const isInteractionDisabled =
            isBeforeStart ||
            isFutureDay ||
            isReadOnlyDay ||
            (!isScheduled && !hasExistingStatus);
          return (
            <CalendarDayCell
              key={`day-${day.dayNumber}`}
              dateStr={dateStr}
              dayNumber={day.dayNumber}
              status={data?.status ?? null}
              isArchivedPeriod={isArchivedPeriod}
              isBeforeStart={isBeforeStart}
              isFutureDay={isFutureDay}
              isTodayDay={isTodayDay}
              isScheduled={isScheduled}
              hasExistingStatus={hasExistingStatus}
              isInteractionDisabled={isInteractionDisabled}
              isDark={isDark}
              accessibilityLabel={`${day.accessibilityLabel}, ${t(`accessibility.habitStatus.${data?.status ?? "unmarked"}`)}`}
              emptyCellBg={emptyCellBg}
              emptyCellBorder={emptyCellBorder}
              monthTextColor={monthTextColor}
              accent={accent}
              onDayPress={handleCellPress}
              onDayLongPress={handleCellLongPress}
            />
          );
        })}
      </View>
    </View>
  );
  return calendar;
});
