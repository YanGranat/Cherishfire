import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import type { RepeatSchedule } from "@/types/habit";
import { DatePickerModal } from "@/features/habit-form/components/DatePickerModal";
import { ReminderScreen } from "@/features/habit-form/components/ReminderScreen";
import { RepeatSheet } from "@/features/habit-form/components/RepeatSheet";
import { runAfterUiPaint } from "@/utils/ui-scheduling";
import { dismissKeyboardForHabitFormOverlay } from "@/features/habit-form/utils/dismiss-keyboard-for-overlay";
export interface HabitDetailFormOverlayControllerHandle {
  openRepeat: () => void;
  openStartDate: () => void;
  openReminders: () => void;
}
interface HabitDetailFormOverlayControllerProps {
  repeatSchedule: RepeatSchedule;
  startDate: string;
  reminderEnabled: boolean;
  reminderTime: string | null;
  onRepeatApply: (schedule: RepeatSchedule) => void;
  onStartDateConfirm: (date: string) => void;
  onReminderSave: (enabled: boolean, time: string | null) => void;
}
type FormOverlayKind = "repeat" | "start-date" | "reminder";
interface FormOverlaySession {
  kind: FormOverlayKind;
  visible: boolean;
  generation: number;
}

const MemoizedRepeatSheet = React.memo(RepeatSheet);
const MemoizedDatePickerModal = React.memo(DatePickerModal);
const MemoizedReminderScreen = React.memo(ReminderScreen);
function HabitDetailFormOverlayControllerComponent(
  {
    repeatSchedule,
    startDate,
    reminderEnabled,
    reminderTime,
    onRepeatApply,
    onStartDateConfirm,
    onReminderSave,
  }: HabitDetailFormOverlayControllerProps,
  ref: React.ForwardedRef<HabitDetailFormOverlayControllerHandle>,
) {
  const [session, setSession] = useState<FormOverlaySession | null>(null);
  const sessionRef = useRef<FormOverlaySession | null>(null);
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
  const openOverlay = useCallback((kind: FormOverlayKind) => {
    const current = sessionRef.current;
    if (current?.visible && current.kind === kind) {
      return;
    }
    dismissKeyboardForHabitFormOverlay();
    generationRef.current += 1;
    const next: FormOverlaySession = {
      kind,
      visible: true,
      generation: generationRef.current,
    };
    sessionRef.current = next;
    setSession(next);
  }, []);
  const closeOverlay = useCallback(
    (kind: FormOverlayKind, generation: number): boolean => {
      const current = sessionRef.current;
      if (
        current == null ||
        current.kind !== kind ||
        current.generation !== generation ||
        !current.visible
      ) {
        return false;
      }
      const next: FormOverlaySession = {
        ...current,
        visible: false,
      };
      sessionRef.current = next;
      setSession(next);
      return true;
    },
    [],
  );
  useImperativeHandle(
    ref,
    () => ({
      openRepeat() {
        openOverlay("repeat");
      },
      openStartDate() {
        openOverlay("start-date");
      },
      openReminders() {
        openOverlay("reminder");
      },
    }),
    [openOverlay],
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
          initialSchedule={repeatSchedule}
          onApply={(schedule) => applyRepeat(session.generation, schedule)}
          onCancel={() => closeOverlay("repeat", session.generation)}
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
        <MemoizedReminderScreen
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
}
export const HabitDetailFormOverlayController = React.memo(
  forwardRef(HabitDetailFormOverlayControllerComponent),
);
