/** @jsxImportSource nativewind */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  InteractionManager,
  Platform,
  ScrollView,
  View,
  ActivityIndicator,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Header } from "@/components/layout/Header";
import { FAB } from "@/components/ui/FAB";
import {
  CalendarStrip,
  type CalendarStripHandle,
} from "@/features/habits/components/CalendarStrip";
import { ActiveHabitsList } from "@/features/habits/components/ActiveHabitsList";
import { CompletedHabitsSection } from "@/features/habits/components/CompletedHabitsSection";
import { SectionFlightOverlay } from "@/features/habits/components/SectionFlightOverlay";
import { HabitContextMenu } from "@/features/habits/components/HabitContextMenu";
import { FailureReasonDialog } from "@/features/habits/components/FailureReasonDialog";
import { MainDropdownMenu } from "@/features/habits/components/MainDropdownMenu";
import {
  HomeDataTransferOverlayController,
  type HomeDataTransferOverlayHandle,
} from "@/features/habits/components/HomeDataTransferOverlayController";
import { StatsProgressIcon } from "@/features/habits/components/StatsProgressIcon";
import { createHomeSnapshotController } from "@/features/habits/presentation/home-snapshot";
import {
  SEPARATOR_RENDER_HEIGHT,
  SLOT_HEIGHT,
} from "@/features/habits/animation/constants";
import { MAIN_CALENDAR_FUTURE_DAYS } from "@/features/habits/constants";
import { AboutDialog } from "@/features/settings/components/AboutDialog";
import { useHabitTransfer } from "@/features/habits/hooks/useHabitTransfer";
import { useSectionFlight } from "@/features/habits/animation/useSectionFlight";
import {
  haveSameIdSet,
  isSameOrder,
  mergeReorderedSubsetIntoOrder,
} from "@/features/habits/utils/order";
import {
  getDayListSnapshotForState,
  hasDayListSnapshotForState,
  useHabitStore,
} from "@/stores/habit-store";
import { useUIStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  FocusDeferredScreenPreferencesBoundary,
  useVisualColorScheme,
  useVisualLanguage,
  useVisualTheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { getAccentScheme, lightTheme, darkTheme } from "@/theme/colors";
import { addDays } from "date-fns/addDays";
import { format } from "date-fns/format";
import { parseISO } from "date-fns/parseISO";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DayStatus } from "@/types/habit";
import { type ColorScheme, type ThemeMode } from "@/types/settings";
import { warmupHabitExecutionSound } from "@/utils/sound-effects";
import { getDateFnsLocale } from "@/utils/date";
import {
  getCurrentLocalDateSnapshot,
  useCurrentLocalDate,
} from "@/hooks/useCurrentLocalDate";
import { useNavigationIntentGate } from "@/hooks/useNavigationIntentGate";
import { FocusedRouteModuleWarmup } from "@/components/FocusedRouteModuleWarmup";
import { prewarmDatePickerMonthModels } from "@/features/habit-form/utils/date-picker-month-model";
import { prewarmSceneI18nLanguage } from "@/i18n/scene-instance";
import { prewarmThemeVariables } from "@/theme/provider";
import {
  runAfterUiPaint,
  runWhenUiIsIdle,
  type ScheduledUiTask,
} from "@/utils/ui-scheduling";
const HOME_ROUTE_MODULE_WARMUPS = [
  { route: "/habit/:id", load: () => import("./habit/[id]") },
  { route: "/create", load: () => import("./create") },
  { route: "/settings/_layout", load: () => import("./settings/_layout") },
  { route: "/settings", load: () => import("./settings/index") },
  {
    route: "theme-vars:selected",
    repeatable: true,
    load: async () => prewarmThemeVariables(),
  },
  {
    route: "scene-i18n:selected",
    repeatable: true,
    load: async () =>
      prewarmSceneI18nLanguage(useSettingsStore.getState().language),
  },
  { route: "/statistics", load: () => import("./statistics") },
  {
    route: "date-picker-cache:initial",
    repeatable: true,
    load: async () => {
      prewarmDatePickerMonthModels(
        new Date(),
        useSettingsStore.getState().language,
      );
    },
  },
  { route: "/archive", load: () => import("./archive") },
  { route: "external:sharing", load: () => import("expo-sharing") },
] as const;
const DATE_EPOCH_SNAP_LOCK_SLOW_FRAME_MS = 40;
const LIST_END_SPACER_ROWS = 2;
const LIST_END_SPACER_HEIGHT = SLOT_HEIGHT * LIST_END_SPACER_ROWS;
interface PendingDateRequest {
  id: number;
  toDate: string;
}

function nowMs(): number {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === "function") {
    return perf.now();
  }
  return Date.now();
}


const PRELOAD_DAY_RADIUS = 1;

const CALENDAR_STRIP_ANIMATION_MS = 220;
const CALENDAR_STRIP_MAX_HEIGHT = 96;
const CALENDAR_STRIP_HIDDEN_TRANSLATE_Y = -10;
const TOP_SCROLL_SETTLE_THRESHOLD_PX = 16;
const TOP_SCROLL_SETTLE_DELAY_MS = 30;
const DATE_WINDOW_PREFETCH_DELAY_MS = 1200;
const PERSIST_SELECTED_DATE_DELAY_MS = 220;
const AUDIO_WARMUP_QUIET_DELAY_MS = 2500;
const DAY_COMPLETION_STATUSES = new Set<DayStatus>([
  "done",
  "minimum",
  "maximum",
]);

function computeDayProgress(args: {
  activeCount: number;
  statusByHabitId: Map<number, DayStatus>;
}): number {
  let completedCount = 0;
  let nonSkippedRecordedCount = 0;
  for (const status of args.statusByHabitId.values()) {
    if (status === "skipped") continue;
    nonSkippedRecordedCount += 1;
    if (DAY_COMPLETION_STATUSES.has(status)) {
      completedCount += 1;
    }
  }
  const denominator = args.activeCount + nonSkippedRecordedCount;
  if (denominator <= 0) return 0;
  return completedCount / denominator;
}
interface HabitListScreenContentProps {
  visualTheme: ThemeMode;
  visualColorScheme: ColorScheme;
  habitState: ReturnType<typeof useHabitStore.getState>;
  getDayRecordsWitness: (
    date: string,
  ) => ReturnType<typeof useHabitStore.getState>["dayRecords"] | undefined;
}
interface HabitStoreBinding {
  snapshot: ReturnType<typeof useHabitStore.getState>;
  getDayRecordsWitness: HabitListScreenContentProps["getDayRecordsWitness"];
}
function useLiveHabitStoreSnapshot(
  publishVisibleFacts: boolean,
): HabitStoreBinding {
  const [controller] = useState(() =>
    createHomeSnapshotController(useHabitStore.getState()),
  );
  const getSnapshot = useCallback(
    () => controller.getSnapshot(publishVisibleFacts),
    [controller, publishVisibleFacts],
  );
  const getDayRecordsWitness = useCallback(
    (date: string) => controller.getDayRecordsWitness(date),
    [controller],
  );
  const subscribe = useCallback(
    (notify: () => void) => {
      let disposed = false;
      const publishRelevantSnapshot = () => {
        if (disposed) return;
        if (
          controller.reconcile(useHabitStore.getState(), publishVisibleFacts)
        ) {
          notify();
        }
      };
      const unsubscribeStore = useHabitStore.subscribe(publishRelevantSnapshot);
      // Close the render-to-subscribe race. A covered Home retains the latest
      // facts without rebuilding its invisible native tree; the focus render
      // reads that coherent snapshot before the route can be revealed.
      controller.reconcile(useHabitStore.getState(), publishVisibleFacts);
      return () => {
        disposed = true;
        unsubscribeStore();
      };
    },
    [controller, publishVisibleFacts],
  );
  const snapshot = React.useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  return useMemo(
    () => ({ snapshot, getDayRecordsWitness }),
    [getDayRecordsWitness, snapshot],
  );
}
interface HomeMainMenuHandle {
  open(): void;
}
interface HomeAboutDialogHandle {
  open(): void;
}
interface HomeHabitMenuHandle {
  open(args: { habitId: number; x: number; y: number }): void;
}
interface HomeFailureReasonHandle {
  open(args: {
    habitId: number;
    date: string;
    status: "failure" | "skipped";
  }): void;
}
interface HomeMainMenuControllerProps {
  onExport: () => void;
  onImport: () => void;
  onAbout: () => void;
}
/**
 * The menu owns its visibility so opening or closing it cannot re-render the
 * large, carefully animated habit list underneath. Navigation and the menu
 * close still happen in the same press turn.
 */
const HomeMainMenuController = React.memo(
  React.forwardRef<HomeMainMenuHandle, HomeMainMenuControllerProps>(
    function HomeMainMenuController({ onExport, onImport, onAbout }, ref) {
      const router = useRouter();
      const runNavigationIntent = useNavigationIntentGate();
      const [menu, setMenu] = useState<{
        visible: boolean;
      }>({ visible: false });
      const [androidHostPreloaded, setAndroidHostPreloaded] = useState(false);
      useEffect(() => {
        if (Platform.OS !== "android") return;
        // The lightweight portal host is part of Home readiness, not optional
        // speculative work. An idle callback may legitimately never run before
        // the first menu tap on a busy device, which turns that tap into a cold
        // native mount. Prepare it immediately after the first Home paint.
        const task = runAfterUiPaint(() => setAndroidHostPreloaded(true));
        return () => task.cancel();
      }, []);
      const navigateFromMenu = React.useCallback(
        (target: "/settings" | "/archive") => {
          const result = runNavigationIntent({
            target,
            dispatch: () => {
              router.push(target);
            },
          });
          if (result.status === "blocked") {
          } else if (result.status === "failed") {
            console.error("Failed to open Home menu destination", result.error);
          }
        },
        [router, runNavigationIntent],
      );
      React.useImperativeHandle(
        ref,
        () => ({
          open: () => setMenu({ visible: true }),
        }),
        [],
      );
      return (
        <MainDropdownMenu
          visible={menu.visible}
          preloadOnAndroid={androidHostPreloaded}
          onClose={() => setMenu((current) => ({ ...current, visible: false }))}
          onSettings={() => navigateFromMenu("/settings")}
          onExport={onExport}
          onImport={onImport}
          onAbout={onAbout}
          onArchive={() => navigateFromMenu("/archive")}
        />
      );
    },
  ),
);
/**
 * About-dialog visibility belongs to the portal, not to the animated Home
 * screen. Opening or closing this small dialog must leave both habit lists
 * untouched behind the scrim.
 */
const HomeAboutDialogController = React.memo(
  React.forwardRef<HomeAboutDialogHandle>(
    function HomeAboutDialogController(_props, ref) {
      const [dialog, setDialog] = useState<{
        visible: boolean;
      }>({ visible: false });
      React.useImperativeHandle(
        ref,
        () => ({
          open: () => setDialog({ visible: true }),
        }),
        [],
      );
      return (
        <AboutDialog
          visible={dialog.visible}
          onClose={() => setDialog({ visible: false })}
        />
      );
    },
  ),
);
interface HomeHabitMenuControllerProps {
  onAction: (
    habitId: number,
    status: "minimum" | "maximum" | "failure" | "skipped",
  ) => void;
  onArchive: (habitId: number) => void;
}
/**
 * The per-habit menu owns its target and visibility. A long press therefore
 * mounts only this small overlay instead of rebuilding the animated Home list.
 */
const HomeHabitMenuController = React.memo(
  React.forwardRef<HomeHabitMenuHandle, HomeHabitMenuControllerProps>(
    function HomeHabitMenuController({ onAction, onArchive }, ref) {
      const [menu, setMenu] = useState({
        visible: false,
        habitId: 0,
        x: 0,
        y: 0,
      });
      React.useImperativeHandle(
        ref,
        () => ({
          open: ({ habitId, x, y }) =>
            setMenu({ visible: true, habitId, x, y }),
        }),
        [],
      );
      const close = useCallback(() => {
        setMenu((current) =>
          current.visible ? { ...current, visible: false } : current,
        );
      }, []);
      const runAction = useCallback(
        (status: "minimum" | "maximum" | "failure" | "skipped") => {
          const habitId = menu.habitId;
          close();
          onAction(habitId, status);
        },
        [close, menu.habitId, onAction],
      );
      const runArchive = useCallback(() => {
        const habitId = menu.habitId;
        close();
        onArchive(habitId);
      }, [close, menu.habitId, onArchive]);
      return (
        <HabitContextMenu
          visible={menu.visible}
          onClose={close}
          x={menu.x}
          y={menu.y}
          onMinimum={() => runAction("minimum")}
          onMaximum={() => runAction("maximum")}
          onFailure={() => runAction("failure")}
          onSkip={() => runAction("skipped")}
          onArchive={runArchive}
        />
      );
    },
  ),
);
interface HomeFailureReasonControllerProps {
  currentLocalDate: string;
  canSubmit: (date: string) => boolean;
  onSubmit: (
    habitId: number,
    date: string,
    status: "failure" | "skipped",
    reason: string | null,
  ) => boolean;
}
/**
 * Reason-dialog visibility and target belong to the overlay itself. Opening or
 * closing it must not rebuild the full Home calendar and both animated lists.
 */
const HomeFailureReasonController = React.memo(
  React.forwardRef<HomeFailureReasonHandle, HomeFailureReasonControllerProps>(
    function HomeFailureReasonController({ canSubmit, onSubmit }, ref) {
      const [session, setSession] = useState({
        visible: false,
        habitId: 0,
        date: "",
        status: "failure" as "failure" | "skipped",
        initialReason: "",
      });
      // Date publications refresh this overlay; submission also checks the clock.
      const canSubmitRef = useRef(canSubmit);
      canSubmitRef.current = canSubmit;
      const onSubmitRef = useRef(onSubmit);
      onSubmitRef.current = onSubmit;
      const pendingSubmitRef = useRef<{
        habitId: number;
        date: string;
        status: "failure" | "skipped";
        reason: string | null;
      } | null>(null);
      const flushPendingSubmit = useCallback((restoreOnRefusal = true) => {
        const pending = pendingSubmitRef.current;
        if (!pending) return true;
        pendingSubmitRef.current = null;
        const accepted = canSubmitRef.current(pending.date) && onSubmitRef.current(
          pending.habitId,
          pending.date,
          pending.status,
          pending.reason,
        );
        if (!accepted && restoreOnRefusal) {
          setSession({
            visible: true,
            habitId: pending.habitId,
            date: pending.date,
            status: pending.status,
            initialReason: pending.reason ?? "",
          });
        }
        return accepted;
      }, []);
      React.useImperativeHandle(
        ref,
        () => ({
          open: ({ habitId, date, status }) => {
            // A close -> open reversal intentionally suppresses AppModal's
            // physical onDismiss. Retire an already accepted status command
            // before publishing the next reason-dialog session.
            if (!flushPendingSubmit()) return;
            setSession({ visible: true, habitId, date, status, initialReason: "" });
          },
        }),
        [flushPendingSubmit],
      );
      // A submitted status mutates the large Home tree only after AppModal has
      // actually finished its close. Updating the list during the fade changes
      // the pixels underneath a partially transparent card and creates the
      // one-frame flash during dismissal. Cleanup attempts a still-admissible
      // command without reopening UI after the owner is removed.
      useLayoutEffect(() => () => { flushPendingSubmit(false); }, [flushPendingSubmit]);
      const submit = useCallback(
        (reason: string | null) => {
          if (!session.visible || pendingSubmitRef.current) return false;
          if (!canSubmit(session.date)) {
            setSession((current) => ({ ...current }));
            return false;
          }
          const habitId = session.habitId;
          const status = session.status;
          pendingSubmitRef.current = {
            habitId,
            date: session.date,
            status,
            reason,
          };
          setSession((current) => ({
            ...current,
            visible: false,
          }));
          return true;
        },
        [canSubmit, session.visible, session.date, session.habitId, session.status],
      );
      const cancel = useCallback(() => {
        if (pendingSubmitRef.current) return;
        setSession((current) => ({ ...current, visible: false }));
      }, []);
      return (
        <FailureReasonDialog
          visible={session.visible}
          status={session.status}
          initialReason={session.initialReason}
          onCancel={cancel}
          onSave={(reason) => submit(reason)}
          onDismiss={flushPendingSubmit}
        />
      );
    },
  ),
);
interface HomeFocusCoordinatorProps {
  homeContentReady: boolean;
  resolvedDateForList: string;
  onSelectNotificationDate: (date: string) => void;
  onFocusChange: (focused: boolean) => void;
}
/**
 * Focus changes must not rebuild the large Home tree. React Navigation
 * documents that `useIsFocused` re-renders its owner, so focus-only
 * notification date publication lives in this null-rendering coordinator.
 */
const HomeFocusCoordinator = React.memo(function HomeFocusCoordinator({
  homeContentReady,
  resolvedDateForList,
  onSelectNotificationDate,
  onFocusChange,
}: HomeFocusCoordinatorProps) {
  const isFocused = useIsFocused();
  const notificationRequest = useUIStore(
    (state) => state.notificationPresentationRequest,
  );
  const completeNotificationPresentation = useUIStore(
    (state) => state.completeNotificationPresentation,
  );
  useLayoutEffect(() => {
    onFocusChange(isFocused);
  }, [isFocused, onFocusChange]);
  useLayoutEffect(() => {
    if (!isFocused || !notificationRequest) return;
    onSelectNotificationDate(notificationRequest.date);
  }, [isFocused, notificationRequest, onSelectNotificationDate]);
  useLayoutEffect(() => {
    if (
      isFocused &&
      notificationRequest &&
      homeContentReady &&
      resolvedDateForList === notificationRequest.date
    ) {
      completeNotificationPresentation(notificationRequest.requestId);
    }
  }, [
    completeNotificationPresentation,
    homeContentReady,
    isFocused,
    notificationRequest,
    resolvedDateForList,
  ]);
  return null;
});
const HabitListScreenContent = React.memo(function HabitListScreenContent({
  visualTheme,
  visualColorScheme,
  habitState,
  getDayRecordsWitness,
}: HabitListScreenContentProps) {
  const router = useRouter();
  const runNavigationIntent = useNavigationIntentGate();
  const mainMenuRef = useRef<HomeMainMenuHandle>(null);
  const aboutDialogRef = useRef<HomeAboutDialogHandle>(null);
  const habitMenuRef = useRef<HomeHabitMenuHandle>(null);
  const failureReasonRef = useRef<HomeFailureReasonHandle>(null);
  const dataTransferOverlayRef = useRef<HomeDataTransferOverlayHandle>(null);
  const statisticsCurrentWeekPrewarmRef = useRef<ScheduledUiTask | null>(null);
  const statisticsCurrentWeekPrewarmRevisionRef = useRef(0);
  const homeFocusedRef = useRef(false);
  const audioWarmupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const audioWarmupIdleTaskRef = useRef<ScheduledUiTask | null>(null);
  const scheduleStatisticsCurrentWeekPrewarmRef = useRef<(() => void) | null>(
    null,
  );
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCalendarVisible = useUIStore((s) => s.isCalendarVisible);
  const selectDate = useUIStore((s) => s.selectDate);
  const toggleCalendar = useUIStore((s) => s.toggleCalendar);
  const todayDateStr = useCurrentLocalDate();
  const handleHomeFocusChange = useCallback((focused: boolean) => {
    homeFocusedRef.current = focused;
    if (focused) {
      scheduleStatisticsCurrentWeekPrewarmRef.current?.();
      if (
        audioWarmupTimerRef.current == null &&
        audioWarmupIdleTaskRef.current == null
      ) {
        audioWarmupTimerRef.current = setTimeout(() => {
          audioWarmupTimerRef.current = null;
          if (!homeFocusedRef.current) return;
          audioWarmupIdleTaskRef.current = runWhenUiIsIdle(() => {
            audioWarmupIdleTaskRef.current = null;
            if (homeFocusedRef.current) void warmupHabitExecutionSound();
          });
        }, AUDIO_WARMUP_QUIET_DELAY_MS);
      }
      return;
    }
    // Current-week preparation is optional. It must never keep importing or
    // calculating behind a newly opened route where it can contend with the
    // first correct frame of that screen.
    statisticsCurrentWeekPrewarmRevisionRef.current += 1;
    statisticsCurrentWeekPrewarmRef.current?.cancel();
    statisticsCurrentWeekPrewarmRef.current = null;
    if (audioWarmupTimerRef.current != null) {
      clearTimeout(audioWarmupTimerRef.current);
      audioWarmupTimerRef.current = null;
    }
    audioWarmupIdleTaskRef.current?.cancel();
    audioWarmupIdleTaskRef.current = null;
  }, []);
  const maxSelectableDateStr = useMemo(
    () =>
      format(
        addDays(parseISO(todayDateStr), MAIN_CALENDAR_FUTURE_DAYS),
        "yyyy-MM-dd",
      ),
    [todayDateStr],
  );
  const initialSelectedDate = useRef(
    useUIStore.getState().selectedDate > maxSelectableDateStr
      ? maxSelectableDateStr
      : useUIStore.getState().selectedDate,
  ).current;
  // --- Stores ---
  const {
    habits,
    allDayRecords,
    allDayRecordsLoaded,
    loadHabits,
    loadDayRecords,
    preloadDayRecordsWindow,
    preloadDayListSnapshotsWindow,
    loadAllDayRecords,
    refreshComputedData,
    isLoading: isHabitDataLoading,
    error: habitStoreError,
    errorRevision: habitStoreErrorRevision,
    clearError: clearHabitStoreError,
    currentDayRecordsDate,
    markDay,
    unmarkDay,
    archiveHabit,
    reorderHabits,
  } = habitState;
  const language = useVisualLanguage();
  // --- Theme ---
  const effectiveMode = useVisualEffectiveMode();
  const isDarkTheme =
    visualTheme === "dark" ||
    (visualTheme === "system" && effectiveMode === "dark");
  const separatorColor = isDarkTheme ? darkTheme.divider : lightTheme.divider;
  const screenBg = isDarkTheme ? "#1D1D1D" : "#F2F2F2";
  const surfaceBg = isDarkTheme ? "#2C2C2C" : "#FFFFFF";
  const headerIconColor = isDarkTheme ? darkTheme.icon : lightTheme.icon;
  const statisticsIconColor = isDarkTheme ? darkTheme.icon : "#808080";
  const accent = getAccentScheme(visualColorScheme).base;
  const calendarIconColor = isCalendarVisible ? accent : headerIconColor;
  const calendarStripProgress = useSharedValue(isCalendarVisible ? 1 : 0);

  const calendarStripAnimatedStyle = useAnimatedStyle(() => {
    const progress = calendarStripProgress.value;
    return {
      maxHeight: CALENDAR_STRIP_MAX_HEIGHT * progress,
      opacity: progress,
      transform: [
        { translateY: CALENDAR_STRIP_HIDDEN_TRANSLATE_Y * (1 - progress) },
      ],
    };
  });

  useLayoutEffect(() => {
    calendarStripProgress.value = withTiming(isCalendarVisible ? 1 : 0, {
      duration: CALENDAR_STRIP_ANIMATION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [calendarStripProgress, isCalendarVisible]);
  useEffect(
    () => () => {
      if (audioWarmupTimerRef.current != null) {
        clearTimeout(audioWarmupTimerRef.current);
        audioWarmupTimerRef.current = null;
      }
      audioWarmupIdleTaskRef.current?.cancel();
      audioWarmupIdleTaskRef.current = null;
    },
    [],
  );
  // Expo Router 6 screen prefetch mounts a hidden route. Module-only warmup
  // evaluates code after an idle frame without creating a hidden navigator.
  // Date-window prefetch: selected date + neighbors are warmed as one unit.
  // Records alone are insufficient: the first tap would still synchronously
  // derive and reconcile every row. Build immutable list snapshots only after
  // those records exist and only in a genuine idle slot.
  const dateWindowPrefetchRevisionRef = useRef(0);
  // --- Private date requests and committed presentation ---
  const dateRequestSequenceRef = useRef(0);
  const pendingDateRequestRef = useRef<PendingDateRequest | null>(null);
  const [resolvedDateForList, setResolvedDateForList] =
    useState(initialSelectedDate);
  const [requestedDateForList, setRequestedDateForList] =
    useState(initialSelectedDate);
  const [isDateEpochSnapLock, setIsDateEpochSnapLock] = useState(false);
  // One visible date owns the header, calendar and both list sections. A cold
  // target stays private in `requestedDateForList` until its data is ready, so
  // React can only render a complete old day or a complete new day.
  const interactiveDateForLists = resolvedDateForList;
  const selectedDate = requestedDateForList;
  const selectedDateCachedRecords = getDayRecordsWitness(selectedDate);
  const interactiveDateCachedRecords = getDayRecordsWitness(
    interactiveDateForLists,
  );

  const dateWindowPrefetchTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const dateWindowPrefetchTaskRef = useRef<ScheduledUiTask | null>(null);
  const persistSelectedDateTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const persistSelectedDateTaskRef = useRef<ReturnType<
    typeof InteractionManager.runAfterInteractions
  > | null>(null);

  const dateEpochStartedAtRef = useRef<number | null>(null);

  const dateEpochSnapRaf1Ref = useRef<number | null>(null);
  const dateEpochSnapRaf2Ref = useRef<number | null>(null);
  const activeCountRef = useRef(0);
  const completedCountRef = useRef(0);

  const resolvedDateForListRef = useRef(initialSelectedDate);
  const currentDayRecordsDateRef = useRef(currentDayRecordsDate);

  const lastSettledDateRef = useRef<string | null>(null);
  const transferBusyRef = useRef(false);
  const calendarStripRef = useRef<CalendarStripHandle>(null);
  const deferredDateSwitchRef = useRef<{
    date: string;
  } | null>(null);

  const clearDateWindowPrefetchTimer = useCallback(() => {
    dateWindowPrefetchRevisionRef.current += 1;
    if (dateWindowPrefetchTaskRef.current != null) {
      dateWindowPrefetchTaskRef.current.cancel();
      dateWindowPrefetchTaskRef.current = null;
    }
    if (dateWindowPrefetchTimerRef.current != null) {
      clearTimeout(dateWindowPrefetchTimerRef.current);
      dateWindowPrefetchTimerRef.current = null;
    }
  }, []);
  const persistSelectedDate = useCallback(
    (date: string) => {
      if (persistSelectedDateTimerRef.current != null) {
        clearTimeout(persistSelectedDateTimerRef.current);
        persistSelectedDateTimerRef.current = null;
      }
      if (persistSelectedDateTaskRef.current != null) {
        persistSelectedDateTaskRef.current.cancel();
        persistSelectedDateTaskRef.current = null;
      }
      persistSelectedDateTimerRef.current = setTimeout(() => {
        persistSelectedDateTimerRef.current = null;
        persistSelectedDateTaskRef.current =
          InteractionManager.runAfterInteractions(() => {
            persistSelectedDateTaskRef.current = null;
            selectDate(date);
          });
      }, PERSIST_SELECTED_DATE_DELAY_MS);
    },
    [selectDate],
  );
  const scheduleDateWindowPrefetch = useCallback(
    (centerDate: string, delayMs = DATE_WINDOW_PREFETCH_DELAY_MS) => {
      clearDateWindowPrefetchTimer();
      const revision = dateWindowPrefetchRevisionRef.current;
      dateWindowPrefetchTimerRef.current = setTimeout(
        () => {
          dateWindowPrefetchTimerRef.current = null;
          dateWindowPrefetchTaskRef.current = runWhenUiIsIdle(() => {
            dateWindowPrefetchTaskRef.current = null;
            void preloadDayRecordsWindow(centerDate, PRELOAD_DAY_RADIUS).then(
              (loaded) => {
                if (
                  !loaded ||
                  revision !== dateWindowPrefetchRevisionRef.current
                ) {
                  return;
                }
                dateWindowPrefetchTaskRef.current = runWhenUiIsIdle(() => {
                  dateWindowPrefetchTaskRef.current = null;
                  if (revision !== dateWindowPrefetchRevisionRef.current)
                    return;
                  preloadDayListSnapshotsWindow(centerDate, PRELOAD_DAY_RADIUS);
                });
              },
            );
          });
        },
        Math.max(0, delayMs),
      );
    },
    [
      clearDateWindowPrefetchTimer,
      preloadDayListSnapshotsWindow,
      preloadDayRecordsWindow,
    ],
  );
  useEffect(() => {
    if (lastSettledDateRef.current === resolvedDateForList) return;
    lastSettledDateRef.current = resolvedDateForList;
    persistSelectedDate(resolvedDateForList);
    scheduleDateWindowPrefetch(resolvedDateForList);
  }, [persistSelectedDate, resolvedDateForList, scheduleDateWindowPrefetch]);

  const clearDateEpochSnapRafs = useCallback(() => {
    if (dateEpochSnapRaf1Ref.current != null) {
      cancelAnimationFrame(dateEpochSnapRaf1Ref.current);
      dateEpochSnapRaf1Ref.current = null;
    }
    if (dateEpochSnapRaf2Ref.current != null) {
      cancelAnimationFrame(dateEpochSnapRaf2Ref.current);
      dateEpochSnapRaf2Ref.current = null;
    }
  }, []);

  const cancelPrivateDateRequest = useCallback(() => {
    clearDateEpochSnapRafs();
    setRequestedDateForList(resolvedDateForList);
    setResolvedDateForList(resolvedDateForList);
    setIsDateEpochSnapLock(false);
    pendingDateRequestRef.current = null;
    dateEpochStartedAtRef.current = null;
  }, [clearDateEpochSnapRafs, resolvedDateForList]);
  const handleSelectDate = useCallback(
    (date: string) => {
      if (date > maxSelectableDateStr) return;
      const hasPrivateDateRequest =
        selectedDate !== resolvedDateForList ||
        (pendingDateRequestRef.current != null &&
          pendingDateRequestRef.current.toDate !== resolvedDateForList);
      if (transferBusyRef.current) {
        if (date === resolvedDateForList) {
          deferredDateSwitchRef.current = null;
          if (hasPrivateDateRequest) cancelPrivateDateRequest();
          return;
        }
        deferredDateSwitchRef.current = { date };
        return;
      }
      if (date === resolvedDateForList) {
        if (hasPrivateDateRequest) cancelPrivateDateRequest();
        return;
      }
      if (date === selectedDate) return;
      clearDateEpochSnapRafs();
      dateEpochStartedAtRef.current = null;
      const nextId = dateRequestSequenceRef.current + 1;
      dateRequestSequenceRef.current = nextId;
      const habitState = useHabitStore.getState();
      const isWarmCached =
        habitState.dayRecordsByDate[date] !== undefined ||
        habitState.allDayRecordsLoaded;
      const listSnapshotCacheHit = hasDayListSnapshotForState(
        habitState,
        date,
        date < todayDateStr,
      );
      if (
        isWarmCached &&
        !listSnapshotCacheHit &&
        habitState.allDayRecordsLoaded
      ) {
        getDayListSnapshotForState(habitState, date, date < todayDateStr);
      }
      const listSnapshotReady = hasDayListSnapshotForState(
        habitState,
        date,
        date < todayDateStr,
      );
      pendingDateRequestRef.current = { id: nextId, toDate: date };
      setRequestedDateForList((current) => (current === date ? current : date));
      if (listSnapshotReady) {
        setIsDateEpochSnapLock(true);
        setResolvedDateForList((current) =>
          current === date ? current : date,
        );
      }
    },
    [
      clearDateEpochSnapRafs,
      cancelPrivateDateRequest,
      resolvedDateForList,
      selectedDate,
      maxSelectableDateStr,
      todayDateStr,
    ],
  );
  const handleSelectDateRef = useRef(handleSelectDate);
  useEffect(() => {
    handleSelectDateRef.current = handleSelectDate;
  }, [handleSelectDate]);
  const selectNotificationDate = useCallback((date: string) => {
    calendarStripRef.current?.cancelPendingTodayReveal();
    handleSelectDateRef.current(date);
  }, []);
  const handleCalendarSelectDate = useCallback(
    (date: string) => {
      calendarStripRef.current?.cancelPendingTodayReveal();
      handleSelectDate(date);
    },
    [handleSelectDate],
  );
  const previousTodayRef = useRef(todayDateStr);
  useEffect(() => {
    const previousToday = previousTodayRef.current;
    previousTodayRef.current = todayDateStr;
    refreshComputedData();
    const currentSelectedDate = resolvedDateForListRef.current;
    if (
      currentSelectedDate > maxSelectableDateStr ||
      currentSelectedDate === previousToday
    ) {
      calendarStripRef.current?.cancelPendingTodayReveal();
      handleSelectDateRef.current(todayDateStr);
    }
  }, [maxSelectableDateStr, refreshComputedData, todayDateStr]);
  const hasSelectedDateCached = selectedDateCachedRecords !== undefined;
  const isSelectedDayLoaded =
    currentDayRecordsDate === selectedDate ||
    hasSelectedDateCached ||
    allDayRecordsLoaded;
  const isInteractiveDayLoaded =
    currentDayRecordsDate === interactiveDateForLists ||
    interactiveDateCachedRecords !== undefined ||
    allDayRecordsLoaded;
  const isDateSwitchPending = selectedDate !== resolvedDateForList;
  const headerSelectedDay = useMemo(
    () => parseISO(resolvedDateForList),
    [resolvedDateForList],
  );
  const headerTitle = useMemo(() => {
    if (Number.isNaN(headerSelectedDay.getTime())) return t("habits.title");
    if (resolvedDateForList === todayDateStr) return t("habits.titleToday");
    const today = parseISO(todayDateStr);
    if (resolvedDateForList === format(addDays(today, -1), "yyyy-MM-dd")) {
      return t("habits.titleYesterday");
    }
    if (resolvedDateForList === format(addDays(today, 1), "yyyy-MM-dd")) {
      return t("habits.titleTomorrow");
    }
    const locale = getDateFnsLocale(language);
    if (language === "en") {
      return format(headerSelectedDay, "MMM d, yyyy", { locale });
    }
    return format(headerSelectedDay, "d MMM yyyy", { locale });
  }, [headerSelectedDay, language, resolvedDateForList, t, todayDateStr]);

  const handleHeaderTitlePress = useCallback(() => {
    handleSelectDate(todayDateStr);
    calendarStripRef.current?.revealToday();
  }, [todayDateStr, handleSelectDate]);
  // --- Load data ---
  useEffect(() => {
    loadHabits();
  }, [loadHabits]);
  useEffect(() => {
    if (allDayRecordsLoaded) return;
    // The visible list needs full history, so enqueue it before any day slice.
    void loadAllDayRecords();
  }, [allDayRecordsLoaded, loadAllDayRecords]);
  useEffect(() => {
    if (!allDayRecordsLoaded) return;
    if (currentDayRecordsDate === selectedDate) return;
    if (hasSelectedDateCached) return;

    void loadDayRecords(selectedDate);
  }, [
    allDayRecordsLoaded,
    currentDayRecordsDate,
    hasSelectedDateCached,
    loadDayRecords,
    selectedDate,
  ]);

  // A cold requested date is private until it is ready. Its loading state must
  // not switch the still-visible day between positioned and flow layout.
  const suppressInitialLayoutAnimations = !isInteractiveDayLoaded;
  const layoutEpoch = interactiveDateForLists;
  const committedLayoutEpochRef = useRef(layoutEpoch);
  const isLayoutEpochSwitchFrame =
    committedLayoutEpochRef.current !== layoutEpoch;
  useLayoutEffect(() => {
    committedLayoutEpochRef.current = layoutEpoch;
  }, [layoutEpoch]);
  useEffect(() => {
    if (!isLayoutEpochSwitchFrame) return;
    clearDateEpochSnapRafs();
    dateEpochStartedAtRef.current = nowMs();
    dateEpochSnapRaf1Ref.current = requestAnimationFrame(() => {
      dateEpochSnapRaf1Ref.current = null;
      const layoutEpochAtMs = dateEpochStartedAtRef.current;
      const elapsedMs = layoutEpochAtMs == null ? 0 : nowMs() - layoutEpochAtMs;
      if (elapsedMs >= DATE_EPOCH_SNAP_LOCK_SLOW_FRAME_MS) {
        setIsDateEpochSnapLock(false);
        return;
      }
      dateEpochSnapRaf2Ref.current = requestAnimationFrame(() => {
        dateEpochSnapRaf2Ref.current = null;
        setIsDateEpochSnapLock(false);
      });
    });
  }, [clearDateEpochSnapRafs, isLayoutEpochSwitchFrame, layoutEpoch]);

  // --- Data model ---
  const listIsPast = interactiveDateForLists < todayDateStr;
  const listIsFuture = interactiveDateForLists > todayDateStr;
  const dayListSnapshot = getDayListSnapshotForState(
    habitState,
    interactiveDateForLists,
    listIsPast,
  );
  const activeItems = dayListSnapshot.activeItems;
  const completedItems = dayListSnapshot.completedItems;
  const statusByHabitId = dayListSnapshot.statusByHabitId;
  const homeContentReady =
    habitStoreError != null ||
    (!isHabitDataLoading && isInteractiveDayLoaded && allDayRecordsLoaded);

  useEffect(() => {
    if (!habitState.allHabitsLoaded || !allDayRecordsLoaded) return;
    const scheduleCurrentWeek = () => {
      statisticsCurrentWeekPrewarmRevisionRef.current += 1;
      const revision = statisticsCurrentWeekPrewarmRevisionRef.current;
      statisticsCurrentWeekPrewarmRef.current?.cancel();
      if (!homeFocusedRef.current) {
        statisticsCurrentWeekPrewarmRef.current = null;
        return;
      }
      const latestHabitState = useHabitStore.getState();
      if (
        !latestHabitState.allHabitsLoaded ||
        !latestHabitState.allDayRecordsLoaded
      ) {
        statisticsCurrentWeekPrewarmRef.current = null;
        return;
      }
      const source = {
        allHabits: latestHabitState.allHabits,
        allRecords: latestHabitState.allDayRecords,
        showArchivedHabitsInStatistics:
          useSettingsStore.getState().showArchivedHabitsInStatistics,
        todayStr: getCurrentLocalDateSnapshot(),
      };
      // This is optional work: it starts only in a genuine idle slot, has no
      // timeout that can force it into an interaction, and is cancelled when
      // its source revision changes. Keeping the import dynamic preserves the
      // initial Home dependency graph while making the normal Statistics tap
      // an O(1) cache hit.
      statisticsCurrentWeekPrewarmRef.current = runWhenUiIsIdle(() => {
        void import("@/features/statistics/utils/statistics-prewarm")
          .then(({ scheduleStatisticsPeriodsPrewarm }) => {
            if (revision !== statisticsCurrentWeekPrewarmRevisionRef.current) {
              return;
            }
            statisticsCurrentWeekPrewarmRef.current =
              scheduleStatisticsPeriodsPrewarm(source, [
                { period: "week", periodOffset: 0 },
              ]);
          })
          .catch(() => {
            if (revision === statisticsCurrentWeekPrewarmRevisionRef.current) {
              statisticsCurrentWeekPrewarmRef.current = null;
            }
          });
      });
    };
    scheduleStatisticsCurrentWeekPrewarmRef.current = scheduleCurrentWeek;
    scheduleCurrentWeek();
    const unsubscribeSettings = useSettingsStore.subscribe((next, previous) => {
      if (
        next.showArchivedHabitsInStatistics !==
        previous.showArchivedHabitsInStatistics
      ) {
        scheduleCurrentWeek();
      }
    });
    return () => {
      unsubscribeSettings();
      if (
        scheduleStatisticsCurrentWeekPrewarmRef.current === scheduleCurrentWeek
      ) {
        scheduleStatisticsCurrentWeekPrewarmRef.current = null;
      }
      statisticsCurrentWeekPrewarmRevisionRef.current += 1;
      statisticsCurrentWeekPrewarmRef.current?.cancel();
      statisticsCurrentWeekPrewarmRef.current = null;
    };
  }, [
    allDayRecords,
    allDayRecordsLoaded,
    habitState.allHabitsLoaded,
    habits,
    todayDateStr,
  ]);
  const headerDayProgress = useMemo(
    () =>
      computeDayProgress({
        activeCount: dayListSnapshot.activeItems.length,
        statusByHabitId: dayListSnapshot.statusByHabitId,
      }),
    [dayListSnapshot],
  );
  const habitOrderIds = useMemo(() => habits.map((h) => h.id), [habits]);
  const activeHabitIds = useMemo(
    () => activeItems.map((i) => i.habit.id),
    [activeItems],
  );

  activeCountRef.current = activeItems.length;
  completedCountRef.current = completedItems.length;
  resolvedDateForListRef.current = resolvedDateForList;
  currentDayRecordsDateRef.current = currentDayRecordsDate;

  useLayoutEffect(() => {
    const pending = pendingDateRequestRef.current;
    if (pending && pending.toDate === resolvedDateForList)
      pendingDateRequestRef.current = null;
  }, [resolvedDateForList]);

  useEffect(
    () => () => {
      clearDateWindowPrefetchTimer();
      clearDateEpochSnapRafs();
      if (persistSelectedDateTaskRef.current != null) {
        persistSelectedDateTaskRef.current.cancel();
        persistSelectedDateTaskRef.current = null;
      }
      if (persistSelectedDateTimerRef.current != null) {
        clearTimeout(persistSelectedDateTimerRef.current);
        persistSelectedDateTimerRef.current = null;
      }
      pendingDateRequestRef.current = null;
      dateEpochStartedAtRef.current = null;
    },
    [clearDateEpochSnapRafs, clearDateWindowPrefetchTimer],
  );
  // --- UI state ---

  const [completedExpanded, setCompletedExpanded] = useState(false);

  useEffect(() => {
    if (!habitStoreError) return;
    console.error("Habit data operation failed", habitStoreError);
    dataTransferOverlayRef.current?.showStatus({
      title: t("common.dataErrorTitle"),
      message: t("common.dataErrorMessage"),
      onRetry: async () => {
        const [habitsLoaded, selectedDayLoaded, allDayRecordsLoaded] =
          await Promise.all([
            loadHabits({ publishError: false }),
            loadDayRecords(selectedDate, { publishError: false }),
            loadAllDayRecords({ publishError: false }),
          ]);
        return habitsLoaded && selectedDayLoaded && allDayRecordsLoaded;
      },
    });
    clearHabitStoreError(habitStoreErrorRevision);
  }, [
    clearHabitStoreError,
    habitStoreError,
    habitStoreErrorRevision,
    loadAllDayRecords,
    loadDayRecords,
    loadHabits,
    selectedDate,
    t,
  ]);
  // --- Layout refs ---
  const mainScrollRef = useRef<ScrollView>(null);
  const headerAreaHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);
  const completedToggleHeightRef = useRef(56);
  const topOverscrollSnapTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const isScrollDragActiveRef = useRef(false);
  const isMomentumScrollActiveRef = useRef(false);
  // --- Flight animation ---
  const flightCompleteRef = useRef<(habitId: number) => void>(() => {});
  const flight = useSectionFlight((habitId) =>
    flightCompleteRef.current(habitId),
  );
  const pendingStatusReasonRef = useRef<{
    habitId: number;
    date: string;
    status: "failure" | "skipped";
    reason: string;
  } | null>(null);
  const markDayForTransfer = useCallback(
    async (habitId: number, date: string, status: DayStatus) => {
      const pending = pendingStatusReasonRef.current;
      if (
        pending &&
        pending.habitId === habitId &&
        pending.date === date &&
        pending.status === status
      ) {
        pendingStatusReasonRef.current = null;
        await markDay(habitId, date, status, pending.reason);
        return;
      }
      await markDay(habitId, date, status);
    },
    [markDay],
  );
  const unmarkDayForTransfer = useCallback(
    async (habitId: number, date: string) => {
      await unmarkDay(habitId, date);
    },
    [unmarkDay],
  );
  // --- Transfer logic ---
  const transfer = useHabitTransfer({
    activeItems,
    completedItems,
    selectedDate: interactiveDateForLists,
    isPast: listIsPast,
    isFuture: listIsFuture,
    flight,
    markDay: markDayForTransfer,
    unmarkDay: unmarkDayForTransfer,
    allDayRecords,
    habitOrderIds,
    statusByHabitId,
    completedExpanded,
    completedToggleHeightRef,
    headerAreaHeightRef,
    scrollOffsetRef,
  });
  const { getIsTransferBusy } = transfer;
  useLayoutEffect(() => {
    transferBusyRef.current = transfer.isBusy;
  }, [transfer.isBusy]);
  // Latest intent wins when a date tap was deferred by a checkbox flight.
  // Release it before the cold-date commit effect below can publish an older
  // request that happened to finish loading during the flight.
  useEffect(() => {
    if (transfer.isBusy) return;
    const deferred = deferredDateSwitchRef.current;
    if (!deferred) return;
    deferredDateSwitchRef.current = null;
    handleSelectDateRef.current(deferred.date);
  }, [transfer.isBusy]);
  useLayoutEffect(() => {
    const pending = pendingDateRequestRef.current;
    if (
      !pending ||
      pending.toDate !== selectedDate ||
      !isSelectedDayLoaded ||
      !allDayRecordsLoaded ||
      resolvedDateForList === selectedDate ||
      !isDateSwitchPending
    )
      return;
    // An accepted checkbox transfer retains the visible presentation until it settles.
    if (transfer.isBusy) return;
    const currentPending = pendingDateRequestRef.current;
    if (
      currentPending?.id !== pending.id ||
      currentPending.toDate !== selectedDate
    )
      return;
    const latestHabitState = useHabitStore.getState();
    getDayListSnapshotForState(
      latestHabitState,
      selectedDate,
      selectedDate < todayDateStr,
    );
    clearDateEpochSnapRafs();
    setIsDateEpochSnapLock(true);
    setResolvedDateForList((current) =>
      current === selectedDate ? current : selectedDate,
    );
  }, [
    clearDateEpochSnapRafs,
    currentDayRecordsDate,
    hasSelectedDateCached,
    isDateSwitchPending,
    isSelectedDayLoaded,
    resolvedDateForList,
    selectedDate,
    transfer.isBusy,
    allDayRecordsLoaded,
    todayDateStr,
  ]);
  const suppressLayoutAnimations =
    suppressInitialLayoutAnimations ||
    isLayoutEpochSwitchFrame ||
    isDateEpochSnapLock;
  // A date change gives each checkbox a fresh visual epoch, so its animated
  // instance already starts at the exact target tone. Keep that instance
  // stable instead of swapping Static -> Animated over the next two frames.
  // Transfer animations retain their existing suppression contract.
  const animateCheckboxTransitions =
    isLayoutEpochSwitchFrame ||
    isDateEpochSnapLock ||
    !suppressLayoutAnimations;
  // Keep transfer callbacks referentially stable for list props.
  // Date switch should not re-render large lists just because hook callback identities changed.
  const transferHandleCheckboxPressRef = useRef(transfer.handleCheckboxPress);
  const transferHandleOverlayBindRef = useRef(transfer.handleOverlayBind);
  const transferHandleOverlayVisualReadyRef = useRef(
    transfer.handleOverlayVisualReady,
  );
  const transferHandleOverlayUnbindRef = useRef(transfer.handleOverlayUnbind);
  useLayoutEffect(() => {
    transferHandleCheckboxPressRef.current = transfer.handleCheckboxPress;
  }, [transfer.handleCheckboxPress]);
  useEffect(() => {
    transferHandleOverlayBindRef.current = transfer.handleOverlayBind;
  }, [transfer.handleOverlayBind]);
  useEffect(() => {
    transferHandleOverlayVisualReadyRef.current =
      transfer.handleOverlayVisualReady;
  }, [transfer.handleOverlayVisualReady]);
  useEffect(() => {
    transferHandleOverlayUnbindRef.current = transfer.handleOverlayUnbind;
  }, [transfer.handleOverlayUnbind]);
  const handleTransferCheckboxPress = useCallback((habitId: number) => {
    return transferHandleCheckboxPressRef.current(habitId);
  }, []);
  const handleTransferOverlayBind = useCallback(
    (habitId: number, layer: "under" | "over") => {
      transferHandleOverlayBindRef.current(habitId, layer);
    },
    [],
  );
  const handleTransferOverlayVisualReady = useCallback(
    (habitId: number, layer: "under" | "over") => {
      transferHandleOverlayVisualReadyRef.current(habitId, layer);
    },
    [],
  );
  const handleTransferOverlayUnbind = useCallback(
    (habitId: number, layer: "under" | "over") => {
      transferHandleOverlayUnbindRef.current(habitId, layer);
    },
    [],
  );
  flightCompleteRef.current = transfer.handleFlightComplete;
  // Keep total visible slots stable during section transfer:
  // - completed -> active: preserve source gap only before visual overlay is ready,
  //   then release it so completed shrink can track active grow without late toggle snap.
  // - active -> completed: reserve target slot in completed.
  const flyingState = transfer.flyingState;
  const hasVisualFlightOverlay = transfer.hasVisualFlightOverlay;
  const isCompletedToActiveFlight =
    flyingState?.from === "completed" && flyingState?.to === "active";
  const activeIncomingPlaceholderIndex =
    hasVisualFlightOverlay && flyingState?.to === "active"
      ? flyingState.targetIndex
      : null;
  const completedIncomingPlaceholderIndex =
    hasVisualFlightOverlay &&
    flyingState?.to === "completed" &&
    completedExpanded
      ? flyingState.targetIndex
      : null;
  const activeOutgoingSourceIndex = null;
  const completedPreserveGapSourceIndex =
    isCompletedToActiveFlight && completedExpanded && !hasVisualFlightOverlay
      ? (flyingState?.sourceIndex ?? null)
      : null;
  const completedPreserveHiddenSlot = completedPreserveGapSourceIndex != null;
  // --- Reorder ---
  const handleReorderActiveIds = useCallback(
    (reorderedIds: number[]) => {
      if (
        activeHabitIds.some((habitId) => habitId <= 0) ||
        reorderedIds.some((habitId) => habitId <= 0)
      ) {
        return;
      }
      if (!haveSameIdSet(activeHabitIds, reorderedIds)) return;
      const currentOrderIds = useHabitStore.getState().habits.map((habit) => habit.id);
      const fullOrder = mergeReorderedSubsetIntoOrder(
        currentOrderIds,
        reorderedIds,
      );
      if (!fullOrder || isSameOrder(fullOrder, currentOrderIds)) return;
      void (() => reorderHabits(fullOrder))();
    },
    [activeHabitIds, reorderHabits],
  );
  // --- Context menu ---
  const openContextMenu = useCallback(
    (habitId: number, pageX: number, pageY: number) => {
      if (habitId <= 0 || listIsFuture || transferBusyRef.current || getIsTransferBusy()) {
        return;
      }
      habitMenuRef.current?.open({
        habitId,
        x: pageX,
        y: pageY,
      });
    },
    [getIsTransferBusy, listIsFuture],
  );
  const openHabitDetail = useCallback(
    (habitId: number) => {
      if (habitId <= 0) return;
      const target = `/habit/${habitId}`;
      const result = runNavigationIntent({
        target,
        dispatch: () => {
          router.push(target);
        },
      });
      if (result.status === "blocked") {
      } else if (result.status === "failed") {
        console.error("Failed to open habit", result.error);
      }
    },
    [router, runNavigationIntent],
  );
  const handleContextAction = useCallback(
    (habitId: number, status: DayStatus) => {
      if (listIsFuture || transferBusyRef.current || getIsTransferBusy()) {
        return;
      }
      const { askFailureReason, askSkipReason } = useSettingsStore.getState();
      const shouldAskReason =
        (status === "failure" && askFailureReason) ||
        (status === "skipped" && askSkipReason);
      if (shouldAskReason) {
        failureReasonRef.current?.open({
          habitId,
          date: interactiveDateForLists,
          status,
        });
      } else {
        transfer.handleContextAction(habitId, status);
      }
    },
    [getIsTransferBusy, interactiveDateForLists, listIsFuture, transfer],
  );
  const handleContextArchive = useCallback(
    (habitId: number) => {
      void archiveHabit(habitId).catch((archiveError) => {
        console.error("Failed to archive habit", archiveError);
        dataTransferOverlayRef.current?.showStatus({
          title: t("common.dataErrorTitle"),
          message: t("common.dataErrorMessage"),
        });
      });
    },
    [archiveHabit, t],
  );
  const handleFailureSubmit = useCallback(
    (
      habitId: number,
      date: string,
      status: "failure" | "skipped",
      reason: string | null,
    ) => {
      if (date !== resolvedDateForListRef.current) {
        void markDay(habitId, date, status, reason ?? undefined);
        return true;
      }
      if (transferBusyRef.current || getIsTransferBusy()) return false;
      const pendingReason = reason != null ? {
          habitId,
          date,
          status,
          reason,
        } : null;
      if (pendingReason) {
        pendingStatusReasonRef.current = pendingReason;
      }
      const accepted = transfer.handleContextAction(habitId, status);
      if (!accepted && pendingStatusReasonRef.current === pendingReason) {
        pendingStatusReasonRef.current = null;
      }
      return accepted;
    },
    [getIsTransferBusy, markDay, transfer],
  );
  const canSubmitFailureReason = useCallback(
    (date: string) => date <= format(new Date(), "yyyy-MM-dd") &&
      !transferBusyRef.current && !getIsTransferBusy(),
    [getIsTransferBusy],
  );
  const handleMainExport = useCallback(() => {
    dataTransferOverlayRef.current?.openExport();
  }, []);
  const handleMainImport = useCallback(() => {
    dataTransferOverlayRef.current?.openImport();
  }, []);
  const handleMainAbout = useCallback(() => {
    aboutDialogRef.current?.open();
  }, []);
  // --- Layout callbacks ---
  const handleHeaderAreaLayout = useCallback(
    (event: {
      nativeEvent: {
        layout: {
          height: number;
        };
      };
    }) => {
      const h = event.nativeEvent.layout.height;
      if (headerAreaHeightRef.current !== h) {
        headerAreaHeightRef.current = h;
      }
    },
    [],
  );
  const handleScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: {
          y: number;
        };
      };
    }) => {
      const y = event.nativeEvent.contentOffset.y;
      scrollOffsetRef.current = y;
      if (
        isMomentumScrollActiveRef.current &&
        !isScrollDragActiveRef.current &&
        y <= TOP_SCROLL_SETTLE_THRESHOLD_PX
      ) {
        isMomentumScrollActiveRef.current = false;
        if (topOverscrollSnapTimerRef.current != null) {
          clearTimeout(topOverscrollSnapTimerRef.current);
          topOverscrollSnapTimerRef.current = null;
        }
        mainScrollRef.current?.scrollTo({ y: 0, animated: false });
      }
    },
    [],
  );
  const clearTopOverscrollSnapTimer = useCallback(() => {
    if (topOverscrollSnapTimerRef.current != null) {
      clearTimeout(topOverscrollSnapTimerRef.current);
      topOverscrollSnapTimerRef.current = null;
    }
  }, []);
  const scheduleTopOverscrollSnap = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: {
          y: number;
        };
      };
    }) => {
      const y = event.nativeEvent.contentOffset.y;
      if (y > TOP_SCROLL_SETTLE_THRESHOLD_PX) return;
      clearTopOverscrollSnapTimer();
      // Keep natural elastic pull, but if the list remains near top after release
      // (including slight stuck overscroll), settle to exact y=0 to avoid header gap.
      topOverscrollSnapTimerRef.current = setTimeout(() => {
        if (scrollOffsetRef.current <= TOP_SCROLL_SETTLE_THRESHOLD_PX) {
          mainScrollRef.current?.scrollTo({ y: 0, animated: false });
        }
      }, TOP_SCROLL_SETTLE_DELAY_MS);
    },
    [clearTopOverscrollSnapTimer],
  );
  useEffect(
    () => () => {
      clearTopOverscrollSnapTimer();
    },
    [clearTopOverscrollSnapTimer],
  );
  const handleScrollBeginDrag = useCallback(() => {
    isScrollDragActiveRef.current = true;
    isMomentumScrollActiveRef.current = false;
    clearTopOverscrollSnapTimer();
  }, [clearTopOverscrollSnapTimer]);
  const handleScrollEndDrag = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: {
          y: number;
        };
      };
    }) => {
      isScrollDragActiveRef.current = false;
      scheduleTopOverscrollSnap(event);
    },
    [scheduleTopOverscrollSnap],
  );
  const handleMomentumScrollBegin = useCallback(() => {
    isMomentumScrollActiveRef.current = true;
    clearTopOverscrollSnapTimer();
  }, [clearTopOverscrollSnapTimer]);
  const handleMomentumScrollEnd = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: {
          y: number;
        };
      };
    }) => {
      isMomentumScrollActiveRef.current = false;
      scheduleTopOverscrollSnap(event);
    },
    [scheduleTopOverscrollSnap],
  );
  const handleCompletedToggleLayout = useCallback(
    (layout: { height: number; y: number }) => {
      if (layout.height > 0) {
        completedToggleHeightRef.current = layout.height;
      }
    },
    [],
  );
  const isDownwardFlight =
    transfer.flyingState?.from === "active" &&
    transfer.flyingState?.to === "completed";
  // Downward flights must stay under list rows and completed toggle block.
  const routeDownwardUnderLayer = isDownwardFlight;
  const underContentFlightState = routeDownwardUnderLayer
    ? transfer.flyingState
    : null;
  const overContentFlightState = routeDownwardUnderLayer
    ? null
    : transfer.flyingState;
  const underOverlayYOffset =
    -headerAreaHeightRef.current + scrollOffsetRef.current;
  const overOverlayClipTopY = Math.max(insets.top, headerAreaHeightRef.current);

  const handleOpenStatistics = useCallback(() => {
    const result = runNavigationIntent({
      target: "/statistics",
      dispatch: () => {
        statisticsCurrentWeekPrewarmRevisionRef.current += 1;
        statisticsCurrentWeekPrewarmRef.current?.cancel();
        statisticsCurrentWeekPrewarmRef.current = null;
        router.push("/statistics");
      },
    });
    if (result.status === "blocked") {
      return;
    }
    if (result.status === "failed") {
      console.error("Failed to open statistics", result.error);
    }
  }, [router, runNavigationIntent]);
  const handleOpenMainMenu = useCallback(() => {
    mainMenuRef.current?.open();
  }, []);
  const homeHeaderActions = useMemo<
    NonNullable<React.ComponentProps<typeof Header>["rightActions"]>
  >(
    () => [
      {
        customIcon: (
          <StatsProgressIcon
            progress={headerDayProgress}
            size={22}
            color={statisticsIconColor}
            fillColor={accent}
          />
        ),
        accessibilityLabel: t("accessibility.openStatistics"),
        onPress: handleOpenStatistics,
      },
      {
        customIcon: (
          <MaterialIcons
            name="calendar-month"
            size={24}
            color={calendarIconColor}
          />
        ),
        accessibilityLabel: isCalendarVisible
          ? t("accessibility.hideCalendar")
          : t("accessibility.showCalendar"),
        onPress: () => {
          toggleCalendar();
        },
      },
      {
        icon: "more-vert",
        accessibilityLabel: t("accessibility.moreOptions"),
        onPress: handleOpenMainMenu,
      },
    ],
    [
      accent,
      calendarIconColor,
      handleOpenMainMenu,
      handleOpenStatistics,
      headerDayProgress,
      isCalendarVisible,
      statisticsIconColor,
      t,
      toggleCalendar,
    ],
  );
  return (
    <View style={{ flex: 1, backgroundColor: screenBg }}>
      <HomeFocusCoordinator
        homeContentReady={homeContentReady}
        resolvedDateForList={resolvedDateForList}
        onSelectNotificationDate={selectNotificationDate}
        onFocusChange={handleHomeFocusChange}
      />
      {/* Header (fixed, above scroll) */}
      <View
        style={{ backgroundColor: surfaceBg }}
        onLayout={handleHeaderAreaLayout}
      >
        <Header
          title={headerTitle}
          onTitlePress={handleHeaderTitlePress}
          rightActions={homeHeaderActions}
        />
        <Animated.View
          pointerEvents={isCalendarVisible ? "auto" : "none"}
          style={[{ overflow: "hidden" }, calendarStripAnimatedStyle]}
        >
          <CalendarStrip
            ref={calendarStripRef}
            selectedDate={resolvedDateForList}
            todayDate={todayDateStr}
            onSelectDate={handleCalendarSelectDate}
          />
          <View
            style={{
              height: SEPARATOR_RENDER_HEIGHT,
              backgroundColor: separatorColor,
            }}
          />
        </Animated.View>
      </View>

      {/* Scrollable content: active list + completed section */}
      {(isHabitDataLoading && habits.length === 0) ||
      !isInteractiveDayLoaded ||
      !allDayRecordsLoaded ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="small" color={headerIconColor} />
        </View>
      ) : (
        <ScrollView
          ref={mainScrollRef}
          style={{ flex: 1, backgroundColor: screenBg }}
          bounces={true}
          alwaysBounceVertical={true}
          overScrollMode="always"
          onScroll={handleScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onMomentumScrollBegin={handleMomentumScrollBegin}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          scrollEventThrottle={16}
        >
          <>
            {/* Downward flights should pass under list rows, but stay above scroll background. */}
            <SectionFlightOverlay
              flyingState={underContentFlightState}
              overlayStyle={flight.overlayStyle}
              separatorColor={separatorColor}
              surfaceBackgroundColor={surfaceBg}
              layer="under"
              yOffset={underOverlayYOffset}
              clipBottomAnimDurationMs={transfer.rowShiftDurationMs}
              onOverlayBind={handleTransferOverlayBind}
              onOverlayVisualReady={handleTransferOverlayVisualReady}
              onOverlayUnbind={handleTransferOverlayUnbind}
            />

            {/* Active habits */}
            <ActiveHabitsList
              key={`active-${layoutEpoch}`}
              layoutEpoch={layoutEpoch}
              items={activeItems}
              hiddenHabitId={transfer.hiddenActiveHabitId}
              incomingPlaceholderIndex={activeIncomingPlaceholderIndex}
              outgoingSourceIndex={activeOutgoingSourceIndex}
              rowShiftDurationMs={transfer.rowShiftDurationMs}
              suppressLayoutAnimations={suppressLayoutAnimations}
              animateCheckboxTransitions={animateCheckboxTransitions}
              checkboxDisabled={listIsFuture}
              gapBackgroundColor={screenBg}
              onCheckboxPress={handleTransferCheckboxPress}
              onCheckboxLongPress={openContextMenu}
              onPressHabit={openHabitDetail}
              onLongPressHabit={openContextMenu}
              onReorderActiveIds={handleReorderActiveIds}
              isBusy={transfer.isBusy}
              showTopSeparator={!isCalendarVisible}
              separatorColor={separatorColor}
              surfaceBackgroundColor={surfaceBg}
            />

            {/* Completed habits section (toggle + expandable list) */}
            <CompletedHabitsSection
              key={`completed-${layoutEpoch}`}
              layoutEpoch={layoutEpoch}
              items={completedItems}
              expanded={completedExpanded}
              incomingPlaceholderIndex={completedIncomingPlaceholderIndex}
              preserveGapSourceIndex={completedPreserveGapSourceIndex}
              rowShiftDurationMs={transfer.rowShiftDurationMs}
              isBusy={transfer.isBusy}
              lockToggleInteraction={transfer.isTransferSyncActive}
              suppressLayoutAnimations={suppressLayoutAnimations}
              animateCheckboxTransitions={animateCheckboxTransitions}
              checkboxDisabled={listIsFuture}
              preserveHiddenSlot={completedPreserveHiddenSlot}
              hasPrecedingSeparator={
                isCalendarVisible ||
                activeItems.some(
                  (item) => item.habit.id !== transfer.hiddenActiveHabitId,
                ) ||
                activeIncomingPlaceholderIndex != null
              }
              gapBackgroundColor={screenBg}
              onExpandedChange={setCompletedExpanded}
              hiddenHabitId={transfer.hiddenCompletedHabitId}
              onToggleLayout={handleCompletedToggleLayout}
              onCheckboxPress={handleTransferCheckboxPress}
              onCheckboxLongPress={openContextMenu}
              onPressHabit={openHabitDetail}
              onLongPressHabit={openContextMenu}
              separatorColor={separatorColor}
              surfaceBackgroundColor={surfaceBg}
            />

            {/* UX spacer: allow slight extra scroll past completed-section toggle */}
            <View
              pointerEvents="none"
              style={{
                height: LIST_END_SPACER_HEIGHT,
                backgroundColor: screenBg,
              }}
            />
          </>
        </ScrollView>
      )}

      {/* Flight overlay */}
      <SectionFlightOverlay
        flyingState={overContentFlightState}
        overlayStyle={flight.overlayStyle}
        separatorColor={separatorColor}
        surfaceBackgroundColor={surfaceBg}
        layer="over"
        clipTopY={overOverlayClipTopY}
        clipBottomAnimDurationMs={transfer.rowShiftDurationMs}
        onOverlayBind={handleTransferOverlayBind}
        onOverlayVisualReady={handleTransferOverlayVisualReady}
        onOverlayUnbind={handleTransferOverlayUnbind}
      />

      {/* FAB */}
      <FAB
        onPress={() => {
          const result = runNavigationIntent({
            target: "/create",
            dispatch: () => {
              router.push({
                pathname: "/create",
                params: { date: resolvedDateForList },
              });
            },
          });
          if (result.status === "blocked") {
          } else if (result.status === "failed") {
            console.error("Failed to open habit creation", result.error);
          }
        }}
      />

      {/* Overlays */}
      <HomeMainMenuController
        ref={mainMenuRef}
        onExport={handleMainExport}
        onImport={handleMainImport}
        onAbout={handleMainAbout}
      />

      <HomeAboutDialogController ref={aboutDialogRef} />

      <HomeHabitMenuController
        ref={habitMenuRef}
        onAction={handleContextAction}
        onArchive={handleContextArchive}
      />

      <HomeFailureReasonController
        ref={failureReasonRef}
        currentLocalDate={todayDateStr}
        canSubmit={canSubmitFailureReason}
        onSubmit={handleFailureSubmit}
      />

      <HomeDataTransferOverlayController
        ref={dataTransferOverlayRef}
        selectedDate={selectedDate}
      />

      {insets.bottom > 0 ? (
        <View
          pointerEvents="none"
          style={{ height: insets.bottom, backgroundColor: screenBg }}
        />
      ) : null}
    </View>
  );
});
interface HabitListScreenVisualContentProps {
  habitState: HabitListScreenContentProps["habitState"];
  getDayRecordsWitness: HabitListScreenContentProps["getDayRecordsWitness"];
}
const HabitListScreenVisualContent = React.memo(
  function HabitListScreenVisualContent({
    habitState,
    getDayRecordsWitness,
  }: HabitListScreenVisualContentProps) {
    const currentTheme = useVisualTheme();
    const currentColorScheme = useVisualColorScheme();
    return (
      <>
        <FocusedRouteModuleWarmup entries={HOME_ROUTE_MODULE_WARMUPS} />
        <HabitListScreenContent
          visualTheme={currentTheme}
          visualColorScheme={currentColorScheme}
          habitState={habitState}
          getDayRecordsWitness={getDayRecordsWitness}
        />
      </>
    );
  },
);
/**
 * The native stack intentionally retains Home below pushed routes. Its data
 * snapshot and visual revision are therefore both focus-aware: covered Home
 * may catch up in interruptible background work, but it is never allowed to
 * make the foreground settings interaction wait for a full habit-list render.
 */
export default function HabitListScreen() {
  const homeIsFocused = useIsFocused();
  const { snapshot: habitState, getDayRecordsWitness } =
    useLiveHabitStoreSnapshot(homeIsFocused);
  return (
    <FocusDeferredScreenPreferencesBoundary focused={homeIsFocused}>
      <HabitListScreenVisualContent
        habitState={habitState}
        getDayRecordsWitness={getDayRecordsWitness}
      />
    </FocusDeferredScreenPreferencesBoundary>
  );
}
