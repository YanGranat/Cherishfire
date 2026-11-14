/** @jsxImportSource nativewind */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { View, Text, TextInput, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import { useLocalSearchParams, useRouter } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { runAfterUiPaint } from "@/utils/ui-scheduling";
import { InlineErrorBanner } from "@/components/ui/InlineErrorBanner";
import { useTranslation } from "react-i18next";
import { getAccentScheme, darkTheme, lightTheme } from "@/theme/colors";
import { isCivilDateKey } from "@/domain/dates/civil-date";
import { getCurrentLocalDateSnapshot } from "@/hooks/useCurrentLocalDate";
import { ScreenWrapper } from "@/components/layout/ScreenWrapper";
import { RepeatSheet } from "@/features/habit-form/components/RepeatSheet";
import { DatePickerModal } from "@/features/habit-form/components/DatePickerModal";
import { ReminderScreen } from "@/features/habit-form/components/ReminderScreen";
import { EditRows } from "@/features/habit-detail/components/EditRows";
import { useCreateHabit } from "@/features/habit-form/hooks/useCreateHabit";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { useUIStore } from "@/stores/ui-store";
import { areRepeatSchedulesEqual, type RepeatSchedule } from "@/types/habit";
import { dismissKeyboardForHabitFormOverlay } from "@/features/habit-form/utils/dismiss-keyboard-for-overlay";
interface CreateHabitScheduleSnapshot {
  repeatSchedule: RepeatSchedule;
  startDate: string;
  reminderEnabled: boolean;
  reminderTime: string | null;
}
interface CreateHabitScheduleControllerHandle {
  getSnapshot(): CreateHabitScheduleSnapshot;
}
interface CreateHabitScheduleControllerProps {
  initialSnapshot: CreateHabitScheduleSnapshot;
}
interface CreateHabitOverlayControllerHandle {
  openRepeat(): void;
  openStartDate(): void;
  openReminders(): void;
}
interface CreateHabitOverlayControllerProps {
  repeatSchedule: RepeatSchedule;
  startDate: string;
  reminderEnabled: boolean;
  reminderTime: string | null;
  onRepeatApply: (schedule: RepeatSchedule) => void;
  onStartDateConfirm: (date: string) => void;
  onReminderSave: (enabled: boolean, time: string | null) => void;
}
type CreateFormOverlayKind = "repeat" | "start-date" | "reminder";
interface CreateFormOverlaySession {
  kind: CreateFormOverlayKind;
  visible: boolean;
  generation: number;
}
const MemoizedRepeatSheet = React.memo(RepeatSheet);
const MemoizedDatePickerModal = React.memo(DatePickerModal);
/**
 * Modal visibility is deliberately isolated from the form. Opening a repeat,
 * date or reminder editor must mount only that portal, not re-render the name,
 * description and stable edit rows underneath it.
 */
const CreateHabitOverlayController = React.memo(
  React.forwardRef<
    CreateHabitOverlayControllerHandle,
    CreateHabitOverlayControllerProps
  >(function CreateHabitOverlayController(
    {
      repeatSchedule,
      startDate,
      reminderEnabled,
      reminderTime,
      onRepeatApply,
      onStartDateConfirm,
      onReminderSave,
    },
    ref,
  ) {
    const [session, setSession] = useState<CreateFormOverlaySession | null>(
      null,
    );
    const sessionRef = useRef<CreateFormOverlaySession | null>(null);
    const generationRef = useRef(0);
    const isFocused = useIsFocused();
    const isFocusedRef = useRef(isFocused);
    const [datePickerHostWarmed, setDatePickerHostWarmed] = useState(false);
    const onStartDateConfirmRef = useRef(onStartDateConfirm);
    useLayoutEffect(() => {
      isFocusedRef.current = isFocused;
    }, [isFocused]);
    useLayoutEffect(() => {
      onStartDateConfirmRef.current = onStartDateConfirm;
    }, [onStartDateConfirm]);
    const hasVisibleOverlay = session?.visible === true;
    useEffect(() => {
      if (
        Platform.OS !== "android" ||
        !isFocused ||
        datePickerHostWarmed ||
        hasVisibleOverlay
      ) {
        return;
      }
      const task = runAfterUiPaint(() => {
        if (isFocusedRef.current && !sessionRef.current?.visible) {
          setDatePickerHostWarmed(true);
        }
      });
      return () => task.cancel();
    }, [datePickerHostWarmed, hasVisibleOverlay, isFocused]);
    const openOverlay = useCallback((kind: CreateFormOverlayKind) => {
      generationRef.current += 1;
      const next: CreateFormOverlaySession = {
        kind,
        visible: true,
        generation: generationRef.current,
      };
      sessionRef.current = next;
      setSession(next);
    }, []);
    const openRepeat = useCallback(() => openOverlay("repeat"), [openOverlay]);
    const openStartDate = useCallback(
      () => openOverlay("start-date"),
      [openOverlay],
    );
    const openReminders = useCallback(
      () => openOverlay("reminder"),
      [openOverlay],
    );
    React.useImperativeHandle(
      ref,
      () => ({ openRepeat, openStartDate, openReminders }),
      [openReminders, openRepeat, openStartDate],
    );
    const closeOverlay = useCallback(
      (kind: CreateFormOverlayKind, generation: number): boolean => {
        const current = sessionRef.current;
        if (
          current == null ||
          current.kind !== kind ||
          current.generation !== generation ||
          !current.visible
        ) {
          return false;
        }
        const next = { ...current, visible: false };
        sessionRef.current = next;
        setSession(next);
        return true;
      },
      [],
    );
    const applyRepeat = useCallback(
      (generation: number, schedule: RepeatSchedule) => {
        if (!closeOverlay("repeat", generation)) return;
        onRepeatApply(schedule);
      },
      [closeOverlay, onRepeatApply],
    );
    const confirmCurrentStartDate = useCallback(
      (date: string) => {
        const current = sessionRef.current;
        if (current?.kind !== "start-date") {
          return;
        }
        if (!closeOverlay("start-date", current.generation)) {
          return;
        }
        onStartDateConfirmRef.current(date);
      },
      [closeOverlay],
    );
    const cancelCurrentStartDate = useCallback(() => {
      const current = sessionRef.current;
      if (current?.kind !== "start-date") {
        return;
      }
      closeOverlay("start-date", current.generation);
    }, [closeOverlay]);
    const saveReminders = useCallback(
      (generation: number, enabled: boolean, time: string | null) => {
        if (!closeOverlay("reminder", generation)) return;
        onReminderSave(enabled, time);
      },
      [closeOverlay, onReminderSave],
    );
    const shouldPreloadDatePicker =
      Platform.OS === "android" && isFocused && datePickerHostWarmed;
    return (
      <>
        {session?.kind === "repeat" ? (
          <MemoizedRepeatSheet
            visible={session.visible}
            onApply={(schedule) => applyRepeat(session.generation, schedule)}
            onCancel={() => closeOverlay("repeat", session.generation)}
            initialSchedule={repeatSchedule}
          />
        ) : null}
        {shouldPreloadDatePicker || session?.kind === "start-date" ? (
          <MemoizedDatePickerModal
            visible={session?.kind === "start-date" && session.visible}
            preloadOnAndroid={shouldPreloadDatePicker}
            selectedDate={startDate}
            onConfirm={confirmCurrentStartDate}
            onCancel={cancelCurrentStartDate}
          />
        ) : null}
        {session?.kind === "reminder" ? (
          <ReminderScreen
            visible={session.visible}
            enabled={reminderEnabled}
            time={reminderTime}
            onSave={(enabled, time) =>
              saveReminders(session.generation, enabled, time)
            }
            onBack={() => closeOverlay("reminder", session.generation)}
          />
        ) : null}
      </>
    );
  }),
);
/**
 * Schedule values and their editors form one isolated render boundary. The
 * parent form reads the latest synchronous snapshot only when Save is pressed,
 * so applying a schedule change never re-renders the title or text inputs.
 */
const CreateHabitScheduleController = React.memo(
  React.forwardRef<
    CreateHabitScheduleControllerHandle,
    CreateHabitScheduleControllerProps
  >(function CreateHabitScheduleController({ initialSnapshot }, ref) {
    const [schedule, setSchedule] = useState(initialSnapshot);
    const scheduleSnapshotRef = useRef(initialSnapshot);
    const overlayControllerRef =
      useRef<CreateHabitOverlayControllerHandle>(null);
    React.useImperativeHandle(
      ref,
      () => ({
        getSnapshot: () => scheduleSnapshotRef.current,
      }),
      [],
    );
    const publishSchedule = useCallback((next: CreateHabitScheduleSnapshot) => {
      // The ref is updated before React schedules the visual commit. A Save
      // pressed immediately after a modal action therefore sees the latest
      // user intent rather than the previous rendered snapshot.
      scheduleSnapshotRef.current = next;
      setSchedule(next);
    }, []);
    const openRepeatSheet = useCallback(() => {
      dismissKeyboardForHabitFormOverlay();
      overlayControllerRef.current?.openRepeat();
    }, []);
    const openDatePicker = useCallback(() => {
      dismissKeyboardForHabitFormOverlay();
      overlayControllerRef.current?.openStartDate();
    }, []);
    const openReminderScreen = useCallback(() => {
      dismissKeyboardForHabitFormOverlay();
      overlayControllerRef.current?.openReminders();
    }, []);
    const applyRepeatSchedule = useCallback(
      (nextRepeatSchedule: RepeatSchedule) => {
        const current = scheduleSnapshotRef.current;
        if (
          areRepeatSchedulesEqual(current.repeatSchedule, nextRepeatSchedule)
        ) {
          return;
        }
        publishSchedule({
          ...current,
          repeatSchedule: nextRepeatSchedule,
        });
      },
      [publishSchedule],
    );
    const confirmStartDate = useCallback(
      (date: string) => {
        const current = scheduleSnapshotRef.current;
        if (current.startDate === date) {
          return;
        }
        publishSchedule({ ...current, startDate: date });
      },
      [publishSchedule],
    );
    const saveReminder = useCallback(
      (enabled: boolean, time: string | null) => {
        const nextEnabled = enabled && Boolean(time);
        const nextTime = nextEnabled ? time : null;
        const current = scheduleSnapshotRef.current;
        if (
          current.reminderEnabled === nextEnabled &&
          current.reminderTime === nextTime
        ) {
          return;
        }
        publishSchedule({
          ...current,
          reminderEnabled: nextEnabled,
          reminderTime: nextTime,
        });
      },
      [publishSchedule],
    );
    return (
      <>
        <EditRows
          repeatSchedule={schedule.repeatSchedule}
          startDate={schedule.startDate}
          reminderEnabled={schedule.reminderEnabled}
          reminderTime={schedule.reminderEnabled ? schedule.reminderTime : null}
          onRepeatPress={openRepeatSheet}
          onStartDatePress={openDatePicker}
          onReminderPress={openReminderScreen}
          showHeader={false}
        />

        <CreateHabitOverlayController
          ref={overlayControllerRef}
          repeatSchedule={schedule.repeatSchedule}
          startDate={schedule.startDate}
          reminderEnabled={schedule.reminderEnabled}
          reminderTime={schedule.reminderTime}
          onRepeatApply={applyRepeatSchedule}
          onStartDateConfirm={confirmStartDate}
          onReminderSave={saveReminder}
        />
      </>
    );
  }),
);
export default function CreateHabitScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { date: dateParam } = useLocalSearchParams<{
    date?: string | string[];
  }>();
  const { t } = useTranslation();
  const { create, error, clearError } = useCreateHabit();
  const colorScheme = useVisualColorScheme();
  const selectedDate = useUIStore((s) => s.selectedDate);
  const accent = getAccentScheme(colorScheme).base;
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme = effectiveMode === "dark";
  const palette = isDarkTheme ? darkTheme : lightTheme;
  const rowBackgroundColor = palette.background;
  const cardBackgroundColor = isDarkTheme
    ? "#262626"
    : lightTheme.surfaceElevated;
  const cardBorderColor = isDarkTheme ? "#5F5F5F" : lightTheme.border;
  const sectionHeaderBackgroundColor = isDarkTheme
    ? "#2F2F2F"
    : lightTheme.surface;
  const sectionDividerColor = isDarkTheme ? "#6B6B6B" : lightTheme.divider;
  const sectionTitleColor = isDarkTheme ? "#D8D8D8" : lightTheme.muted;
  const inputBackgroundColor = cardBackgroundColor;
  const initialDateValue = Array.isArray(dateParam) ? dateParam[0] : dateParam;
  const initialStartDate = isCivilDateKey(initialDateValue)
    ? initialDateValue
    : isCivilDateKey(selectedDate)
      ? selectedDate
      : getCurrentLocalDateSnapshot();
  const initialScheduleSnapshotRef = useRef<CreateHabitScheduleSnapshot | null>(
    null,
  );
  if (initialScheduleSnapshotRef.current == null) {
    initialScheduleSnapshotRef.current = {
      repeatSchedule: { type: "daily" },
      startDate: initialStartDate,
      reminderEnabled: false,
      reminderTime: null,
    };
  }
  const initialScheduleSnapshot = initialScheduleSnapshotRef.current;
  // Form state
  const nameRef = useRef("");
  const descriptionRef = useRef("");
  const nameInputRef = useRef<TextInput>(null);
  const descriptionInputRef = useRef<TextInput>(null);
  const hasNameRef = useRef(false);
  const [hasName, setHasName] = useState(false);
  const scheduleControllerRef =
    useRef<CreateHabitScheduleControllerHandle>(null);
  const canSave = hasName;
  const handleSave = useCallback(async () => {
    const name = nameRef.current.trim();
    const description = descriptionRef.current.trim();
    const schedule =
      scheduleControllerRef.current?.getSnapshot() ?? initialScheduleSnapshot;
    await create({
      name,
      description: description || undefined,
      repeatSchedule: schedule.repeatSchedule,
      startDate: schedule.startDate,
      reminderEnabled: schedule.reminderEnabled,
      reminderTime: schedule.reminderEnabled
        ? (schedule.reminderTime ?? undefined)
        : undefined,
    });
  }, [create, initialScheduleSnapshot]);
  const handleBack = useCallback(() => {
    router.back();
  }, [router]);
  const handleNameChange = useCallback(
    (value: string) => {
      nameRef.current = value;
      const nextHasName = value.trim().length > 0;
      if (nextHasName !== hasNameRef.current) {
        hasNameRef.current = nextHasName;
        setHasName(nextHasName);
      }
      if (error) clearError();
    },
    [clearError, error],
  );
  const handleDescriptionChange = useCallback((value: string) => {
    descriptionRef.current = value;
  }, []);
  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);
  return (
    <>
      <View
        className="flex-row items-center justify-between px-base"
        style={{
          paddingTop: insets.top,
          height: 56 + insets.top,
          backgroundColor: rowBackgroundColor,
        }}
      >
        <Pressable
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel={t("common.back")}
          className="items-center justify-center w-11 h-11"
        >
          <MaterialIcons name="arrow-back" size={24} color={palette.icon} />
        </Pressable>
        <Text
          className="text-primary font-semibold"
          style={{ fontSize: 18 }}
          numberOfLines={1}
        >
          {t("creation.title")}
        </Text>
        <Pressable
          onPress={handleSavePress}
          accessibilityRole="button"
          accessibilityLabel={t("creation.save")}
          accessibilityState={{ disabled: !canSave }}
          className="items-center justify-center px-sm h-11"
          disabled={!canSave}
        >
          <Text
            numberOfLines={1}
            style={{
              color: canSave ? accent : palette.disabled,
              fontSize: 14,
              fontWeight: "600",
            }}
          >
            {t("creation.save")}
          </Text>
        </Pressable>
      </View>

      <ScreenWrapper scrollable backgroundColor={rowBackgroundColor}>
        {error ? <InlineErrorBanner message={t("creation.saveError")} /> : null}
        <View
          className="mx-[14px] mt-[10px] overflow-hidden rounded-section-card border border-border"
          style={{
            backgroundColor: cardBackgroundColor,
            borderColor: cardBorderColor,
            borderWidth: 0.5,
          }}
        >
          <View
            className="border-b border-divider px-md pb-sm pt-md"
            style={{
              backgroundColor: sectionHeaderBackgroundColor,
              borderBottomColor: sectionDividerColor,
              borderBottomWidth: 0.5,
            }}
          >
            <Text
              className="text-xs font-semibold uppercase"
              style={{ color: sectionTitleColor }}
            >
              {t("creation.nameLabel")}
            </Text>
          </View>

          <View>
            <TextInput
              ref={nameInputRef}
              defaultValue=""
              onChange={(event) => handleNameChange(event.nativeEvent.text)}
              placeholder={t("creation.namePlaceholder")}
              autoFocus
              className="text-primary text-base px-md py-md min-h-[52px]"
              style={{
                backgroundColor: inputBackgroundColor,
                width: "100%",
              }}
              placeholderTextColor={palette.muted}
            />
          </View>
        </View>

        <View
          className="mx-[14px] mt-[10px] overflow-hidden rounded-section-card border border-border"
          style={{
            backgroundColor: cardBackgroundColor,
            borderColor: cardBorderColor,
            borderWidth: 0.5,
          }}
        >
          <View
            className="border-b border-divider px-md pb-sm pt-md"
            style={{
              backgroundColor: sectionHeaderBackgroundColor,
              borderBottomColor: sectionDividerColor,
              borderBottomWidth: 0.5,
            }}
          >
            <Text
              className="text-xs font-semibold uppercase"
              style={{ color: sectionTitleColor }}
            >
              {t("creation.descriptionLabel")}
            </Text>
          </View>

          <View>
            <TextInput
              ref={descriptionInputRef}
              defaultValue=""
              onChange={(event) =>
                handleDescriptionChange(event.nativeEvent.text)
              }
              placeholder={t("creation.descriptionPlaceholder")}
              multiline
              numberOfLines={4}
              className="text-primary text-base px-md py-md min-h-[120px]"
              style={{
                backgroundColor: inputBackgroundColor,
                width: "100%",
              }}
              placeholderTextColor={palette.muted}
              textAlignVertical="top"
            />
          </View>
        </View>

        <CreateHabitScheduleController
          ref={scheduleControllerRef}
          initialSnapshot={initialScheduleSnapshot}
        />
      </ScreenWrapper>
    </>
  );
}
