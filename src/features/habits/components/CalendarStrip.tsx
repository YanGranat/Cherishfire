import React, {
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  ScrollView,
  View,
  Text,
  Pressable,
  type LayoutChangeEvent,
} from "react-native";
import { addDays } from "date-fns/addDays";
import { format } from "date-fns/format";
import { getDay } from "date-fns/getDay";
import { parseISO } from "date-fns/parseISO";
import { subDays } from "date-fns/subDays";
import { MAIN_CALENDAR_FUTURE_DAYS } from "@/features/habits/constants";
import {
  useVisualColorScheme,
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { getAccentScheme, lightTheme } from "@/theme/colors";
import { sizes } from "@/theme/tokens";
import { formatLocalizedDate, getWeekdayLabels } from "@/utils/date";
interface CalendarStripProps {
  selectedDate: string; // ISO YYYY-MM-DD
  todayDate: string;
  onSelectDate: (date: string) => void;
}
export interface CalendarStripHandle {
  revealToday(): void;
  cancelPendingTodayReveal(): void;
}
const DAYS_TO_SHOW = 30; // buffer for scrolling
const VISIBLE_DAYS = 8;
type CalendarDateMeta = {
  date: Date;
  dateStr: string;
  dayNum: string;
  isTodayDate: boolean;
  mondayWeekdayIndex: number;
};
// Recompute day metadata only when the tracked local date rolls over.
function generateDateMeta(todayDate: string): CalendarDateMeta[] {
  const today = parseISO(todayDate);
  const dates: CalendarDateMeta[] = [];
  for (
    let offset = -DAYS_TO_SHOW;
    offset <= MAIN_CALENDAR_FUTURE_DAYS;
    offset += 1
  ) {
    const date = offset < 0 ? subDays(today, -offset) : addDays(today, offset);
    dates.push({
      date,
      dateStr: format(date, "yyyy-MM-dd"),
      dayNum: format(date, "d"),
      isTodayDate: offset === 0,
      mondayWeekdayIndex: (() => {
        const jsDay = getDay(date); // Sun=0 ... Sat=6
        return jsDay === 0 ? 6 : jsDay - 1; // Mon=0 ... Sun=6
      })(),
    });
  }
  return dates;
}
function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
// Pick readable foreground for the selected date circle based on accent luminance.
function getReadableTextColor(hex: string): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#111111" : "#FFFFFF";
}
const CALENDAR_CELL_WIDTH = sizes.calendarStripDayWidth + 8; // width + gap
type CalendarDayCellProps = {
  meta: CalendarDateMeta;
  isSelected: boolean;
  weekday: string;
  accentBase: string;
  isDarkTheme: boolean;
  weekdayColor: string;
  selectedWeekdayColor: string;
  selectedTextColor: string;
  dayNumberColor: string;
  accessibilityLabel: string;
  onSelectDate: (date: string) => void;
};
const CalendarDayCell = React.memo(
  function CalendarDayCell({
    meta,
    isSelected,
    weekday,
    accentBase,
    isDarkTheme,
    weekdayColor,
    selectedWeekdayColor,
    selectedTextColor,
    dayNumberColor,
    accessibilityLabel,
    onSelectDate,
  }: CalendarDayCellProps) {
    return (
      <Pressable
        onPress={() => {
          onSelectDate(meta.dateStr);
        }}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ selected: isSelected }}
        style={{
          width: sizes.calendarStripDayWidth,
          height: sizes.calendarStripDayHeight + 4,
          alignItems: "center",
          justifyContent: "flex-start",
          marginHorizontal: 4,
          paddingTop: 2,
        }}
      >
        <Text
          style={[
            {
              fontSize: 12,
              color: isSelected ? selectedWeekdayColor : weekdayColor,
            },
            meta.isTodayDate && !isSelected
              ? { fontWeight: "700" }
              : { fontWeight: "400" },
          ]}
        >
          {weekday}
        </Text>

        <View style={{ height: 6 }} />

        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: isSelected
              ? accentBase
              : meta.isTodayDate
                ? hexToRgba(accentBase, isDarkTheme ? 0.24 : 0.16)
                : "transparent",
            overflow: "hidden",
          }}
        >
          <Text
            style={[
              {
                fontSize: 15,
                fontWeight: "500",
                color: isSelected ? selectedTextColor : dayNumberColor,
              },
              meta.isTodayDate && !isSelected ? { fontWeight: "700" } : {},
            ]}
          >
            {meta.dayNum}
          </Text>
        </View>
      </Pressable>
    );
  },
  (prev, next) =>
    prev.meta === next.meta &&
    prev.isSelected === next.isSelected &&
    prev.weekday === next.weekday &&
    prev.accentBase === next.accentBase &&
    prev.isDarkTheme === next.isDarkTheme &&
    prev.weekdayColor === next.weekdayColor &&
    prev.selectedWeekdayColor === next.selectedWeekdayColor &&
    prev.selectedTextColor === next.selectedTextColor &&
    prev.dayNumberColor === next.dayNumberColor &&
    prev.accessibilityLabel === next.accessibilityLabel &&
    prev.onSelectDate === next.onSelectDate,
);
function CalendarStripComponent(
  { selectedDate, todayDate, onSelectDate }: CalendarStripProps,
  ref: React.ForwardedRef<CalendarStripHandle>,
) {
  const scrollRef = useRef<ScrollView>(null);
  const colorScheme = useVisualColorScheme();
  const language = useVisualLanguage();
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const accent = getAccentScheme(colorScheme);
  const weekdayColor = isDarkTheme ? "#9E9E9E" : lightTheme.muted;
  const selectedWeekdayColor = isDarkTheme ? accent.pale : accent.bright;
  const selectedTextColor = getReadableTextColor(accent.base);
  const dayNumberColor = isDarkTheme ? "#E8E7E7" : lightTheme.primary;
  const weekdayLabels = getWeekdayLabels(language);
  const dateMeta = useMemo(() => generateDateMeta(todayDate), [todayDate]);
  const todayIndex = dateMeta.findIndex((meta) => meta.isTodayDate);
  const initialOffset = Math.max(
    0,
    (todayIndex - VISIBLE_DAYS + 2) * CALENDAR_CELL_WIDTH,
  );
  const onSelectDateRef = useRef(onSelectDate);
  const pendingTodayRevealRef = useRef(false);
  useLayoutEffect(() => {
    onSelectDateRef.current = onSelectDate;
  }, [onSelectDate]);
  const handleSelectDate = useCallback((date: string) => {
    pendingTodayRevealRef.current = false;
    onSelectDateRef.current(date);
  }, []);
  // Use onLayout to scroll immediately when the ScrollView is first laid out
  const hasScrolled = useRef(false);
  const viewportReadyRef = useRef(false);
  const contentReadyRef = useRef(false);
  const scrollCommandRevisionRef = useRef(0);
  const flushPendingTodayReveal = useCallback(() => {
    if (!pendingTodayRevealRef.current) return false;
    if (!viewportReadyRef.current || !contentReadyRef.current) return false;
    const scroll = scrollRef.current;
    if (!scroll) return false;
    pendingTodayRevealRef.current = false;
    hasScrolled.current = true;
    scroll.scrollToEnd({ animated: false });
    return true;
  }, []);
  React.useImperativeHandle(
    ref,
    () => ({
      revealToday() {
        scrollCommandRevisionRef.current += 1;
        pendingTodayRevealRef.current = true;
        flushPendingTodayReveal();
      },
      cancelPendingTodayReveal() {
        pendingTodayRevealRef.current = false;
      },
    }),
    [flushPendingTodayReveal],
  );
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const width = event.nativeEvent.layout.width;
      if (!Number.isFinite(width) || width <= 0) return;
      viewportReadyRef.current = true;
      if (pendingTodayRevealRef.current) {
        flushPendingTodayReveal();
        return;
      }
      if (!hasScrolled.current) {
        hasScrolled.current = true;
        scrollRef.current?.scrollTo({ x: initialOffset, animated: false });
      }
    },
    [flushPendingTodayReveal, initialOffset],
  );
  const handleContentSizeChange = useCallback(
    (width: number) => {
      if (!Number.isFinite(width) || width <= 0) return;
      contentReadyRef.current = true;
      flushPendingTodayReveal();
    },
    [flushPendingTodayReveal],
  );
  useEffect(() => {
    const scheduledRevision = scrollCommandRevisionRef.current;
    hasScrolled.current = false;
    requestAnimationFrame(() => {
      if (scrollCommandRevisionRef.current !== scheduledRevision) return;
      hasScrolled.current = true;
      scrollRef.current?.scrollTo({ x: initialOffset, animated: false });
    });
  }, [initialOffset, todayDate]);
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 8 }}
      contentOffset={{ x: initialOffset, y: 0 }}
      onLayout={handleLayout}
      onContentSizeChange={handleContentSizeChange}
      style={{ paddingTop: 4, paddingBottom: 8 }}
    >
      {dateMeta.map((meta) => {
        return (
          <CalendarDayCell
            key={meta.dateStr}
            meta={meta}
            isSelected={meta.dateStr === selectedDate}
            weekday={weekdayLabels[meta.mondayWeekdayIndex]}
            accentBase={accent.base}
            isDarkTheme={isDarkTheme}
            weekdayColor={weekdayColor}
            selectedWeekdayColor={selectedWeekdayColor}
            selectedTextColor={selectedTextColor}
            dayNumberColor={dayNumberColor}
            accessibilityLabel={formatLocalizedDate(meta.dateStr, language)}
            onSelectDate={handleSelectDate}
          />
        );
      })}
    </ScrollView>
  );
}
export const CalendarStrip = React.memo(
  React.forwardRef(CalendarStripComponent),
);
