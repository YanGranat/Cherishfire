/** @jsxImportSource nativewind */
import React from "react";
import { View, Text, Pressable, useWindowDimensions } from "react-native";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import {
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import type { Habit } from "@/types/habit";
import { formatLocalizedDate } from "@/utils/date";
import { radii } from "@/theme/tokens";
import { lightTheme } from "@/theme/colors";
import { getArchiveActionGeometry } from "../utils/action-geometry";
const CARD_BOTTOM_GAP = 11.5;
interface ArchiveCardProps {
  habit: Habit;
  onDelete: (habitId: number) => void;
  onRestore: (habitId: number) => void;
  onPress: (habitId: number) => void;
  isInteractionBlocked: () => boolean;
}
// Card presses open read-only details; nested mutation buttons stop propagation.
export const ArchiveCard = React.memo(function ArchiveCard({
  habit,
  onDelete,
  onRestore,
  onPress,
  isInteractionBlocked,
}: ArchiveCardProps) {
  const { t } = useTranslation();
  const { fontScale } = useWindowDimensions();
  const language = useVisualLanguage();
  const measurementKey = `${language}:${fontScale}`;
  const measurementKeyRef = React.useRef(measurementKey);
  measurementKeyRef.current = measurementKey;
  const [actionHeights, setActionHeights] = React.useState<{
    key?: string;
    delete?: number;
    restore?: number;
  }>({});
  const measuredHeights =
    actionHeights.key === measurementKey ? actionHeights : {};
  const estimatedActionHeight = 17.5 * fontScale + 8;
  const naturalActionHeight = Math.max(
    measuredHeights.delete ?? estimatedActionHeight,
    measuredHeights.restore ?? estimatedActionHeight,
  );
  const actionGeometry = getArchiveActionGeometry(naturalActionHeight);
  const actionContentInset = (actionGeometry.height - naturalActionHeight) / 2;
  const measureAction = (action: "delete" | "restore", height: number) => {
    if (
      measurementKeyRef.current !== measurementKey ||
      !Number.isFinite(height) || height <= 0
    ) return;
    setActionHeights((current) => {
      if (current.key === measurementKey && current[action] === height) {
        return current;
      }
      return {
        ...(current.key === measurementKey ? current : {}),
        key: measurementKey,
        [action]: height,
      };
    });
  };
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const openArchivePeriod = habit.archiveHistory.findLast(
    (period) => period.restoredAt == null,
  );
  const storedArchiveDate = openArchivePeriod?.archivedDate;
  const archiveDate = storedArchiveDate
    ? formatLocalizedDate(storedArchiveDate, language)
    : habit.archivedAt
      ? formatLocalizedDate(new Date(habit.archivedAt), language)
      : "";
  const cardBackgroundColor = isDark ? "#1B1B1B" : lightTheme.surfaceElevated;
  const metaTextColor = isDark ? "#A3A3A3" : "#6F6F6F";
  return (
    <View style={{ paddingHorizontal: 11, marginBottom: CARD_BOTTOM_GAP }}>
      <Pressable
        onPress={() => {
          if (isInteractionBlocked()) return;
          onPress(habit.id);
        }}
        accessibilityRole="button"
        accessibilityLabel={t("archive.openDetails", { name: habit.name })}
        style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
      >
        <View
          className="p-md"
          style={{
            backgroundColor: cardBackgroundColor,
            borderRadius: radii.listCard,
          }}
        >
          <Text style={{ color: metaTextColor, fontSize: 12, marginBottom: 8 }}>
            {t("archive.archivedAt", { date: archiveDate })}
          </Text>

          <View className="flex-row items-center mb-sm">
            <Text className="text-primary text-base flex-1">{habit.name}</Text>
            <MaterialIcons
              name="chevron-right"
              size={20}
              color={metaTextColor}
            />
          </View>

          <View className="flex-row justify-end" style={actionGeometry}>
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                if (isInteractionBlocked()) return;
                onDelete(habit.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={t("archive.delete")}
              className="mr-xs items-center active:opacity-60"
              style={{
                height: actionGeometry.height,
                paddingTop: actionContentInset,
              }}
            >
              <View
                className="px-sm py-xs"
                onLayout={(event) =>
                  measureAction("delete", event.nativeEvent.layout.height)
                }
              >
                <Text className="text-destructive text-sm">
                  {t("archive.delete")}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                if (isInteractionBlocked()) return;
                onRestore(habit.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={t("archive.restore")}
              className="items-center active:opacity-60"
              style={{
                height: actionGeometry.height,
                paddingTop: actionContentInset,
              }}
            >
              <View
                className="pl-sm py-xs"
                onLayout={(event) =>
                  measureAction("restore", event.nativeEvent.layout.height)
                }
              >
                <Text className="text-primary text-sm">
                  {t("archive.restore")}
                </Text>
              </View>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </View>
  );
});
