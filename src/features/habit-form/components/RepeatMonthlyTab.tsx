/** @jsxImportSource nativewind */
import React, { useCallback } from "react";
import { View, Text, Pressable, useWindowDimensions } from "react-native";
import { getAccentScheme } from "@/theme/colors";
import { useVisualColorScheme } from "@/components/ScreenPreferencesBoundary";
import {
  canToggleMonthlyDate,
  isMonthlyDateSelected,
  type MonthlyDateDraftStore,
} from "@/features/habit-form/utils/monthly-date-draft";
interface RepeatMonthlyTabProps {
  dateDraft: MonthlyDateDraftStore;
}
const DATES = Array.from({ length: 31 }, (_, index) => index + 1);
const COLUMNS = 7;
const ROW_COUNT = Math.ceil(DATES.length / COLUMNS);
const CELL_GAP = 8;
const HORIZONTAL_SAFE_PADDING = 32;
const MAX_CELL = 40;
const MIN_CELL = 34;
const DATE_ROWS = Array.from({ length: ROW_COUNT }, (_, rowIndex) =>
  Array.from({ length: COLUMNS }, (_, columnIndex) => {
    const dateIndex = rowIndex * COLUMNS + columnIndex;
    return dateIndex < DATES.length ? DATES[dateIndex] : null;
  }),
);
interface RepeatMonthDateCellProps {
  accent: string;
  cellSize: number;
  date: number;
  dateDraft: MonthlyDateDraftStore;
  isLastColumn: boolean;
}
const RepeatMonthDateCell = React.memo(function RepeatMonthDateCell({
  accent,
  cellSize,
  date,
  dateDraft,
  isLastColumn,
}: RepeatMonthDateCellProps) {
  const subscribe = useCallback(
    (listener: () => void) => dateDraft.subscribeDate(date, listener),
    [date, dateDraft],
  );
  const getSnapshot = useCallback(
    () => dateDraft.getCellSnapshot(date),
    [date, dateDraft],
  );
  const cellSnapshot = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  const isSelected = isMonthlyDateSelected(cellSnapshot);
  const canToggle = canToggleMonthlyDate(cellSnapshot);
  const handlePress = useCallback(() => {
    dateDraft.toggleDate(date);
  }, [date, dateDraft]);
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="checkbox"
      accessibilityLabel={date.toString()}
      accessibilityState={{ checked: isSelected, disabled: !canToggle }}
      disabled={!canToggle}
      className="items-center justify-center"
      style={{
        width: cellSize,
        height: cellSize,
        marginRight: isLastColumn ? 0 : CELL_GAP,
        borderRadius: 8,
        backgroundColor: isSelected ? accent : "transparent",
      }}
    >
      <Text
        className={isSelected ? "text-white" : "text-primary"}
        style={{ fontSize: 14, fontWeight: "500" }}
      >
        {date}
      </Text>
    </Pressable>
  );
});
// The date grid retains at least one selected date.
export const RepeatMonthlyTab = React.memo(function RepeatMonthlyTab({
  dateDraft,
}: RepeatMonthlyTabProps) {
  const colorScheme = useVisualColorScheme();
  const accent = getAccentScheme(colorScheme).base;
  const { width: windowWidth } = useWindowDimensions();
  const availableWidth = Math.max(0, windowWidth - HORIZONTAL_SAFE_PADDING);
  const dynamicCell = Math.floor(
    (availableWidth - CELL_GAP * (COLUMNS - 1)) / COLUMNS,
  );
  const cellSize = Math.max(
    MIN_CELL,
    Math.min(MAX_CELL, dynamicCell || MAX_CELL),
  );
  const gridWidth = cellSize * COLUMNS + CELL_GAP * (COLUMNS - 1);
  return (
    <View className="pt-sm pb-sm items-center">
      <View style={{ width: gridWidth }}>
        {DATE_ROWS.map((rowCells, rowIndex) => {
          return (
            <View
              key={`row-${rowIndex}`}
              className="flex-row"
              style={{
                marginBottom: rowIndex === ROW_COUNT - 1 ? 0 : CELL_GAP,
              }}
            >
              {rowCells.map((date, colIndex) => {
                if (date == null) {
                  return (
                    <View
                      key={`empty-${rowIndex}-${colIndex}`}
                      style={{
                        width: cellSize,
                        height: cellSize,
                        marginRight: colIndex === COLUMNS - 1 ? 0 : CELL_GAP,
                      }}
                    />
                  );
                }
                return (
                  <RepeatMonthDateCell
                    key={date}
                    accent={accent}
                    cellSize={cellSize}
                    date={date}
                    dateDraft={dateDraft}
                    isLastColumn={colIndex === COLUMNS - 1}
                  />
                );
              })}
            </View>
          );
        })}
      </View>
    </View>
  );
});
