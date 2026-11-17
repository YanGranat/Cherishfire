/** @jsxImportSource nativewind */
import React, {  useLayoutEffect, useRef } from "react";
import { View, Text, Pressable, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { GestureDetector } from "react-native-gesture-handler";
import { CheckboxCircle } from "./CheckboxCircle";
import { Icon } from "@/components/ui/Icon";
import { sizes } from "@/theme/tokens";
import type { DayStatus } from "@/types/habit";
import type { GestureType } from "react-native-gesture-handler";
import {
  getReorderActions,
  getReorderDirection,
  type ReorderDirection,
} from "@/utils/accessibility-reorder";
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
  reorderIndex?: number;
  reorderCount?: number;
  reorderDisabled?: boolean;
  onAccessibilityMove?: (habitId: number, direction: ReorderDirection) => void;
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
  reorderIndex = 0,
  reorderCount = 0,
  reorderDisabled = false,
  onAccessibilityMove,
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
  const canReorder =
    showDragHandle && !isPendingPersistence &&
    !reorderDisabled && reorderCount > 1 && onAccessibilityMove != null;
  const reorderLabels = {
    up: t("accessibility.moveUp"),
    down: t("accessibility.moveDown"),
  };
  const reorderLabel = t("accessibility.reorderItem", {
    name: habitName,
    position: reorderIndex + 1,
    count: reorderCount,
  });
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
      accessibilityValue={canReorder
        ? { text: t("accessibility.itemPosition", {
            position: reorderIndex + 1, count: reorderCount,
          }) }
        : undefined
      }
      accessibilityActions={
        canReorder
          ? getReorderActions(reorderIndex, reorderCount, reorderLabels, false, Platform.OS)
          : undefined
      }
      onAccessibilityAction={(event) => {
        const direction = getReorderDirection(event.nativeEvent.actionName, reorderLabels);
        if (canReorder && direction) onAccessibilityMove?.(habitId, direction);
      }}
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
          accessibilityLabel={reorderLabel}
          reorderLabels={reorderLabels}
          accessibilityActions={
            canReorder
              ? getReorderActions(reorderIndex, reorderCount, reorderLabels, true, Platform.OS)
              : []
          }
          onAccessibilityMove={
            canReorder
              ? (direction) => onAccessibilityMove?.(habitId, direction)
              : undefined
          }
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
    previous.reorderIndex === next.reorderIndex &&
    previous.reorderCount === next.reorderCount &&
    previous.reorderDisabled === next.reorderDisabled &&
    previous.onAccessibilityMove === next.onAccessibilityMove &&
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
  accessibilityLabel: string;
  reorderLabels: { up: string; down: string };
  accessibilityActions: { name: string; label: string }[];
  onAccessibilityMove?: (direction: ReorderDirection) => void;
}
function DragHandle({
  drag,
  dragHandleGesture,
  accessibilityLabel,
  reorderLabels,
  accessibilityActions,
  onAccessibilityMove,
}: DragHandleProps) {
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
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: onAccessibilityMove == null }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={(event) => {
        const direction = getReorderDirection(event.nativeEvent.actionName, reorderLabels);
        if (direction) onAccessibilityMove?.(direction);
      }}
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
