/** @jsxImportSource nativewind */
import React from "react";
import {
  StyleSheet,
  View,
  Text,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useTranslation } from "react-i18next";
import {
  useVisualColorScheme,
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import {
  getAccentScheme,
  heatmapLevels,
  darkTheme,
  lightTheme,
} from "@/theme/colors";
import { sizes } from "@/theme/tokens";
import { getWeekdayLabels } from "@/utils/date";
import { buildYearHeatmapPathLayout } from "@/features/statistics/utils/year-heatmap-paths";
import { createScheduleDateFacts } from "@/domain/habits/schedule";
interface HeatmapCell {
  date: string;
  score: number; // positive = green, negative = red, 0 = neutral
}
interface HeatmapProps {
  data: HeatmapCell[];
  period: "week" | "month" | "year";
  todayStr: string;
}
const CALENDAR_CELL_WIDTH = `${100 / 7}%` as `${number}%`;
const styles = StyleSheet.create({
  calendarCellFrame: {
    width: CALENDAR_CELL_WIDTH,
    padding: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  calendarCellFill: {
    width: "100%",
    height: "100%",
    borderRadius: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  transparentCell: {
    backgroundColor: "transparent",
  },
  activeDateText: {
    fontSize: 12,
    color: "#FFFFFF",
  },
  neutralDateText: {
    fontSize: 12,
  },
});
const EMPTY_CALENDAR_CELL_STYLE = StyleSheet.compose(
  styles.calendarCellFill,
  styles.transparentCell,
);
// Convert an aggregate completion score to the shared heatmap scale.
function scoreToColor(score: number, isDark: boolean): string {
  const levels = isDark ? heatmapLevels.dark : heatmapLevels.light;
  if (score >= 1.5) return levels[4];
  if (score >= 0.9) return levels[3];
  if (score >= 0.4) return levels[2];
  if (score > 0) return levels[1];
  if (score === 0) return levels[0];
  // Red intensity should scale proportionally with uncovered red ratio:
  // about 25% -> light red, ~50% -> medium red, ~75% -> strong red, 100% -> max red.
  if (score > -1) return levels["-1"];
  if (score > -2) return levels["-2"];
  if (score > -3) return levels["-3"];
  return levels["-4"];
}
// Month uses a calendar grid; year uses a compact continuous cell grid.
// A custom View grid avoids a chart-library dependency for calendar cells.
export function Heatmap({ data, period, todayStr }: HeatmapProps) {
  const { t } = useTranslation();
  const language = useVisualLanguage();
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const { width: windowWidth } = useWindowDimensions();
  const isDark = effectiveMode === "dark";
  const weekdays = React.useMemo(() => getWeekdayLabels(language), [language]);
  const accent = getAccentScheme(colorScheme).base;
  const cardBackgroundColor = isDark ? "#262626" : lightTheme.surfaceElevated;
  const cardBorderColor = isDark ? "#5F5F5F" : lightTheme.border;
  const sectionHeaderBackgroundColor = isDark ? "#2F2F2F" : lightTheme.surface;
  const sectionDividerColor = isDark ? "#6B6B6B" : lightTheme.divider;
  const sectionTitleColor = isDark ? "#D8D8D8" : lightTheme.muted;
  const chartTextColor = isDark ? darkTheme.muted : lightTheme.muted;
  const cellSize =
    period === "year" ? sizes.heatmapCellYear : sizes.heatmapCellMonth;
  const gap = period === "year" ? 1 : 0;
  const sortedCalendarData = React.useMemo(() => {
    if (period === "year" || data.length === 0) return [];
    return [...data].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
    );
  }, [data, period]);
  const calendarGridCells = React.useMemo(() => {
    if (sortedCalendarData.length === 0) return [];
    if (period === "week") {
      return sortedCalendarData.map((cell) => ({ key: cell.date, cell }));
    }
    const leadingEmptyCount =
      createScheduleDateFacts(sortedCalendarData[0].date).isoWeekday - 1;
    const leading = Array.from({ length: leadingEmptyCount }, (_, i) => ({
      key: `leading-${i}`,
      cell: null as HeatmapCell | null,
    }));
    const cells = sortedCalendarData.map((cell) => ({ key: cell.date, cell }));
    const total = leading.length + cells.length;
    const trailingEmptyCount = (7 - (total % 7)) % 7;
    const trailing = Array.from({ length: trailingEmptyCount }, (_, i) => ({
      key: `trailing-${i}`,
      cell: null as HeatmapCell | null,
    }));
    return [...leading, ...cells, ...trailing];
  }, [period, sortedCalendarData]);
  const levels = isDark ? heatmapLevels.dark : heatmapLevels.light;
  // The legend is the exact nine-color scale used by scoreToColor.
  const legendColors = React.useMemo(
    () => [
      levels["-4"],
      levels["-3"],
      levels["-2"],
      levels["-1"],
      levels[0],
      levels[1],
      levels[2],
      levels[3],
      levels[4],
    ],
    [levels],
  );
  const calendarCellFrameStyle = React.useMemo(
    () => StyleSheet.compose(styles.calendarCellFrame, { height: cellSize }),
    [cellSize],
  );
  const calendarCellStylesByColor = React.useMemo(
    () =>
      new Map<string, StyleProp<ViewStyle>>(
        legendColors.map((color) => [
          color,
          StyleSheet.compose(styles.calendarCellFill, {
            backgroundColor: color,
          }),
        ]),
      ),
    [legendColors],
  );
  const yearCellColors = React.useMemo(
    () =>
      period === "year"
        ? data.map((cell) => scoreToColor(cell.score, isDark))
        : [],
    [data, isDark, period],
  );
  const yearHeatmapLayout = React.useMemo(
    () =>
      buildYearHeatmapPathLayout({
        colors: yearCellColors,
        // Grid content width is screen width minus 14dp card margins,
        // 0.5dp borders and 8dp content padding on both sides.
        availableWidth: windowWidth - 2 * (14 + 0.5 + 8),
        cellSize,
        gap,
        radius: 2,
      }),
    [cellSize, gap, windowWidth, yearCellColors],
  );
  const legendCellStyles = React.useMemo(() => {
    const legendCellSize = period === "year" ? 9 : 12;
    return legendColors.map((color) => ({
      width: legendCellSize,
      height: legendCellSize,
      backgroundColor: color,
    }));
  }, [legendColors, period]);
  const neutralDateTextStyle = React.useMemo(
    () => [styles.neutralDateText, { color: isDark ? "#747474" : "#8E8E8E" }],
    [isDark],
  );
  const weekdayAccentStyle = React.useMemo(
    () => ({ fontSize: 12, color: accent }),
    [accent],
  );
  const weekdayMutedStyle = React.useMemo(
    () => ({ fontSize: 12, color: chartTextColor }),
    [chartTextColor],
  );
  const todayWeekdayLabelIndex = React.useMemo(() => {
    if (period !== "week" || sortedCalendarData.length === 0) return -1;
    const todayIndex = sortedCalendarData.findIndex(
      (cell) => cell.date === todayStr,
    );
    return todayIndex >= 0 ? todayIndex : -1;
  }, [period, sortedCalendarData, todayStr]);
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
        <MaterialIcons
          name="calendar-month"
          size={15}
          color={sectionTitleColor}
        />
        <Text
          className="ml-[7px] text-xs font-semibold uppercase"
          style={{ color: sectionTitleColor }}
        >
          {t("statistics.activity")}
        </Text>
      </View>

      <View className="px-sm pb-sm pt-md">
        {/* Weekday labels for week/month view */}
        {period !== "year" ? (
          <View className="flex-row mb-xs">
            {weekdays.map((wd, index) => (
              <View key={wd} className="flex-1 items-center">
                <Text
                  style={
                    period === "week" && index === todayWeekdayLabelIndex
                      ? weekdayAccentStyle
                      : weekdayMutedStyle
                  }
                >
                  {wd}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Grid */}
        {period !== "year" ? (
          <View className="flex-row flex-wrap">
            {calendarGridCells.map((entry) => (
              <View
                key={entry.key}
                cssInterop={false}
                style={calendarCellFrameStyle}
              >
                <View
                  cssInterop={false}
                  style={
                    entry.cell
                      ? calendarCellStylesByColor.get(
                          scoreToColor(entry.cell.score, isDark),
                        )
                      : EMPTY_CALENDAR_CELL_STYLE
                  }
                >
                  {entry.cell ? (
                    <Text
                      cssInterop={false}
                      style={
                        entry.cell.score !== 0
                          ? styles.activeDateText
                          : neutralDateTextStyle
                      }
                    >
                      {entry.cell.date.split("-")[2].replace(/^0/, "")}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : (
          <Svg width="100%" height={yearHeatmapLayout.height}>
            {yearHeatmapLayout.groups.map((group) => (
              <Path key={group.color} d={group.path} fill={group.color} />
            ))}
          </Svg>
        )}

        <View className="mt-sm flex-row items-center justify-end pr-xs">
          <Text className="text-xs" style={{ color: chartTextColor }}>
            -
          </Text>
          {legendColors.map((color, index) => (
            <View
              key={index}
              className="ml-[3px] rounded-[2px]"
              style={legendCellStyles[index]}
            />
          ))}
          <Text className="ml-[4px] text-xs" style={{ color: chartTextColor }}>
            +
          </Text>
        </View>
      </View>
    </View>
  );
}
