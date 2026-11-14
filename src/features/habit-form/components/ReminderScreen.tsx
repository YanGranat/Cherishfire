/** @jsxImportSource nativewind */
import React, { useState } from "react";
import {
  View,
  Text,
  Pressable,
  Platform,
  useWindowDimensions,
} from "react-native";
import DateTimePicker, {
  DateTimePickerAndroid,
} from "@react-native-community/datetimepicker";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Toggle } from "@/components/ui/Toggle";
import { Dialog } from "@/components/ui/Dialog";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { getAccentScheme } from "@/theme/colors";
import {
  encodeReminderTimes,
  formatReminderTime,
  parseReminderTimes,
  removeReminderTimeIntent,
} from "@/domain/reminders/reminder-time";
import { useRetainedModalSession } from "@/hooks/useRetainedModalSession";
interface ReminderScreenProps {
  visible: boolean;
  enabled: boolean;
  time: string | null; // HH:MM or JSON array string
  onSave: (enabled: boolean, time: string | null) => void;
  onBack: () => void;
}
interface ReminderScreenSessionProps extends ReminderScreenProps {
  sessionKey: number;
  onDismiss: () => void;
}
type ReminderScreenSessionSnapshot = Pick<
  ReminderScreenProps,
  "enabled" | "time"
>;
interface IOSReminderPickerSession {
  generation: number;
  mode: "add" | "edit";
  index: number | null;
}
interface AndroidReminderPickerSession {
  generation: number;
  ownerSessionKey: number;
}
function ReminderScreenSession({
  sessionKey,
  visible,
  enabled: initialEnabled,
  time: initialTime,
  onSave,
  onBack,
  onDismiss,
}: ReminderScreenSessionProps) {
  const { t } = useTranslation();
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const { width: windowWidth } = useWindowDimensions();
  const [enabled, setEnabled] = useState(
    () => initialEnabled && parseReminderTimes(initialTime).length > 0,
  );
  const enabledRef = React.useRef(enabled);
  const [times, setTimes] = useState<string[]>(() =>
    parseReminderTimes(initialTime),
  );
  const timesRef = React.useRef(times);
  const [pickerIndex, setPickerIndex] = useState<number | null>(null);
  const pickerIndexRef = React.useRef<number | null>(null);
  const [isAddingTime, setIsAddingTime] = useState(false);
  const isAddingTimeRef = React.useRef(false);
  const [pickerValue, setPickerValue] = useState(new Date());
  const pickerValueRef = React.useRef(pickerValue);
  const visibleRef = React.useRef(visible);
  const committedSessionKeyRef = React.useRef(sessionKey);
  const androidPickerGenerationRef = React.useRef(0);
  const androidPickerSessionRef =
    React.useRef<AndroidReminderPickerSession | null>(null);
  const iosPickerGenerationRef = React.useRef(0);
  const iosPickerSessionRef = React.useRef<IOSReminderPickerSession | null>(
    null,
  );
  const updateEnabled = React.useCallback((nextEnabled: boolean) => {
    enabledRef.current = nextEnabled;
    setEnabled(nextEnabled);
  }, []);
  const updateTimes = React.useCallback((nextTimes: string[]) => {
    timesRef.current = nextTimes;
    setTimes(nextTimes);
  }, []);
  const updatePickerIndex = React.useCallback((nextIndex: number | null) => {
    pickerIndexRef.current = nextIndex;
    setPickerIndex(nextIndex);
  }, []);
  const updateIsAddingTime = React.useCallback((nextIsAdding: boolean) => {
    isAddingTimeRef.current = nextIsAdding;
    setIsAddingTime(nextIsAdding);
  }, []);
  const updatePickerValue = React.useCallback((nextValue: Date) => {
    pickerValueRef.current = nextValue;
    setPickerValue(nextValue);
  }, []);
  const beginIOSPickerSession = React.useCallback(
    (mode: IOSReminderPickerSession["mode"], index: number | null) => {
      const nextSession: IOSReminderPickerSession = {
        generation: iosPickerGenerationRef.current + 1,
        mode,
        index,
      };
      iosPickerGenerationRef.current = nextSession.generation;
      iosPickerSessionRef.current = nextSession;
      return nextSession;
    },
    [],
  );
  const invalidateIOSPickerSession = React.useCallback(() => {
    iosPickerGenerationRef.current += 1;
    iosPickerSessionRef.current = null;
  }, []);
  const mountedRef = React.useRef(true);
  const [observedSessionKey, setObservedSessionKey] = useState(sessionKey);
  const dismissAndroidTimePicker = React.useCallback(() => {
    if (Platform.OS !== "android") return;
    void DateTimePickerAndroid.dismiss("time").catch(() => {});
  }, []);
  const invalidateAndroidPickerSession = React.useCallback(
    (dismissNative = true) => {
      androidPickerGenerationRef.current += 1;
      const activeSession = androidPickerSessionRef.current;
      androidPickerSessionRef.current = null;
      if (!activeSession) return;
      if (dismissNative) {
        dismissAndroidTimePicker();
      }
    },
    [dismissAndroidTimePicker],
  );
  if (observedSessionKey !== sessionKey) {
    const nextTimes = parseReminderTimes(initialTime);
    const nextEnabled = initialEnabled && nextTimes.length > 0;
    const nextPickerValue = new Date();
    iosPickerGenerationRef.current += 1;
    iosPickerSessionRef.current = null;
    enabledRef.current = nextEnabled;
    timesRef.current = nextTimes;
    pickerIndexRef.current = null;
    isAddingTimeRef.current = false;
    pickerValueRef.current = nextPickerValue;
    setObservedSessionKey(sessionKey);
    setEnabled(nextEnabled);
    setTimes(nextTimes);
    setPickerIndex(null);
    setIsAddingTime(false);
    setPickerValue(nextPickerValue);
  }
  React.useLayoutEffect(() => {
    const didSessionChange = committedSessionKeyRef.current !== sessionKey;
    committedSessionKeyRef.current = sessionKey;
    if (didSessionChange) {
      invalidateAndroidPickerSession();
    }
  }, [invalidateAndroidPickerSession, sessionKey]);
  const accent = getAccentScheme(colorScheme).base;
  const addButtonBackgroundColor = isDark ? "#2E2E2E" : "#F1F1F1";
  const addButtonIconColor = isDark ? "#D4D4D4" : "#666666";
  const removeButtonIconColor = isDark ? "#B0B0B0" : "#666666";
  const pendingNewTime = formatReminderTime(pickerValue);
  const effectiveTimes =
    enabled && isAddingTime && Platform.OS === "ios"
      ? [...times, pendingNewTime]
      : times;
  const hasDuplicateTimes =
    new Set(effectiveTimes).size !== effectiveTimes.length;
  const canSave = !enabled || (effectiveTimes.length > 0 && !hasDuplicateTimes);
  // datetimepicker 8.4.4 measures its Fabric iOS wheel at the native
  // UIDatePicker width plus a 10pt compatibility allowance. Keep the dialog's
  // inner width at least 290pt so the wheel cannot be clipped by the standard
  // 256pt Dialog content area. Portrait iPhones supported by Expo SDK 54 have
  // enough room for the 16pt outer margin used here.
  const iosTimePickerWidth = 290;
  const iosDialogWidth = Math.min(338, windowWidth - 16);
  const iosDialogHorizontalPadding = Math.max(
    0,
    (iosDialogWidth - iosTimePickerWidth) / 2,
  );
  React.useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateAndroidPickerSession();
    };
  }, [invalidateAndroidPickerSession]);
  React.useLayoutEffect(() => {
    visibleRef.current = visible;
    if (!visible) {
      invalidateAndroidPickerSession();
      invalidateIOSPickerSession();
    }
  }, [invalidateAndroidPickerSession, invalidateIOSPickerSession, visible]);
  const closePicker = () => {
    invalidateAndroidPickerSession();
    invalidateIOSPickerSession();
    updatePickerIndex(null);
    updateIsAddingTime(false);
  };
  const getTimePickerValue = (timeValue: string) => {
    const [hours, minutes] = timeValue.split(":").map(Number);
    const value = new Date();
    value.setHours(hours, minutes, 0, 0);
    return value;
  };
  const openAndroidTimePicker = (
    value: Date,
    onConfirm: (selectedDate: Date) => void,
    callbacks: {
      onDismiss?: () => void;
      onOpenError?: () => void;
    } = {},
  ) => {
    const activeSession = androidPickerSessionRef.current;
    if (activeSession) {
      return;
    }
    const pickerSession: AndroidReminderPickerSession = {
      generation: androidPickerGenerationRef.current + 1,
      ownerSessionKey: committedSessionKeyRef.current,
    };
    androidPickerGenerationRef.current = pickerSession.generation;
    androidPickerSessionRef.current = pickerSession;
    const consumeCurrentPickerSession = (): boolean => {
      const currentSession = androidPickerSessionRef.current;
      const isCurrent =
        mountedRef.current &&
        visibleRef.current &&
        currentSession?.generation === pickerSession.generation &&
        currentSession.ownerSessionKey === pickerSession.ownerSessionKey &&
        committedSessionKeyRef.current === pickerSession.ownerSessionKey;
      if (!isCurrent) {
        return false;
      }
      androidPickerSessionRef.current = null;
      return true;
    };
    const handleOpenError = () => {
      if (!consumeCurrentPickerSession()) {
        return;
      }
      callbacks.onOpenError?.();
    };
    try {
      DateTimePickerAndroid.open({
        value,
        mode: "time",
        is24Hour: true,
        display: "default",
        positiveButton: {
          label: t("common.save"),
          textColor: accent,
        },
        negativeButton: {
          label: t("common.cancel"),
          textColor: removeButtonIconColor,
        },
        onError: handleOpenError,
        onChange: (event, selectedDate) => {
          if (!consumeCurrentPickerSession()) {
            return;
          }
          if (event.type === "dismissed") {
            callbacks.onDismiss?.();
            return;
          }
          if (!selectedDate) {
            callbacks.onDismiss?.();
            return;
          }
          onConfirm(selectedDate);
        },
      });
    } catch {
      handleOpenError();
      return;
    }
  };
  const updateTimeAtIndex = (index: number, date: Date) => {
    const nextValue = formatReminderTime(date);
    const previousTimes = timesRef.current;
    if (previousTimes[index] === nextValue) {
      return;
    }
    const nextTimes = previousTimes.map((value, currentIndex) =>
      currentIndex === index ? nextValue : value,
    );
    updateTimes(nextTimes);
  };
  const handleEditReminder = (index: number) => {
    const target = timesRef.current[index];
    if (!target) {
      return;
    }
    const value = getTimePickerValue(target);
    if (Platform.OS === "android") {
      openAndroidTimePicker(value, (selectedDate) => {
        updateTimeAtIndex(index, selectedDate);
      });
      return;
    }
    beginIOSPickerSession("edit", index);
    updatePickerValue(value);
    updateIsAddingTime(false);
    updatePickerIndex(index);
  };
  const handleSave = () => {
    const currentEnabled = enabledRef.current;
    const currentTimes =
      currentEnabled && isAddingTimeRef.current && Platform.OS === "ios"
        ? [...timesRef.current, formatReminderTime(pickerValueRef.current)]
        : timesRef.current;
    const hasCanonicalDuplicateTimes =
      new Set(currentTimes).size !== currentTimes.length;
    if (
      currentEnabled &&
      (currentTimes.length === 0 || hasCanonicalDuplicateTimes)
    ) {
      return;
    }
    const encoded = encodeReminderTimes(currentEnabled ? currentTimes : []);
    invalidateAndroidPickerSession();
    invalidateIOSPickerSession();
    onSave(Boolean(encoded) && currentEnabled, encoded);
  };
  const handleAddReminder = (rollbackEnabledOnCancel = false) => {
    const now = new Date();
    now.setSeconds(0, 0);
    if (Platform.OS === "android") {
      openAndroidTimePicker(
        now,
        (selectedDate) => {
          const nextValue = formatReminderTime(selectedDate);
          const previousTimes = timesRef.current;
          const nextTimes = [...previousTimes, nextValue];
          updateTimes(nextTimes);
          updateEnabled(true);
        },
        rollbackEnabledOnCancel
          ? {
              onDismiss: () => {
                updateEnabled(false);
              },
              onOpenError: () => {
                updateEnabled(false);
              },
            }
          : undefined,
      );
      return;
    }
    beginIOSPickerSession("add", null);
    updatePickerValue(now);
    updatePickerIndex(null);
    updateIsAddingTime(true);
  };
  const handleToggle = (nextEnabled: boolean) => {
    if (!nextEnabled) {
      updateEnabled(false);
      closePicker();
      return;
    }
    if (timesRef.current.length === 0) {
      updateEnabled(true);
      handleAddReminder(Platform.OS === "android");
      return;
    }
    updateEnabled(true);
  };
  const handleRemoveReminder = (index: number) => {
    const target = timesRef.current[index];
    const removal =
      target == null
        ? { times: timesRef.current, removedIndex: null }
        : removeReminderTimeIntent(timesRef.current, target);
    if (removal.removedIndex == null) {
      return;
    }
    const removedIndex = removal.removedIndex;
    updateTimes(removal.times);
    if (removal.times.length === 0) {
      updateEnabled(false);
      closePicker();
    } else {
      const currentIndex = pickerIndexRef.current;
      const nextIndex =
        currentIndex == null || currentIndex === removedIndex
          ? null
          : currentIndex > removedIndex
            ? currentIndex - 1
            : currentIndex;
      if (currentIndex === removedIndex) {
        closePicker();
      } else {
        if (
          Platform.OS === "ios" &&
          currentIndex != null &&
          nextIndex != null &&
          nextIndex !== currentIndex
        ) {
          beginIOSPickerSession("edit", nextIndex);
        }
        updatePickerIndex(nextIndex);
      }
    }
  };
  const handleBack = () => {
    invalidateAndroidPickerSession();
    invalidateIOSPickerSession();
    onBack();
  };
  const handleDismiss = () => {
    invalidateAndroidPickerSession();
    invalidateIOSPickerSession();
    onDismiss();
  };
  const renderedIOSPickerSession = iosPickerSessionRef.current;
  return (
    <Dialog
      visible={visible}
      onDismiss={handleDismiss}
      title={t("reminderScreen.title")}
      titleAccessory={
        <Pressable
          onPress={() => {
            handleToggle(!enabled);
          }}
          accessibilityRole="switch"
          accessibilityLabel={t("reminderScreen.title")}
          accessibilityState={{ checked: enabled }}
        >
          <View
            pointerEvents="none"
            accessible={false}
            importantForAccessibility="no-hide-descendants"
          >
            <Toggle value={enabled} onValueChange={handleToggle} />
          </View>
        </Pressable>
      }
      actions={[
        {
          label: t("common.cancel"),
          onPress: handleBack,
          role: "cancel",
        },
        {
          label: t("common.save"),
          onPress: handleSave,
          disabled: !canSave,
        },
      ]}
      contentStyle={[
        { paddingTop: 20, paddingBottom: 20 },
        Platform.OS === "ios"
          ? {
              width: iosDialogWidth,
              paddingHorizontal: iosDialogHorizontalPadding,
            }
          : null,
      ]}
    >
      {enabled &&
        times.map((timeValue, index) => (
          <View
            key={`${timeValue}-${index}`}
            className="mb-sm flex-row items-center rounded-input border border-border"
          >
            <Pressable
              onPress={() => {
                handleEditReminder(index);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${t("reminderScreen.timeLabel")} ${timeValue}`}
              className="flex-1 px-md py-sm"
            >
              <Text className="text-primary text-base">{timeValue}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                handleRemoveReminder(index);
              }}
              accessibilityRole="button"
              accessibilityLabel={t("reminderScreen.removeTime", {
                time: timeValue,
              })}
              className="px-sm py-sm"
            >
              <MaterialIcons
                name="close"
                size={20}
                color={removeButtonIconColor}
              />
            </Pressable>
          </View>
        ))}
      {enabled ? (
        <Pressable
          onPress={() => {
            handleAddReminder();
          }}
          accessibilityRole="button"
          accessibilityLabel={t("reminderScreen.addTime")}
          className="mb-sm flex-row items-center justify-center rounded-input border border-border px-md py-sm"
          style={{ backgroundColor: addButtonBackgroundColor }}
        >
          <MaterialIcons name="add" size={20} color={addButtonIconColor} />
        </Pressable>
      ) : null}

      {enabled && hasDuplicateTimes ? (
        <Text accessibilityRole="alert" className="mb-sm text-sm text-red-500">
          {t("reminderScreen.duplicateTime")}
        </Text>
      ) : null}

      {enabled &&
      (pickerIndex != null || isAddingTime) &&
      renderedIOSPickerSession != null &&
      Platform.OS === "ios" ? (
        <View className="items-center mt-xs">
          <DateTimePicker
            key={renderedIOSPickerSession.generation}
            value={pickerValue}
            mode="time"
            is24Hour
            display="spinner"
            accentColor={accent}
            themeVariant={isDark ? "dark" : "light"}
            style={{ width: iosTimePickerWidth }}
            onChange={(event, selectedDate) => {
              if (
                !mountedRef.current ||
                !visibleRef.current ||
                renderedIOSPickerSession == null ||
                iosPickerSessionRef.current?.generation !==
                  renderedIOSPickerSession.generation
              ) {
                return;
              }
              if (event.type === "dismissed") {
                return;
              }
              if (!selectedDate) {
                return;
              }
              const selectedValue = formatReminderTime(selectedDate);
              const currentPickerIndex =
                renderedIOSPickerSession.mode === "edit"
                  ? renderedIOSPickerSession.index
                  : null;
              const currentValue =
                currentPickerIndex != null
                  ? timesRef.current[currentPickerIndex]
                  : formatReminderTime(pickerValueRef.current);
              if (selectedValue === currentValue) {
                return;
              }
              updatePickerValue(selectedDate);
              if (currentPickerIndex != null) {
                updateTimeAtIndex(currentPickerIndex, selectedDate);
              }
            }}
          />
        </View>
      ) : null}
    </Dialog>
  );
}
function ReminderScreenComponent(props: ReminderScreenProps) {
  const { session, handleDismiss } =
    useRetainedModalSession<ReminderScreenSessionSnapshot>(
      props.visible,
      () => ({
        enabled: props.enabled,
        time: props.time,
      }),
    );
  if (session == null) return null;
  const snapshot = session.snapshot;
  return (
    <ReminderScreenSession
      sessionKey={session.key}
      visible={props.visible}
      enabled={snapshot.enabled}
      time={snapshot.time}
      onSave={props.onSave}
      onBack={props.onBack}
      onDismiss={handleDismiss}
    />
  );
}
export const ReminderScreen = React.memo(ReminderScreenComponent);
