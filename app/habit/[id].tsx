/** @jsxImportSource nativewind */
import React, {
  useState,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { View, Text, ActivityIndicator, Pressable } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Header } from "@/components/layout/Header";
import { ScreenWrapper } from "@/components/layout/ScreenWrapper";
import { InlineErrorBanner } from "@/components/ui/InlineErrorBanner";
import { InlineDescription } from "@/features/habit-detail/components/InlineDescription";
import { ProgressStats } from "@/features/habit-detail/components/ProgressStats";
import { EditRows } from "@/features/habit-detail/components/EditRows";
import { MonthCalendar } from "@/features/habit-detail/components/MonthCalendar";
import {
  HabitDetailMenuController,
  type HabitDetailMenuControllerHandle,
} from "@/features/habit-detail/components/HabitDetailMenuController";
import {
  HabitDetailFormOverlayController,
  type HabitDetailFormOverlayControllerHandle,
} from "@/features/habit-detail/components/HabitDetailFormOverlayController";
import {
  HabitDetailStatusOverlayController,
  type HabitDetailDayStatusCommand,
  type HabitDetailStatusOverlayControllerHandle,
} from "@/features/habit-detail/components/HabitDetailStatusOverlayController";
import { useHabitDetail } from "@/features/habit-detail/hooks/useHabitDetail";
import { useHabitStore } from "@/stores/habit-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { lightTheme, darkTheme, getAccentScheme } from "@/theme/colors";
import {
  areRepeatSchedulesEqual,
  type DayStatus,
  type RepeatSchedule,
} from "@/types/habit";
import { FocusedRouteModuleWarmup } from "@/components/FocusedRouteModuleWarmup";
import { notesApplication } from "@/composition/notes";
import { prewarmDatePickerMonthModels } from "@/features/habit-form/utils/date-picker-month-model";
import { parseHabitRouteId } from "@/domain/habits/route-id";
import { resolveHabitDetailPresentationState } from "@/features/habit-detail/utils/presentation-state";
import { OneShotActionGate } from "@/application/interaction/one-shot-action-gate";
import { useNavigationIntentGate } from "@/hooks/useNavigationIntentGate";
function mixHexColor(hexA: string, hexB: string, amount: number): string {
  const t = Math.max(0, Math.min(1, amount));
  const a = hexA.replace("#", "");
  const b = hexB.replace("#", "");
  if (a.length !== 6 || b.length !== 6) return hexA;
  const ar = parseInt(a.slice(0, 2), 16);
  const ag = parseInt(a.slice(2, 4), 16);
  const ab = parseInt(a.slice(4, 6), 16);
  const br = parseInt(b.slice(0, 2), 16);
  const bg = parseInt(b.slice(2, 4), 16);
  const bb = parseInt(b.slice(4, 6), 16);
  const rr = Math.round(ar + (br - ar) * t);
  const rg = Math.round(ag + (bg - ag) * t);
  const rb = Math.round(ab + (bb - ab) * t);
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${toHex(rr)}${toHex(rg)}${toHex(rb)}`;
}
interface DetailActionResult {
  succeeded: boolean;
  isLatest: boolean;
}
function HabitDetailScreenContent({ habitId }: { habitId: number }) {
  const router = useRouter();
  const runNavigationIntent = useNavigationIntentGate();
  const { t } = useTranslation();
  const colorScheme = useVisualColorScheme();
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const accent = getAccentScheme(colorScheme);
  const saveActionColor = mixHexColor(accent.base, accent.pale, 0.28);
  const screenBg = isDark ? darkTheme.background : lightTheme.background;
  const stackScreenOptions = useMemo(
    () => ({
      animation: "none" as const,
      contentStyle: { backgroundColor: screenBg },
    }),
    [screenBg],
  );
  const loaderColor = isDark ? darkTheme.muted : lightTheme.muted;
  const updateHabit = useHabitStore((s) => s.updateHabit);
  const renameHabit = useHabitStore((s) => s.renameHabit);
  const archiveHabit = useHabitStore((s) => s.archiveHabit);
  const deleteHabit = useHabitStore((s) => s.deleteHabit);
  const markDay = useHabitStore((s) => s.markDay);
  const unmarkDay = useHabitStore((s) => s.unmarkDay);
  const {
    habit,
    records,
    stats,
    isContentReady,
    error,
    reload,
    patchHabit,
  } = useHabitDetail(habitId);
  const presentationState = resolveHabitDetailPresentationState({
    hasHabit: habit != null,
    isContentReady,
    hasError: error != null,
  });
  const habitRef = useRef(habit);
  habitRef.current = habit;
  const formOverlayStartDate = habit?.startDate ?? "1970-01-01";
  const openNotes = useCallback(() => {
    const target = `/habit/${habitId}/notes`;
    const result = runNavigationIntent({
      target,
      dispatch: () => {
        router.push(target);
      },
    });
    if (result.status === "blocked") {
    } else if (result.status === "failed") {
      console.error("Failed to open habit notes", result.error);
    }
  }, [habitId, router, runNavigationIntent]);
  // UI state
  const [isDescriptionEditing, setIsDescriptionEditing] = useState(false);
  const [descriptionRecoveryDraft, setDescriptionRecoveryDraft] = useState<{
    sequence: number;
    text: string;
  } | null>(null);
  const descriptionRecoverySequenceRef = useRef(0);
  const [actionError, setActionError] = useState(false);
  const actionErrorMessage = actionError ? t("detail.actionError") : null;
  const actionVersionsRef = useRef(new Map<string, number>());
  const saveDescriptionHandlerRef = useRef<(() => void) | null>(null);
  const registerDescriptionSaveHandler = useCallback(
    (handler: (() => void) | null) => {
      saveDescriptionHandlerRef.current = handler;
    },
    [],
  );
  const terminalMutationGateRef = useRef<OneShotActionGate | null>(null);
  const menuControllerRef = useRef<HabitDetailMenuControllerHandle>(null);
  const formOverlayControllerRef =
    useRef<HabitDetailFormOverlayControllerHandle>(null);
  const statusOverlayControllerRef =
    useRef<HabitDetailStatusOverlayControllerHandle>(null);
  const claimTerminalMutation = useCallback(() => {
    terminalMutationGateRef.current ??= new OneShotActionGate();
    if (terminalMutationGateRef.current.claim()) return true;
    return false;
  }, []);
  const runDetailAction = useCallback(
    (
      action: string,
      operation: () => Promise<void>,
    ): Promise<DetailActionResult> => {
      const actionScope =
        action === "repeat" || action === "start-date" ? "schedule" : action;
      const version = (actionVersionsRef.current.get(actionScope) ?? 0) + 1;
      actionVersionsRef.current.set(actionScope, version);
      setActionError(false);
      // SQLite already has one serial owner. Start each store mutation in the
      // user's event turn so a newer schedule/date intent can claim ownership
      // before an older database operation publishes its result.
      return (async () => {
        try {
          await operation();
          return {
            succeeded: true,
            isLatest: actionVersionsRef.current.get(actionScope) === version,
          };
        } catch (operationError) {
          console.error(
            `Habit detail action failed: ${action}`,
            operationError,
          );
          const isLatest =
            actionVersionsRef.current.get(actionScope) === version;
          if (isLatest) setActionError(true);
          return { succeeded: false, isLatest };
        }
      })();
    },
    [],
  );
  const handleDescriptionSave = useCallback(
    (text: string) => {
      const currentHabit = habitRef.current;
      if (!currentHabit) return false;
      const previousDescription = currentHabit.description;
      patchHabit({ description: text });
      void runDetailAction("description", async () => {
        await updateHabit(habitId, { description: text });
      }).then(({ succeeded, isLatest }) => {
        if (succeeded || !isLatest) return;
        patchHabit({ description: previousDescription });
        descriptionRecoverySequenceRef.current += 1;
        setDescriptionRecoveryDraft({
          sequence: descriptionRecoverySequenceRef.current,
          text,
        });
        void reload();
      });
      return true;
    },
    [habitId, patchHabit, reload, runDetailAction, updateHabit],
  );
  const handleToggleDescription = useCallback(() => {
    if (!habitRef.current || habitRef.current.isArchived) {
      return;
    }
    setActionError(false);
    const previousDescriptionVisible = habitRef.current.descriptionVisible;
    const descriptionVisible = !previousDescriptionVisible;
    patchHabit({ descriptionVisible });
    habitRef.current = {
      ...habitRef.current,
      descriptionVisible,
      updatedAt: Date.now(),
    };
    void runDetailAction("description-visibility", async () => {
      await updateHabit(habitId, { descriptionVisible });
    }).then(({ succeeded, isLatest }) => {
      if (succeeded || !isLatest) return;
      if (habitRef.current) {
        habitRef.current = {
          ...habitRef.current,
          descriptionVisible: previousDescriptionVisible,
          updatedAt: Date.now(),
        };
      }
      patchHabit({ descriptionVisible: previousDescriptionVisible });
    });
  }, [habitId, patchHabit, runDetailAction, updateHabit]);
  const handleRename = useCallback(
    (name: string) => {
      const currentHabit = habitRef.current;
      if (!currentHabit || currentHabit.isArchived) return;
      const previousName = currentHabit.name;
      patchHabit({ name });
      void runDetailAction("rename", async () => {
        await renameHabit(habitId, name);
      }).then(({ succeeded, isLatest }) => {
        if (succeeded || !isLatest) return;
        patchHabit({ name: previousName });
        void reload();
      });
    },
    [habitId, patchHabit, reload, renameHabit, runDetailAction],
  );
  const handleArchive = useCallback(() => {
    if (!claimTerminalMutation()) return;
    const persistence = archiveHabit(habitId);
    router.back();
    void persistence.catch((archiveError) => {
      console.error("Failed to archive habit", archiveError);
    });
  }, [archiveHabit, claimTerminalMutation, habitId, router]);
  const handleDelete = useCallback(() => {
    if (!claimTerminalMutation()) return;
    const persistence = deleteHabit(habitId);
    router.back();
    void persistence.catch((deleteError) => {
      console.error("Failed to delete habit", deleteError);
    });
  }, [claimTerminalMutation, deleteHabit, habitId, router]);
  const clearActionError = useCallback(() => setActionError(false), []);
  // Calendar data stays referentially stable while unrelated detail UI changes.
  const dayData = useMemo(
    () =>
      records.map((record) => ({
        date: record.date,
        status: record.status,
        isArchived: false,
      })),
    [records],
  );
  const persistDayStatus = useCallback(
    (date: string, status: DayStatus, reason?: string) => {
      void markDay(habitId, date, status, reason).then(async (succeeded) => {
        if (succeeded) return;
        setActionError(true);
        await reload();
      });
    },
    [habitId, markDay, reload],
  );
  const handleDayStatusApply = useCallback(
    (command: HabitDetailDayStatusCommand) => {
      const currentHabit = habitRef.current;
      if (!currentHabit || currentHabit.isArchived) {
        return;
      }
      persistDayStatus(command.date, command.status, command.reason);
    },
    [persistDayStatus],
  );
  useLayoutEffect(
    () => () => {
      statusOverlayControllerRef.current?.flushPendingCommandBeforeOwnerUnmount();
    },
    [],
  );
  const persistDayRemoval = useCallback(
    (date: string) => {
      void unmarkDay(habitId, date).then(async (succeeded) => {
        if (succeeded) return;
        setActionError(true);
        await reload();
      });
    },
    [habitId, reload, unmarkDay],
  );
  // Day tap: toggle done/unmarked
  const handleDayPress = useCallback(
    (date: string) => {
      if (habit?.isArchived) {
        return;
      }
      const existing = records.find((record) => record.date === date);
      if (existing) {
        persistDayRemoval(date);
      } else {
        persistDayStatus(date, "done");
      }
    },
    [
      habit?.isArchived,
      persistDayRemoval,
      persistDayStatus,
      records,
    ],
  );
  // Day long press: show menu
  const handleDayLongPress = useCallback(
    (date: string, pageX: number, pageY: number) => {
      if (habitRef.current?.isArchived) return;
      const controller = statusOverlayControllerRef.current;
      if (!controller) {
        return;
      }
      controller.openDayMenu({
        date,
        x: pageX,
        y: pageY,
      });
    },
    [],
  );
  const handleRepeatPress = useCallback(() => {
    formOverlayControllerRef.current?.openRepeat();
  }, []);
  const handleStartDatePress = useCallback(() => {
    formOverlayControllerRef.current?.openStartDate();
  }, []);
  const handleReminderPress = useCallback(() => {
    formOverlayControllerRef.current?.openReminders();
  }, []);
  const handleRepeatApply = useCallback(
    (schedule: RepeatSchedule) => {
      const currentHabit = habitRef.current;
      if (!currentHabit) {
        return;
      }
      if (currentHabit.isArchived) {
        return;
      }
      if (areRepeatSchedulesEqual(currentHabit.repeatSchedule, schedule)) {
        return;
      }
      const previousStartDate = currentHabit.startDate;
      void runDetailAction("repeat", async () => {
        // The latest schedule intent always persists the complete visible
        // pair. Otherwise a rapid date -> repeat edit could supersede the
        // first transaction and accidentally lose the chosen start date.
        await updateHabit(habitId, {
          repeatSchedule: schedule,
          startDate: previousStartDate,
        });
      }).then(({ succeeded, isLatest }) => {
        if (succeeded || !isLatest) return;
        void reload(true);
      });
    },
    [
      habitId,
      reload,
      runDetailAction,
      updateHabit,
    ],
  );
  const handleStartDateConfirm = useCallback(
    (date: string) => {
      const currentHabit = habitRef.current;
      if (!currentHabit) {
        return;
      }
      if (currentHabit.isArchived) {
        return;
      }
      const nextStartDate = date;
      if (nextStartDate === currentHabit.startDate) {
        return;
      }
      const previousSchedule = currentHabit.repeatSchedule;
      void runDetailAction("start-date", async () => {
        await updateHabit(habitId, {
          startDate: nextStartDate,
          repeatSchedule: previousSchedule,
        });
      }).then(({ succeeded, isLatest }) => {
        if (succeeded || !isLatest) return;
        void reload(true);
      });
    },
    [
      habitId,
      reload,
      runDetailAction,
      updateHabit,
    ],
  );
  const handleReminderSave = useCallback(
    (enabled: boolean, time: string | null) => {
      const currentHabit = habitRef.current;
      if (!currentHabit) {
        return;
      }
      if (currentHabit.isArchived) {
        return;
      }
      const nextEnabled = enabled && Boolean(time);
      const nextTime = nextEnabled ? time : null;
      if (
        currentHabit.reminderEnabled === nextEnabled &&
        currentHabit.reminderTime === nextTime
      ) {
        return;
      }
      const previousReminderEnabled = currentHabit.reminderEnabled;
      const previousReminderTime = currentHabit.reminderTime;
      patchHabit({
        reminderEnabled: nextEnabled,
        reminderTime: nextTime,
      });
      void runDetailAction("reminder", async () => {
        await updateHabit(habitId, {
          reminderEnabled: nextEnabled,
          reminderTime: nextTime,
        });
      }).then(({ succeeded, isLatest }) => {
        if (succeeded || !isLatest) return;
        patchHabit({
          reminderEnabled: previousReminderEnabled,
          reminderTime: previousReminderTime,
        });
      });
    },
    [habitId, patchHabit, runDetailAction, updateHabit],
  );
  const handleBack = useCallback(() => {
    router.back();
  }, [router]);
  const handleReturnHome = useCallback(() => {
    router.replace("/");
  }, [router]);
  const handleDescriptionSavePress = useCallback(() => {
    saveDescriptionHandlerRef.current?.();
  }, []);
  const handleMenuOpen = useCallback(() => {
    menuControllerRef.current?.openMenu();
  }, []);
  const isArchived = habit?.isArchived ?? false;
  const headerActions = useMemo<
    React.ComponentProps<typeof Header>["rightActions"]
  >(() => {
    if (isDescriptionEditing) {
      return [
        {
          customIcon: (
            <Text
              style={{
                color: saveActionColor,
                fontSize: 14.5,
                fontWeight: "600",
                position: "relative",
                left: -8,
              }}
            >
              {t("common.save")}
            </Text>
          ),
          accessibilityLabel: t("common.save"),
          onPress: handleDescriptionSavePress,
        },
      ];
    }
    const notesAction = {
      icon: "sticky-note-2" as const,
      accessibilityLabel: t("accessibility.openNotes"),
      onPress: openNotes,
    };
    return isArchived
      ? [notesAction]
      : [
          notesAction,
          {
            icon: "more-vert",
            accessibilityLabel: t("accessibility.moreOptions"),
            onPress: handleMenuOpen,
          },
        ];
  }, [
    handleDescriptionSavePress,
    handleMenuOpen,
    isArchived,
    isDescriptionEditing,
    openNotes,
    saveActionColor,
    t,
  ]);
  if (presentationState === "loading") {
    return (
      <>
        <Stack.Screen options={stackScreenOptions} />
        <ScreenWrapper backgroundColor={screenBg}>
          <Header
            title={habit?.name ?? t("detail.title")}
            showBack
            onBack={handleBack}
            backgroundColor={screenBg}
          />
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <ActivityIndicator size="small" color={loaderColor} />
          </View>
        </ScreenWrapper>
      </>
    );
  }
  if (presentationState === "error") {
    return (
      <>
        <Stack.Screen options={stackScreenOptions} />
        <ScreenWrapper backgroundColor={screenBg}>
          <Header
            title={habit?.name ?? t("detail.title")}
            showBack
            onBack={handleBack}
            backgroundColor={screenBg}
          />
          <View className="flex-1 items-center justify-center px-xl">
            <MaterialIcons name="error-outline" size={52} color={loaderColor} />
            <Text className="mt-md text-center text-base text-muted">
              {t("detail.loadError")}
            </Text>
            <Pressable
              onPress={() => {
                void reload();
              }}
              accessibilityRole="button"
              accessibilityLabel={t("detail.retry")}
              className="mt-md min-h-[44px] items-center justify-center px-lg"
            >
              <Text className="text-base font-semibold text-primary">
                {t("detail.retry")}
              </Text>
            </Pressable>
          </View>
        </ScreenWrapper>
      </>
    );
  }
  if (presentationState === "missing" || !habit) {
    return (
      <>
        <Stack.Screen options={stackScreenOptions} />
        <ScreenWrapper backgroundColor={screenBg}>
          <Header
            title={t("detail.title")}
            showBack
            onBack={handleReturnHome}
            backgroundColor={screenBg}
          />
          <View className="flex-1 items-center justify-center px-xl">
            <MaterialIcons name="search-off" size={52} color={loaderColor} />
            <Text className="mt-md text-center text-base text-muted">
              {t("detail.notFound")}
            </Text>
            <Pressable
              onPress={() => {
                router.replace("/");
              }}
              accessibilityRole="button"
              accessibilityLabel={t("common.returnHome")}
              className="mt-md min-h-[44px] items-center justify-center px-lg"
            >
              <Text className="text-base font-semibold text-primary">
                {t("common.returnHome")}
              </Text>
            </Pressable>
          </View>
        </ScreenWrapper>
      </>
    );
  }
  return (
    <>
      <Stack.Screen options={stackScreenOptions} />
      <ScreenWrapper scrollable backgroundColor={screenBg}>
        <Header
          title={habit.name}
          showBack
          onBack={handleBack}
          backgroundColor={screenBg}
          rightActions={headerActions}
        />

        {actionErrorMessage ? (
          <InlineErrorBanner message={actionErrorMessage} />
        ) : null}

        {/* Description */}
        <InlineDescription
          habitId={habitId}
          description={habit.description}
          visible={isArchived || habit.descriptionVisible}
          editable
          onEditingChange={setIsDescriptionEditing}
          registerSaveHandler={registerDescriptionSaveHandler}
          onSave={handleDescriptionSave}
          recoveryDraft={descriptionRecoveryDraft}
        />

        {/* Progress */}
        <ProgressStats
          currentStreak={stats.current}
          bestStreak={stats.best}
          totalCompletions={stats.total}
        />

        {/* Edit rows */}
        <EditRows
          repeatSchedule={habit.repeatSchedule}
          startDate={habit.startDate}
          reminderEnabled={habit.reminderEnabled}
          reminderTime={habit.reminderTime}
          onRepeatPress={handleRepeatPress}
          onStartDatePress={handleStartDatePress}
          onReminderPress={handleReminderPress}
          disabled={isArchived}
        />

        {/* Month calendar */}
        <MonthCalendar
          dayData={dayData}
          startDate={habit.startDate}
          repeatSchedule={habit.repeatSchedule}
          scheduleHistory={habit.scheduleHistory}
          isHabitArchived={habit.isArchived}
          archiveHistory={habit.archiveHistory}
          onDayPress={handleDayPress}
          onDayLongPress={handleDayLongPress}
        />

        {/* Overlays */}
        <HabitDetailMenuController
          ref={menuControllerRef}
          habitName={habit.name}
          descriptionVisible={habit.descriptionVisible}
          isArchived={isArchived}
          actionError={actionErrorMessage}
          onClearActionError={clearActionError}
          onToggleDescription={handleToggleDescription}
          onRename={handleRename}
          onArchive={handleArchive}
          onDelete={handleDelete}
        />

        <HabitDetailFormOverlayController
          ref={formOverlayControllerRef}
          repeatSchedule={habit.repeatSchedule}
          startDate={formOverlayStartDate}
          reminderEnabled={habit.reminderEnabled}
          reminderTime={habit.reminderTime}
          onRepeatApply={handleRepeatApply}
          onStartDateConfirm={handleStartDateConfirm}
          onReminderSave={handleReminderSave}
        />

        <HabitDetailStatusOverlayController
          ref={statusOverlayControllerRef}
          onApplyStatus={handleDayStatusApply}
        />
      </ScreenWrapper>
    </>
  );
}
export default function HabitDetailScreen() {
  const { id } = useLocalSearchParams<{
    id: string;
  }>();
  const habitId = parseHabitRouteId(id);
  return habitId == null ? (
    <MissingHabitDetailRoute />
  ) : (
    <ResolvedHabitDetailRoute key={String(habitId)} habitId={habitId} />
  );
}
function ResolvedHabitDetailRoute({ habitId }: { habitId: number }) {
  const warmups = useMemo(
    () => [
      { route: "/habit/:id/notes", load: () => import("./[id]/notes") },
      {
        route: `notes-cache:${habitId}`,
        repeatable: true,
        load: () => notesApplication.prewarm(habitId),
      },
      {
        route: `date-picker-cache:${habitId}`,
        repeatable: true,
        load: async () => {
          const state = useHabitStore.getState();
          const cachedHabit =
            state.allHabits.find((candidate) => candidate.id === habitId) ??
            state.habits.find((candidate) => candidate.id === habitId);
          if (!cachedHabit) return;
          prewarmDatePickerMonthModels(
            cachedHabit.startDate,
            useSettingsStore.getState().language,
          );
        },
      },
    ],
    [habitId],
  );
  return (
    <>
      <FocusedRouteModuleWarmup entries={warmups} />
      <HabitDetailScreenContent key={String(habitId)} habitId={habitId} />
    </>
  );
}
function MissingHabitDetailRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const screenBg = isDark ? darkTheme.background : lightTheme.background;
  const iconColor = isDark ? darkTheme.muted : lightTheme.muted;
  const stackScreenOptions = useMemo(
    () => ({
      animation: "none" as const,
      contentStyle: { backgroundColor: screenBg },
    }),
    [screenBg],
  );
  const handleReturnHome = useCallback(() => {
    router.replace("/");
  }, [router]);
  return (
    <>
      <Stack.Screen options={stackScreenOptions} />
      <ScreenWrapper backgroundColor={screenBg}>
        <Header
          title={t("detail.title")}
          showBack
          onBack={handleReturnHome}
          backgroundColor={screenBg}
        />
        <View className="flex-1 items-center justify-center px-xl">
          <MaterialIcons name="search-off" size={52} color={iconColor} />
          <Text className="mt-md text-center text-base text-muted">
            {t("detail.notFound")}
          </Text>
          <Pressable
            onPress={() => {
              router.replace("/");
            }}
            accessibilityRole="button"
            accessibilityLabel={t("common.returnHome")}
            className="mt-md min-h-[44px] items-center justify-center px-lg"
          >
            <Text className="text-base font-semibold text-primary">
              {t("common.returnHome")}
            </Text>
          </Pressable>
        </View>
      </ScreenWrapper>
    </>
  );
}
