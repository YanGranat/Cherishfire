/** @jsxImportSource nativewind */
import React from "react";
import { View, Text, Pressable } from "react-native";
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
  const language = useVisualLanguage();
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

          <View className="flex-row justify-end mt-sm">
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                if (isInteractionBlocked()) return;
                onDelete(habit.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={t("archive.delete")}
              className="px-sm py-xs mr-xs active:opacity-60"
            >
              <Text className="text-destructive text-sm">
                {t("archive.delete")}
              </Text>
            </Pressable>
            <Pressable
              onPress={(event) => {
                event.stopPropagation();
                if (isInteractionBlocked()) return;
                onRestore(habit.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={t("archive.restore")}
              className="pl-sm py-xs active:opacity-60"
            >
              <Text className="text-primary text-sm">
                {t("archive.restore")}
              </Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </View>
  );
});
