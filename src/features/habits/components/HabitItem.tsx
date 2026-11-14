/** @jsxImportSource nativewind */
import React, {  useLayoutEffect, useRef } from "react";
import { View, Text, Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { GestureDetector } from "react-native-gesture-handler";
import { CheckboxCircle } from "./CheckboxCircle";
import { Icon } from "@/components/ui/Icon";
import { sizes } from "@/theme/tokens";
import type { DayStatus } from "@/types/habit";
import type { GestureType } from "react-native-gesture-handler";
type CheckboxState = DayStatus | "unmarked" | "unmarkedPast";
interface HabitItemProps {
  habitId: number;
  habitName: string;
  checkboxState: CheckboxState;
  checkboxDisabled?: boolean;
  currentStreak: number;
  onCheckboxPress: (habitId: number) => boolean;
  onCheckboxLongPress: (habitId: number, pageX: number, pageY: number) => void;
  onPress: (habitId: number) => void;
  onLongPress: (habitId: number, pageX: number, pageY: number) => void;
  showDragHandle: boolean;
  drag?: (pageY: number) => void;
  dragHandleGesture?: GestureType;
  isActive?: boolean;
  rowOpacity?: number;
  rowScale?: number;
  rowTintColor?: string | null;
  streakOpacity?: number;
  animateCheckboxTransitions?: boolean;
  visualEpoch?: string;
}
// Habit row: checkbox, name and streak, then an optional drag handle.
function HabitItemComponent({
  habitId,
  habitName,
  checkboxState,
  checkboxDisabled = false,
  currentStreak,
  onCheckboxPress,
  onCheckboxLongPress,
  onPress,
  onLongPress,
  showDragHandle,
  drag,
  dragHandleGesture,
  isActive,
  rowOpacity = 1,
  rowScale = 1,
  rowTintColor = null,
  streakOpacity = 1,
  animateCheckboxTransitions = true,
  visualEpoch = "stable",
}: HabitItemProps) {
  const { t } = useTranslation();
  const isPendingPersistence = habitId < 0;
  const committedCheckboxVisualRef = useRef({
    presentationEpoch: visualEpoch,
    state: checkboxState,
    key: visualEpoch,
  });
  const committedCheckboxVisual = committedCheckboxVisualRef.current;
  // If a retained caller changes presentation epochs, never animate from the
  // previous tone. Remount the nested circle only when that tone differs;
  // a replaced presentation owner already receives fresh initial state.
  const checkboxVisualKey =
    committedCheckboxVisual.presentationEpoch !== visualEpoch &&
    committedCheckboxVisual.state !== checkboxState
      ? visualEpoch
      : committedCheckboxVisual.key;
  useLayoutEffect(() => {
    committedCheckboxVisualRef.current = {
      presentationEpoch: visualEpoch,
      state: checkboxState,
      key: checkboxVisualKey,
    };
  }, [checkboxState, checkboxVisualKey, visualEpoch]);
  return (
    <Pressable
      onPress={() => {
        if (isPendingPersistence) {
          return;
        }
        onPress(habitId);
      }}
      onLongPress={(event) => {
        if (isPendingPersistence) {
          return;
        }
        onLongPress(habitId, event.nativeEvent.pageX, event.nativeEvent.pageY);
      }}
      accessibilityRole="button"
      accessibilityLabel={habitName}
      accessibilityHint={t("accessibility.openHabit")}
      delayLongPress={180}
      className={`flex-row items-center pr-base ${isActive ? "bg-press-highlight" : ""}`}
      style={{
        minHeight: 64,
        paddingLeft: 10,
        opacity: rowOpacity,
        transform: [{ scale: rowScale }],
        backgroundColor: rowTintColor ?? undefined,
      }}
    >
      {/* Checkbox */}
      <CheckboxCircle
        key={checkboxVisualKey}
        state={checkboxState}
        disabled={isPendingPersistence}
        readOnly={checkboxDisabled}
        accessibilityLabel={t("accessibility.markHabit", { name: habitName })}
        accessibilityValue={t(
          `accessibility.habitStatus.${checkboxState}` as any,
        )}
        onPress={() => {
          return onCheckboxPress(habitId);
        }}
        onLongPress={(event) => {
          onCheckboxLongPress(
            habitId,
            event.nativeEvent.pageX,
            event.nativeEvent.pageY,
          );
        }}
        animateTransitions={animateCheckboxTransitions}
      />

      {/* Name and streak */}
      <View className="flex-1 ml-sm justify-center">
        <Text className="text-primary text-base" numberOfLines={1}>
          {habitName}
        </Text>
        <Text
          className="text-muted text-[13px]"
          style={{ opacity: streakOpacity }}
        >
          {t("habits.currentStreak", { count: currentStreak })}
        </Text>
      </View>

      {/* Drag handle */}
      {showDragHandle ? (
        <DragHandle
          drag={isPendingPersistence ? undefined : drag}
          dragHandleGesture={
            isPendingPersistence ? undefined : dragHandleGesture
          }
        />
      ) : null}
    </Pressable>
  );
}
function areHabitItemPropsEqual(
  previous: HabitItemProps,
  next: HabitItemProps,
): boolean {
  return (
    previous.habitId === next.habitId &&
    previous.habitName === next.habitName &&
    previous.checkboxState === next.checkboxState &&
    previous.checkboxDisabled === next.checkboxDisabled &&
    previous.currentStreak === next.currentStreak &&
    previous.onCheckboxPress === next.onCheckboxPress &&
    previous.onCheckboxLongPress === next.onCheckboxLongPress &&
    previous.onPress === next.onPress &&
    previous.onLongPress === next.onLongPress &&
    previous.showDragHandle === next.showDragHandle &&
    previous.drag === next.drag &&
    previous.dragHandleGesture === next.dragHandleGesture &&
    previous.isActive === next.isActive &&
    previous.rowOpacity === next.rowOpacity &&
    previous.rowScale === next.rowScale &&
    previous.rowTintColor === next.rowTintColor &&
    previous.streakOpacity === next.streakOpacity &&
    previous.animateCheckboxTransitions === next.animateCheckboxTransitions &&
    previous.visualEpoch === next.visualEpoch
  );
}
export const HabitItem = React.memo(HabitItemComponent, areHabitItemPropsEqual);
interface DragHandleProps {
  drag?: (pageY: number) => void;
  dragHandleGesture?: GestureType;
}
function DragHandle({ drag, dragHandleGesture }: DragHandleProps) {
  const { t } = useTranslation();
  const handle = (
    <Pressable
      onPressIn={(event) => {
        event.stopPropagation();
      }}
      onLongPress={
        dragHandleGesture
          ? undefined
          : (event) => {
              event.stopPropagation();
              drag?.(event.nativeEvent.pageY);
            }
      }
      delayLongPress={dragHandleGesture ? undefined : 100}
      accessibilityRole="button"
      accessibilityLabel={t("accessibility.reorderHabit")}
      className="items-center justify-center"
      style={{
        width: sizes.headerIconTouch,
        height: sizes.headerIconTouch,
      }}
    >
      <Icon name="drag-handle" size={sizes.headerIcon} variant="muted" />
    </Pressable>
  );
  if (!dragHandleGesture) {
    return handle;
  }
  return (
    <GestureDetector gesture={dragHandleGesture}>{handle}</GestureDetector>
  );
}
