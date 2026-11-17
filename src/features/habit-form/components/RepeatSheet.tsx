/** @jsxImportSource nativewind */
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useTranslation } from "react-i18next";
import { RepeatDaysTab } from "./RepeatDaysTab";
import { RepeatMonthlyTab } from "./RepeatMonthlyTab";
import { RepeatIntervalTab } from "./RepeatIntervalTab";
import { normalizeIntervalDraft } from "@/features/habit-form/utils/repeat-interval";
import { darkTheme, getAccentScheme, lightTheme } from "@/theme/colors";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { AppModal } from "@/components/ui/AppModal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sizes } from "@/theme/tokens";
import type { RepeatSchedule } from "@/types/habit";
import { createMonthlyDateDraftStore } from "@/features/habit-form/utils/monthly-date-draft";
type TabKey = "days" | "monthly" | "interval";
interface RepeatSheetProps {
  visible: boolean;
  onApply: (schedule: RepeatSchedule) => void;
  onCancel: () => void;
  initialSchedule: RepeatSchedule;
}
type RepeatSheetContentProps = Omit<RepeatSheetProps, "visible">;
interface RepeatDraft {
  activeTab: TabKey;
  days: number[];
  dates: number[];
  intervalInput: string;
  intervalFromCompletion: boolean;
}
function createRepeatDraft(schedule: RepeatSchedule): RepeatDraft {
  switch (schedule.type) {
    case "monthly":
      return {
        activeTab: "monthly",
        days: [1, 2, 3, 4, 5, 6, 7],
        dates: [...schedule.dates],
        intervalInput: "2",
        intervalFromCompletion: false,
      };
    case "interval":
      return {
        activeTab: "interval",
        days: [1, 2, 3, 4, 5, 6, 7],
        dates: [1],
        intervalInput: String(schedule.every),
        intervalFromCompletion: schedule.fromCompletion === true,
      };
    case "weekdays":
      return {
        activeTab: "days",
        days: [...schedule.days],
        dates: [1],
        intervalInput: "2",
        intervalFromCompletion: false,
      };
    default:
      return {
        activeTab: "days",
        days: [1, 2, 3, 4, 5, 6, 7],
        dates: [1],
        intervalInput: "2",
        intervalFromCompletion: false,
      };
  }
}
function RepeatSheetContent({
  onApply,
  onCancel,
  initialSchedule,
}: RepeatSheetContentProps) {
  const { t } = useTranslation();
  const colorScheme = useVisualColorScheme();
  const accent = getAccentScheme(colorScheme).base;
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const repeatDividerColor = isDarkTheme
    ? darkTheme.divider
    : lightTheme.divider;
  const insets = useSafeAreaInsets();
  const [initialDraft] = useState(() => createRepeatDraft(initialSchedule));
  const [activeTab, setActiveTab] = useState<TabKey>(initialDraft.activeTab);
  // State per tab
  const [days, setDays] = useState<number[]>(initialDraft.days);
  const [intervalInput, setIntervalInput] = useState(
    initialDraft.intervalInput,
  );
  const [intervalFromCompletion, setIntervalFromCompletion] = useState(
    initialDraft.intervalFromCompletion,
  );
  const activeTabRef = useRef<TabKey>(initialDraft.activeTab);
  const daysRef = useRef<number[]>(initialDraft.days);
  const [monthlyDateDraft] = useState(() =>
    createMonthlyDateDraftStore(initialDraft.dates),
  );
  const intervalInputRef = useRef(initialDraft.intervalInput);
  const intervalFromCompletionRef = useRef(initialDraft.intervalFromCompletion);
  const setDraftTab = useCallback((tab: TabKey) => {
    activeTabRef.current = tab;
    setActiveTab(tab);
  }, []);
  const setDraftDays = useCallback((nextDays: number[]) => {
    daysRef.current = nextDays;
    setDays(nextDays);
  }, []);
  const setDraftIntervalInput = useCallback((nextInterval: string) => {
    intervalInputRef.current = nextInterval;
    setIntervalInput(nextInterval);
  }, []);
  const setDraftIntervalFromCompletion = useCallback((nextValue: boolean) => {
    intervalFromCompletionRef.current = nextValue;
    setIntervalFromCompletion(nextValue);
  }, []);
  const toggleDay = useCallback(
    (day: number) => {
      const previous = daysRef.current;
      const wasSelected = previous.includes(day);
      if (wasSelected && previous.length <= 1) return true;
      const nextDays = wasSelected
        ? previous.filter((currentDay) => currentDay !== day)
        : [...previous, day];
      setDraftDays(nextDays);
      return !wasSelected;
    },
    [setDraftDays],
  );
  const buildSchedule = (): RepeatSchedule => {
    switch (activeTabRef.current) {
      case "days":
        return daysRef.current.length === 7
          ? { type: "daily" }
          : {
              type: "weekdays",
              days: [...daysRef.current].sort((a, b) => a - b),
            };
      case "monthly":
        return {
          type: "monthly",
          dates: monthlyDateDraft.getDates().sort((a, b) => a - b),
        };
      case "interval":
        return {
          type: "interval",
          every: normalizeIntervalDraft(intervalInputRef.current),
          fromCompletion: intervalFromCompletionRef.current,
        };
    }
  };
  const handleApply = () => {
    const schedule = buildSchedule();
    onApply(schedule);
  };
  const tabs = useMemo<
    {
      key: TabKey;
      label: string;
    }[]
  >(
    () => [
      { key: "days", label: t("repeat.tabDays") },
      { key: "monthly", label: t("repeat.tabMonthly") },
      { key: "interval", label: t("repeat.tabInterval") },
    ],
    [t],
  );
  return (
    <KeyboardAvoidingView
      cssInterop={false}
      style={{ flex: 1, justifyContent: "flex-end" }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <Pressable
        className="absolute inset-0 bg-black/50"
        onPress={() => {
          onCancel();
        }}
      />
      <View
        className="bg-surface"
        style={{
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          maxHeight: "78%",
          paddingBottom: Math.max(insets.bottom, 12),
        }}
      >
        {/* Header with title and DONE */}
        <View
          className="flex-row items-center justify-between px-base pt-sm pb-sm"
          style={{
            borderBottomWidth: 1,
            borderBottomColor: repeatDividerColor,
          }}
        >
          <Text
            className="font-semibold"
            style={{
              fontSize: 17,
              color: isDarkTheme ? "#F1F1F1" : undefined,
            }}
          >
            {t("repeat.title")}
          </Text>
          <Pressable
            onPress={handleApply}
            accessibilityRole="button"
            accessibilityLabel={t("repeat.done")}
            hitSlop={{ top: 9, bottom: 9 }}
            className="py-xs px-sm active:opacity-60"
          >
            <Text style={{ color: accent, fontWeight: "600", fontSize: 14 }}>
              {t("repeat.done")}
            </Text>
          </Pressable>
        </View>

        {/* Tabs: 3 segmented buttons with separators */}
        <View
          style={{
            borderBottomWidth: 1,
            borderBottomColor: repeatDividerColor,
          }}
        >
          <View className="flex-row" style={{ height: 44 }}>
            {tabs.map((tab, index) => {
              const isActive = activeTab === tab.key;
              return (
                <Pressable
                  key={tab.key}
                  onPress={() => {
                    setDraftTab(tab.key);
                  }}
                  accessibilityRole="tab"
                  accessibilityLabel={tab.label}
                  accessibilityState={{ selected: isActive }}
                  className="flex-1 items-center justify-center"
                  style={{
                    backgroundColor: isActive
                      ? isDarkTheme
                        ? "#3F3F3F"
                        : "#F2F2F2"
                      : "transparent",
                    borderLeftWidth: index === 0 ? 0 : 1,
                    borderLeftColor: repeatDividerColor,
                  }}
                >
                  <Text
                    className="font-semibold"
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    style={{
                      fontSize: 13,
                      color: isActive
                        ? isDarkTheme
                          ? "#FAFAFA"
                          : "#2A2A2A"
                        : isDarkTheme
                          ? "#C2C2C2"
                          : "#707070",
                    }}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Tab content */}
        <ScrollView
          style={{ flexShrink: 1 }}
          contentContainerStyle={{ minHeight: sizes.rowHeight * 4 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {activeTab === "days" && (
            <RepeatDaysTab selectedDays={days} onToggleDay={toggleDay} />
          )}
          {activeTab === "monthly" && (
            <RepeatMonthlyTab dateDraft={monthlyDateDraft} />
          )}
          {activeTab === "interval" && (
            <RepeatIntervalTab
              value={intervalInput}
              onChange={setDraftIntervalInput}
              fromCompletion={intervalFromCompletion}
              onFromCompletionChange={setDraftIntervalFromCompletion}
            />
          )}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}
// Schedule changes are committed only by DONE; scrim/back dismisses the draft.
export function RepeatSheet({
  visible,
  onApply,
  onCancel,
  initialSchedule,
}: RepeatSheetProps) {
  return (
    <AppModal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => {
        onCancel();
        return true;
      }}
    >
      {visible ? (
        <RepeatSheetContent
          initialSchedule={initialSchedule}
          onApply={onApply}
          onCancel={onCancel}
        />
      ) : null}
    </AppModal>
  );
}
