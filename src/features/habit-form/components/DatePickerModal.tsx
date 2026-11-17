/** @jsxImportSource nativewind */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
  ScrollView,
} from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { addMonths } from "date-fns/addMonths";
import { format } from "date-fns/format";
import { subMonths } from "date-fns/subMonths";
import { useTranslation } from "react-i18next";
import {
  useVisualColorScheme,
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import {
  getAccentScheme,
  scrimColor,
  lightTheme,
  darkTheme,
} from "@/theme/colors";
import { radii, borders } from "@/theme/tokens";
import { AppModal } from "@/components/ui/AppModal";
import { formatCivilDate, getWeekdayLabels, toCivilDate } from "@/utils/date";
import { useCurrentLocalDate } from "@/hooks/useCurrentLocalDate";
import {
  getDatePickerMonthModel,
  prewarmAdjacentDatePickerMonthModels,
  type DatePickerDayModel,
} from "@/features/habit-form/utils/date-picker-month-model";
import { resolveDatePickerSelectionIntent } from "@/features/habit-form/utils/date-picker-selection-intent";
import { runWhenUiIsIdle } from "@/utils/ui-scheduling";
interface DatePickerModalProps {
  visible: boolean;
  preloadOnAndroid?: boolean;
  selectedDate: string;
  onConfirm: (date: string) => void;
  onCancel: () => void;
}
type DatePickerContentProps = Omit<DatePickerModalProps, "visible">;
const MONTH_NAVIGATION_TARGET_STYLE = {
  width: 44,
  height: 44,
  margin: -10,
  alignItems: "center",
  justifyContent: "center",
} as const;
const DATE_ACTION_TEXT_STYLE = {
  fontSize: 14,
  lineHeight: 20,
  fontWeight: "600",
} as const;
interface DatePickerSelectionDraft {
  getPickedDate: () => string;
  pickedDate: string;
  selectDay: (date: string) => void;
}
function useDatePickerSelectionDraft(
  selectedDate: string,
): DatePickerSelectionDraft {
  const [pickedDate, setPickedDate] = useState(selectedDate);
  const pickedDateRef = React.useRef(selectedDate);
  const renderedPickedDateRef = React.useRef(selectedDate);
  const getPickedDate = useCallback(() => pickedDateRef.current, []);
  const selectDay = useCallback((date: string) => {
    const resolution = resolveDatePickerSelectionIntent(
      pickedDateRef.current,
      renderedPickedDateRef.current,
      date,
    );
    if (resolution.draftChanged) {
      pickedDateRef.current = date;
    }
    if (resolution.publishSelection) setPickedDate(date);
  }, []);
  useLayoutEffect(() => {
    renderedPickedDateRef.current = pickedDate;
  }, [pickedDate]);
  return useMemo(
    () => ({
      getPickedDate,
      pickedDate,
      selectDay,
    }),
    [getPickedDate, pickedDate, selectDay],
  );
}
interface DatePickerDayCellProps {
  accent: string;
  textColor: string;
  day: DatePickerDayModel | null;
  isSelected: boolean;
  isTodayDate: boolean;
  onSelectDay: (date: string) => void;
}
const DatePickerDayCell = React.memo(function DatePickerDayCell({
  accent,
  textColor,
  day,
  isSelected,
  isTodayDate,
  onSelectDay,
}: DatePickerDayCellProps) {
  const dateString = day?.dateString ?? null;
  const handlePress = useCallback(() => {
    if (dateString == null) return;
    onSelectDay(dateString);
  }, [dateString, onSelectDay]);
  const dayElement = (
    <Pressable
      cssInterop={false}
      onPress={dateString == null ? undefined : handlePress}
      disabled={dateString == null}
      accessible={dateString != null}
      accessibilityElementsHidden={dateString == null}
      accessibilityRole={dateString == null ? undefined : "button"}
      accessibilityLabel={day?.accessibilityLabel}
      accessibilityState={
        dateString == null ? undefined : { selected: isSelected }
      }
      importantForAccessibility={
        dateString == null ? "no-hide-descendants" : "yes"
      }
      style={{
        width: "14.28%",
        height: 40,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {day ? (
        <View
          cssInterop={false}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: isSelected ? accent : "transparent",
            borderWidth:
              isTodayDate && !isSelected ? borders.todayIndicator : 0,
            borderColor: isTodayDate && !isSelected ? accent : "transparent",
          }}
        >
          <Text
            cssInterop={false}
            style={{ fontSize: 14, color: isSelected ? "#FFFFFF" : textColor }}
          >
            {day.dayLabel}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
  return dayElement;
});
interface DatePickerSelectedHeaderProps {
  accent: string;
  language: string;
  pickedDate: string;
}
const DatePickerSelectedHeader = React.memo(function DatePickerSelectedHeader({
  accent,
  language,
  pickedDate,
}: DatePickerSelectedHeaderProps) {
  const pickedLabel = useMemo(
    () => formatCivilDate(pickedDate, "EEE, d MMM", language),
    [language, pickedDate],
  );
  return (
    <View
      style={{
        backgroundColor: accent,
        paddingHorizontal: 16,
        paddingVertical: 14,
      }}
    >
      <Text className="text-white text-xl font-semibold">{pickedLabel}</Text>
    </View>
  );
});
const DatePickerWeekdayHeader = React.memo(function DatePickerWeekdayHeader({
  weekdays,
}: {
  weekdays: readonly string[];
}) {
  return (
    <View className="flex-row px-sm">
      {weekdays.map((weekday) => (
        <View key={weekday} className="flex-1 items-center py-xs">
          <Text className="text-muted text-xs">{weekday}</Text>
        </View>
      ))}
    </View>
  );
});
interface DatePickerCalendarPaneProps {
  accent: string;
  textColor: string;
  language: string;
  nextMonthLabel: string;
  paletteIcon: string;
  previousMonthLabel: string;
  selectedDate: string;
  pickedDate: string;
  today: string;
  onSelectDay: (date: string) => void;
  weekdays: readonly string[];
}
const DatePickerCalendarPane = React.memo(function DatePickerCalendarPane({
  accent,
  textColor,
  language,
  nextMonthLabel,
  paletteIcon,
  previousMonthLabel,
  selectedDate,
  pickedDate,
  today,
  onSelectDay,
  weekdays,
}: DatePickerCalendarPaneProps) {
  const [currentMonth, setCurrentMonth] = useState(
    () => `${selectedDate.slice(0, 7)}-01`,
  );
  const currentMonthRef = React.useRef(currentMonth);
  const monthModelLookup = useMemo(
    () => getDatePickerMonthModel(currentMonth, language),
    [currentMonth, language],
  );
  const monthModel = monthModelLookup.model;
  useEffect(() => {
    const task = runWhenUiIsIdle(() => {
      prewarmAdjacentDatePickerMonthModels(currentMonth, language);
    });
    return () => task.cancel();
  }, [currentMonth, language]);
  const showPreviousMonth = useCallback(() => {
    const previousMonth = subMonths(toCivilDate(currentMonthRef.current), 1);
    const nextMonth =
      previousMonth.getUTCFullYear() < 1
        ? currentMonthRef.current
        : format(previousMonth, "yyyy-MM-dd");
    currentMonthRef.current = nextMonth;
    setCurrentMonth(nextMonth);
  }, []);
  const showNextMonth = useCallback(() => {
    const followingMonth = addMonths(toCivilDate(currentMonthRef.current), 1);
    const nextMonth =
      followingMonth.getUTCFullYear() > 9999
        ? currentMonthRef.current
        : format(followingMonth, "yyyy-MM-dd");
    currentMonthRef.current = nextMonth;
    setCurrentMonth(nextMonth);
  }, []);
  return (
    <>
      <View
        className="flex-row items-center justify-between px-base"
        style={{ paddingVertical: 10, marginVertical: -2 }}
      >
        <Pressable
          onPress={showPreviousMonth}
          accessibilityRole="button"
          accessibilityLabel={previousMonthLabel}
          className="active:opacity-60"
          style={MONTH_NAVIGATION_TARGET_STYLE}
        >
          <MaterialIcons name="chevron-left" size={24} color={paletteIcon} />
        </Pressable>
        <Text className="text-primary font-semibold">{monthModel.label}</Text>
        <Pressable
          onPress={showNextMonth}
          accessibilityRole="button"
          accessibilityLabel={nextMonthLabel}
          className="active:opacity-60"
          style={MONTH_NAVIGATION_TARGET_STYLE}
        >
          <MaterialIcons name="chevron-right" size={24} color={paletteIcon} />
        </Pressable>
      </View>

      <DatePickerWeekdayHeader weekdays={weekdays} />

      <View className="flex-row flex-wrap px-sm pb-sm">
        {monthModel.gridSlots.map((slot) => (
          <DatePickerDayCell
            key={slot.key}
            accent={accent}
            textColor={textColor}
            day={slot.day}
            isSelected={slot.day?.dateString === pickedDate}
            isTodayDate={slot.day?.dateString === today}
            onSelectDay={onSelectDay}
          />
        ))}
      </View>
    </>
  );
});
function DatePickerContent({
  selectedDate,
  onConfirm,
  onCancel,
}: DatePickerContentProps) {
  const { t } = useTranslation();
  const language = useVisualLanguage();
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  const accent = getAccentScheme(colorScheme).base;
  const weekdays = getWeekdayLabels(language);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const selection = useDatePickerSelectionDraft(selectedDate);
  const today = useCurrentLocalDate();
  return (
    <Pressable
      className="flex-1 items-center justify-center"
      style={{ backgroundColor: scrimColor }}
      onPress={() => {
        onCancel();
      }}
    >
      <Pressable onPress={(event) => event.stopPropagation()}>
        <View
          className="bg-surface-elevated"
          style={{
            width: Math.min(320, windowWidth - 24),
            maxHeight: windowHeight - 48,
            borderRadius: radii.dialog,
            overflow: "hidden",
          }}
        >
          <ScrollView
            style={{ flexShrink: 1 }}
            showsVerticalScrollIndicator={false}
          >
            <DatePickerSelectedHeader
              accent={accent}
              language={language}
              pickedDate={selection.pickedDate}
            />

            <DatePickerCalendarPane
              accent={accent}
              textColor={palette.primary}
              language={language}
              nextMonthLabel={t("datePicker.nextMonth")}
              paletteIcon={palette.icon}
              pickedDate={selection.pickedDate}
              today={today}
              previousMonthLabel={t("datePicker.previousMonth")}
              selectedDate={selectedDate}
              onSelectDay={selection.selectDay}
              weekdays={weekdays}
            />

            {/* Action buttons */}
            <View className="flex-row justify-end px-base pb-base gap-sm">
              <Pressable
                onPress={() => {
                  onCancel();
                }}
                className="px-md py-sm active:opacity-60"
              >
                <Text className="text-muted" style={DATE_ACTION_TEXT_STYLE}>
                  {t("datePicker.cancel")}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  onConfirm(selection.getPickedDate());
                }}
                className="px-md py-sm active:opacity-60"
              >
                <Text
                  style={[DATE_ACTION_TEXT_STYLE, { color: accent }]}
                >
                  {t("datePicker.ok")}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </Pressable>
    </Pressable>
  );
}
export function DatePickerModal({
  visible,
  preloadOnAndroid = false,
  selectedDate,
  onConfirm,
  onCancel,
}: DatePickerModalProps) {
  return (
    <AppModal
      visible={visible}
      keepMountedOnAndroid={preloadOnAndroid}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => {
        onCancel();
        return true;
      }}
    >
      {visible ? (
        <DatePickerContent
          selectedDate={selectedDate}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </AppModal>
  );
}
