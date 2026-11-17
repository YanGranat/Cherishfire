/** @jsxImportSource nativewind */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  View,
  Text,
  FlatList,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Dimensions,
  ActivityIndicator,
  Pressable,
  type ListRenderItemInfo,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { darkTheme, lightTheme } from "@/theme/colors";
import { Header } from "@/components/layout/Header";
import { InlineErrorBanner } from "@/components/ui/InlineErrorBanner";
import { Dialog } from "@/components/ui/Dialog";
import {
  NoteCard,
  type NoteEditorGeometryMetrics,
  type NoteEditorGeometryTargets,
} from "@/features/notes/components/NoteCard";
import {
  NoteInput,
  type NoteInputHandle,
} from "@/features/notes/components/NoteInput";
import { NoteEditorViewport, hasNativeNoteEditorViewport } from "@/platform/note-editor-viewport";
import {
  getNoteKeyboardLayoutMetrics,
  getReportedKeyboardOverlap,
} from "@/features/notes/utils/keyboard-layout";
import {
  getNoteEditorVisibilityDecision,
  getNoteCaretScrollDelta,
  NOTE_EDITOR_VISIBILITY_TOLERANCE_DP as EDITOR_VISIBILITY_TOLERANCE_DP,
} from "@/features/notes/utils/editor-visibility";
import { parseHabitRouteId } from "@/domain/habits/route-id";
import { notesApplication, type NotesSessionNote } from "@/composition/notes";
import { useHabitStore } from "@/stores/habit-store";
import { NoteEditorSession, type NoteEditorRowOwner } from "@/features/notes/utils/note-editor-session";
import { UnsavedNotesGuard } from "@/features/notes/components/UnsavedNotesGuard";
interface PageMeasurable {
  measure: (
    callback: (
      x: number,
      y: number,
      width: number,
      height: number,
      pageX: number,
      pageY: number,
    ) => void,
  ) => void;
}
interface ActiveEditorSave {
  noteId: number;
  saveDraft: () => boolean;
  owner?: NoteEditorRowOwner;
}
interface ActiveEditorGeometry {
  requestId: number;
  targets: NoteEditorGeometryTargets;
  metrics: NoteEditorGeometryMetrics;
}
interface EditorGeometryRun {
  entry: ActiveEditorGeometry;
  geometryKey: string;
  frame: number | null;
  deadline: ReturnType<typeof setTimeout> | null;
  startedAtMs: number;
  attempts: number;
  cancelled: boolean;
  environmentEpoch: number;
}
interface PendingEditorCorrection {
  requestId: number;
  geometryKey: string;
  environmentEpoch: number;
  fromOffset: number;
  requestedOffset: number;
}
interface NoteRootMeasurementOwner {
  live: boolean;
  target: PageMeasurable | null;
  requestId: number;
  originY: number | null;
  layoutWidth: number | null;
  layoutY: number | null;
}
function getEditorGeometryKey(
  entry: ActiveEditorGeometry,
  environmentEpoch: number,
): string {
  return [
    entry.targets.noteId,
    entry.metrics.length,
    entry.metrics.lineCount,
    entry.metrics.heightBucket,
    entry.metrics.selectionAtEnd,
    entry.metrics.contentRevision,
    entry.metrics.selectionStart,
    entry.metrics.selectionEnd,
    environmentEpoch,
  ].join(":");
}
function isPageMeasurable(value: unknown): value is PageMeasurable {
  return (
    typeof value === "object" &&
    value !== null &&
    "measure" in value &&
    typeof value.measure === "function"
  );
}
// Chronological list (oldest on top), input at bottom,
// empty state with icon and text.
const TOP_SCROLL_SETTLE_THRESHOLD_DP = 16;
const TOP_SCROLL_SETTLE_DELAY_MS = 30;
const EDITOR_VISIBILITY_MAX_FRAMES = 12;
const EDITOR_VISIBILITY_MAX_DURATION_MS = 250;
const NOTE_LIST_CONTENT_STYLE = { paddingTop: 12, paddingBottom: 12 } as const;
const noteKeyExtractor = (item: NotesSessionNote) => item.clientMutationId;
function getMonotonicNow(): number {
  return typeof globalThis.performance !== "undefined" &&
    typeof globalThis.performance.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}
export default function NotesRoute() {
  const { id } = useLocalSearchParams<{
    id: string;
  }>();
  const habitId = parseHabitRouteId(id);
  if (habitId == null) return <MissingNotesRoute />;
  // Expo Router can reuse a mounted dynamic route for another id. Key the
  // stateful notes screen by its real owner so caches, optimistic writes,
  // editor refs and keyboard geometry can never leak between habits.
  return <NotesScreen key={String(habitId)} habitId={habitId} />;
}
function MissingNotesRoute() {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <Header
        title={t("notes.title")}
        showBack
        onBack={() => {
          router.back();
        }}
        centerTitle
      />
      <View className="flex-1 items-center justify-center px-xl">
        <MaterialIcons name="search-off" size={52} color="#9E9E9E" />
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
    </View>
  );
}
function NotesScreen({ habitId }: { habitId: number }) {
  const router = useRouter();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const backgroundColor =
    useVisualEffectiveMode() === "dark"
      ? darkTheme.background
      : lightTheme.background;
  const nativeKeyboardLayoutOwner = Platform.OS === "ios";
  const [notesSession] = useState(() => notesApplication.getSession(habitId));
  const notesSnapshot = useSyncExternalStore(
    notesSession.subscribe,
    notesSession.getSnapshot,
    notesSession.getSnapshot,
  );
  const noteList = notesSnapshot.notes;
  const [editorSession, setEditorSession] = useState(
    () => new NoteEditorSession(notesSnapshot.generation),
  );
  if (editorSession.generation !== notesSnapshot.generation) {
    setEditorSession(new NoteEditorSession(notesSnapshot.generation));
  }
  const habitExists = notesSnapshot.habitExists;
  const [hasComposerDraft, setHasComposerDraft] = useState(false);
  const isLoading =
    notesSnapshot.habitExists == null &&
    (notesSnapshot.status === "idle" || notesSnapshot.status === "loading");
  const loadError =
    notesSnapshot.status === "load-error" ? t("notes.loadError") : null;
  const mutationError =
    notesSnapshot.mutationError === "delete"
      ? t("notes.deleteError")
      : notesSnapshot.mutationError === "save"
        ? t("notes.saveError")
        : null;
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [keyboardOverlap, setKeyboardOverlap] = useState(0);
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const keyboardTopRef = useRef<number | null>(null);
  const [rootLayoutHeight, setRootLayoutHeight] = useState(
    () => Dimensions.get("window").height,
  );
  const [measuredRootBottom, setMeasuredRootBottom] = useState<number | null>(null);
  const rootMeasurementRef = useRef<NoteRootMeasurementOwner>({
    live: true,
    target: null,
    requestId: 0,
    originY: null,
    layoutWidth: null,
    layoutY: null,
  });
  const measureNoteRoot = useCallback(() => {
    if (Platform.OS !== "android") return;
    const owner = rootMeasurementRef.current;
    const target = owner.target;
    const requestId = ++owner.requestId;
    if (!owner.live || !target) return;
    target.measure((_x, _y, _width, height, _pageX, pageY) => {
      if (!owner.live || owner.target !== target || owner.requestId !== requestId) return;
      if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(pageY)) return;
      owner.originY = pageY;
      setMeasuredRootBottom(pageY + height);
    });
  }, []);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const owner = rootMeasurementRef.current;
    owner.live = true;
    measureNoteRoot();
    let previousScreen: { width: number; height: number } = Dimensions.get("screen");
    const handleScreenDimensionsChange = ({ screen }: { screen: { width: number; height: number } }) => {
      if (!owner.live) return;
      if (screen.width === previousScreen.width && screen.height === previousScreen.height) return;
      previousScreen = screen;
      owner.originY = null;
      setMeasuredRootBottom(null);
      measureNoteRoot();
    };
    const subscription = Dimensions.addEventListener("change", handleScreenDimensionsChange);
    return () => {
      owner.live = false;
      owner.requestId += 1;
      subscription.remove();
    };
  }, [measureNoteRoot]);
  const [editingNoteIds, setEditingNoteIds] = useState<Set<number>>(
    () => new Set(),
  );
  const noteListRef = useRef<FlatList<NotesSessionNote>>(null);
  const noteInputRef = useRef<NoteInputHandle>(null);
  const [noteRecoveryDrafts, setNoteRecoveryDrafts] = useState(
    () =>
      new Map<
        number,
        {
          sequence: number;
          text: string;
        }
      >(),
  );
  const [recoveryGeneration, setRecoveryGeneration] = useState(notesSnapshot.generation);
  if (recoveryGeneration !== notesSnapshot.generation) {
    setRecoveryGeneration(notesSnapshot.generation);
    setNoteRecoveryDrafts(new Map());
  }
  const shouldScrollToNewNoteRef = useRef(false);
  const scrollOffsetRef = useRef(0);
  const observedScrollGenerationRef = useRef(0);
  const isScrollDragActiveRef = useRef(false);
  const isMomentumScrollActiveRef = useRef(false);
  const topScrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const activeEditorNoteIdRef = useRef<number | null>(null);
  const activeEditorTargetRef = useRef<View | null>(null);
  const activeEditorGeometryRef = useRef<ActiveEditorGeometry | null>(null);
  const editorGeometryFramesRef = useRef(new Map<number, EditorGeometryRun>());
  const editorGeometryEnvironmentEpochRef = useRef(0);
  const completedEditorGeometryKeyRef = useRef<string | null>(null);
  const pendingEditorCorrectionRef = useRef<PendingEditorCorrection | null>(
    null,
  );
  const activeEditorSaveRef = useRef<ActiveEditorSave | null>(null);
  const editorHandoffInProgressRef = useRef(false);
  const [composerReleasePending, setComposerReleasePending] = useState(false);
  const editorRevealFrameRef = useRef<number | null>(null);
  const editorCorrectionRecheckFrameRef = useRef<number | null>(null);
  const lastProcessedPresentationChangeRef = useRef(
    notesSnapshot.presentationChanges.at(-1)?.sequence ?? 0,
  );
  const maximumRootLayoutHeightRef = useRef(rootLayoutHeight);
  maximumRootLayoutHeightRef.current = Math.max(
    maximumRootLayoutHeightRef.current,
    rootLayoutHeight,
  );
  const { keyboardVisible, composerKeyboardLift, viewportKeyboardLift } =
    getNoteKeyboardLayoutMetrics({
      maximumLayoutHeight: maximumRootLayoutHeightRef.current,
      currentLayoutHeight: rootLayoutHeight,
      keyboardOverlap,
      bottomInset: insets.bottom,
      nativeLayoutOwner: nativeKeyboardLayoutOwner,
      measuredRootBottom,
      keyboardTop,
    });
  const editorKeyboardLift =
    Platform.OS === "android" && editingNoteIds.size > 0
      ? viewportKeyboardLift
      : 0;
  const keyboardVisibleRef = useRef(keyboardVisible);
  keyboardVisibleRef.current = keyboardVisible;
  const hideComposer = editingNoteIds.size > 0 || composerReleasePending;
  const editorBottomPadding =
    editorKeyboardLift + (hideComposer && !keyboardVisible ? insets.bottom : 0);
  const extendEditorPainting = Platform.OS === "android" && editingNoteIds.size > 0;
  const getKnownHabitExists = useCallback(() => {
    const habitState = useHabitStore.getState();
    return habitState.allHabits.some((habit) => habit.id === habitId) ||
      habitState.habits.some((habit) => habit.id === habitId)
      ? true
      : habitState.allHabitsLoaded
        ? false
        : null;
  }, [habitId]);
  useFocusEffect(
    useCallback(() => {
      if (notesSnapshot.status === "idle") {
        void notesSession.ensureLoaded(getKnownHabitExists);
      }
    }, [getKnownHabitExists, notesSession, notesSnapshot.status]),
  );
  const clearTopScrollSettleTimer = useCallback(() => {
    if (topScrollSettleTimerRef.current == null) return;
    clearTimeout(topScrollSettleTimerRef.current);
    topScrollSettleTimerRef.current = null;
  }, []);
  const settleAtTop = useCallback(() => {
    noteListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);
  const clearEditorRevealFrame = useCallback(() => {
    if (editorRevealFrameRef.current == null) return;
    cancelAnimationFrame(editorRevealFrameRef.current);
    editorRevealFrameRef.current = null;
  }, []);
  const clearEditorCorrectionRecheckFrame = useCallback(() => {
    if (editorCorrectionRecheckFrameRef.current == null) return;
    cancelAnimationFrame(editorCorrectionRecheckFrameRef.current);
    editorCorrectionRecheckFrameRef.current = null;
  }, []);
  const clearEditorGeometryFrames = useCallback(() => {
    clearEditorCorrectionRecheckFrame();
    for (const run of editorGeometryFramesRef.current.values()) {
      run.cancelled = true;
      if (run.frame != null) cancelAnimationFrame(run.frame);
      if (run.deadline != null) clearTimeout(run.deadline);
    }
    editorGeometryFramesRef.current.clear();
    pendingEditorCorrectionRef.current = null;
  }, [clearEditorCorrectionRecheckFrame]);
  // Native resize and TextInput growth can settle across several frames.
  // Re-measure the visible editor leaves after each minimal scroll instead of
  // assuming that one delayed wrapper measurement represents the final UI.
  const scheduleEditorGeometry = useCallback(
    (requestedEntry: ActiveEditorGeometry) => {
      if (
        activeEditorSaveRef.current?.noteId !== requestedEntry.targets.noteId
      ) {
        return;
      }
      const entry: ActiveEditorGeometry = {
        ...requestedEntry,
      };
      activeEditorGeometryRef.current = entry;
      if (hasNativeNoteEditorViewport) return;
      if (keyboardTopRef.current == null) return;
      clearEditorRevealFrame();
      const environmentEpoch = editorGeometryEnvironmentEpochRef.current;
      const geometryKey = getEditorGeometryKey(entry, environmentEpoch);
      if (completedEditorGeometryKeyRef.current === geometryKey) return;
      const currentRun = editorGeometryFramesRef.current.get(entry.requestId);
      if (
        currentRun &&
        !currentRun.cancelled &&
        currentRun.environmentEpoch === environmentEpoch &&
        currentRun.entry.targets.editor === entry.targets.editor &&
        currentRun.entry.targets.actions === entry.targets.actions &&
        currentRun.entry.targets.requestId === entry.targets.requestId
      ) {
        currentRun.entry = entry;
        return;
      }
      for (const [requestId, previous] of editorGeometryFramesRef.current) {
        previous.cancelled = true;
        if (previous.frame != null) cancelAnimationFrame(previous.frame);
        if (previous.deadline != null) clearTimeout(previous.deadline);
        editorGeometryFramesRef.current.delete(requestId);
        const pendingCorrection = pendingEditorCorrectionRef.current;
        if (
          pendingCorrection?.requestId === requestId &&
          pendingCorrection.environmentEpoch === previous.environmentEpoch
        ) {
          pendingEditorCorrectionRef.current = null;
        }
      }
      const run: EditorGeometryRun = {
        entry,
        geometryKey,
        frame: null,
        deadline: null,
        startedAtMs: getMonotonicNow(),
        attempts: 0,
        cancelled: false,
        environmentEpoch,
      };
      editorGeometryFramesRef.current.set(entry.requestId, run);
      const isCurrent = () => {
        const active = activeEditorGeometryRef.current;
        return (
          !run.cancelled &&
          !isScrollDragActiveRef.current &&
          !isMomentumScrollActiveRef.current &&
          editorGeometryFramesRef.current.get(entry.requestId) === run &&
          editorGeometryEnvironmentEpochRef.current === environmentEpoch &&
          active?.requestId === entry.requestId &&
          active.targets.noteId === entry.targets.noteId &&
          active.targets.editor === entry.targets.editor &&
          active.targets.actions === entry.targets.actions &&
          active.targets.requestId === entry.targets.requestId &&
          entry.targets.getRequestId() === entry.targets.requestId
        );
      };
      const stopRun = () => {
        if (run.cancelled) return false;
        run.cancelled = true;
        if (run.frame != null) cancelAnimationFrame(run.frame);
        if (run.deadline != null) clearTimeout(run.deadline);
        run.frame = null;
        run.deadline = null;
        if (editorGeometryFramesRef.current.get(entry.requestId) === run) {
          editorGeometryFramesRef.current.delete(entry.requestId);
        }
        const pendingCorrection = pendingEditorCorrectionRef.current;
        if (
          pendingCorrection?.requestId === entry.requestId &&
          pendingCorrection.environmentEpoch === environmentEpoch
        ) {
          pendingEditorCorrectionRef.current = null;
        }
        return true;
      };
      const stopAsSuperseded = () => {
        stopRun();
      };
      const stopAsFailed = () => {
        stopRun();
      };
      const stopAsVisible = () => {
        if (!stopRun()) return;
        completedEditorGeometryKeyRef.current = run.geometryKey;
      };
      const scheduleRetry = () => {
        if (!isCurrent()) {
          stopAsSuperseded();
          return;
        }
        if (run.frame != null) return;
        run.frame = requestAnimationFrame(() => {
          run.frame = null;
          attempt();
        });
      };
      const attempt = () => {
        if (!isCurrent()) {
          stopAsSuperseded();
          return;
        }
        const elapsedMs = getMonotonicNow() - run.startedAtMs;
        if (run.attempts >= EDITOR_VISIBILITY_MAX_FRAMES) {
          stopAsFailed();
          return;
        }
        if (elapsedMs >= EDITOR_VISIBILITY_MAX_DURATION_MS) {
          stopAsFailed();
          return;
        }
        run.attempts += 1;
        const list = noteListRef.current;
        const scrollView = noteListRef.current?.getNativeScrollRef();
        const editor = entry.targets.editor;
        const actions = entry.targets.actions;
        const keyboardTop = keyboardTopRef.current;
        if (keyboardTop == null) {
          stopAsSuperseded();
          return;
        }
        if (!list || !isPageMeasurable(scrollView) || !editor || !actions) {
          scheduleRetry();
          return;
        }
        const scrollGeneration = observedScrollGenerationRef.current;
        const measurementIsCurrent = () => {
          if (!isCurrent()) {
            stopAsSuperseded();
            return false;
          }
          if (observedScrollGenerationRef.current !== scrollGeneration) {
            scheduleRetry();
            return false;
          }
          return true;
        };
        const applyScrollDelta = (delta: number | null) => {
          if (!measurementIsCurrent()) return;
          if (delta == null) {
            scheduleRetry();
            return;
          }
          const currentOffset = Math.max(0, scrollOffsetRef.current);
          if (Math.abs(delta) <= EDITOR_VISIBILITY_TOLERANCE_DP) {
            stopAsVisible();
            return;
          }
          const nextOffset = Math.max(0, currentOffset + delta);
          // Only native onScroll can acknowledge movement. Never accumulate
          // a second correction from an offset that has not moved yet.
          if (
            Math.abs(nextOffset - currentOffset) > EDITOR_VISIBILITY_TOLERANCE_DP &&
            pendingEditorCorrectionRef.current == null
          ) {
            pendingEditorCorrectionRef.current = {
              requestId: entry.requestId,
              geometryKey: run.geometryKey,
              environmentEpoch,
              fromOffset: currentOffset,
              requestedOffset: nextOffset,
            };
            clearTopScrollSettleTimer();
            list.scrollToOffset({ offset: nextOffset, animated: false });
          }
          scheduleRetry();
        };
        if (entry.targets.caretMetricsAvailable) {
          const input = entry.targets.input;
          if (!input) {
            scheduleRetry();
            return;
          }
          void entry.targets.readCaretMetrics().then((caret) => {
            if (!measurementIsCurrent()) return;
            if (!caret) {
              scheduleRetry();
              return;
            }
            scrollView.measure((_x, _y, _w, viewportHeight, _px, viewportTop) => {
              if (!measurementIsCurrent()) return;
              input.measure((_ix, _iy, width, height, _ipx, inputTop) => {
                if (!measurementIsCurrent()) return;
                if (
                  Math.abs(width - caret.hostWidth) > EDITOR_VISIBILITY_TOLERANCE_DP ||
                  Math.abs(height - caret.hostHeight) > EDITOR_VISIBILITY_TOLERANCE_DP
                ) {
                  scheduleRetry();
                  return;
                }
                editor.measure((_ex, _ey, _ew, editorHeight, _epx, editorPageY) => {
                  if (!measurementIsCurrent()) return;
                  actions.measure((_ax, _ay, _aw, actionsHeight, _apx, actionsPageY) => {
                    if (!measurementIsCurrent()) return;
                    const wholeEditor = getNoteEditorVisibilityDecision({
                      viewportHeight, viewportPageY: viewportTop, editorHeight, editorPageY,
                      actionsHeight, actionsPageY, keyboardTop,
                      selectionAtEnd: entry.metrics.selectionAtEnd,
                    });
                    if (!wholeEditor.valid) {
                      scheduleRetry();
                      return;
                    }
                    applyScrollDelta(
                      wholeEditor.visibilityMode === "native-caret"
                        ? getNoteCaretScrollDelta({
                            viewportTop, viewportHeight, inputTop,
                            caretTop: caret.top, caretBottom: caret.bottom, keyboardTop,
                          })
                        : wholeEditor.visible ? 0 : wholeEditor.scrollDelta,
                    );
                  });
                });
              });
            });
          }, () => {
            if (measurementIsCurrent()) scheduleRetry();
          });
          return;
        }
        scrollView.measure(
          (_vx, _vy, _vw, viewportHeight, _vpx, viewportPageY) => {
            if (!measurementIsCurrent()) return;
            editor.measure((_ex, _ey, _ew, editorHeight, _epx, editorPageY) => {
              if (!measurementIsCurrent()) return;
              actions.measure(
                (_ax, _ay, _aw, actionsHeight, _apx, actionsPageY) => {
                  if (!measurementIsCurrent()) return;
                  const decision = getNoteEditorVisibilityDecision({
                    viewportHeight,
                    viewportPageY,
                    editorHeight,
                    editorPageY,
                    actionsHeight,
                    actionsPageY,
                    keyboardTop,
                    selectionAtEnd: entry.metrics.selectionAtEnd,
                  });
                  if (!decision.valid) {
                    scheduleRetry();
                    return;
                  }
                  if (decision.visibilityMode === "native-caret") {
                    stopRun();
                    return;
                  }
                  applyScrollDelta(decision.visible ? 0 : decision.scrollDelta);
                },
              );
            });
          },
        );
      };
      run.deadline = setTimeout(() => {
        if (isCurrent()) {
          stopAsFailed();
        } else {
          stopAsSuperseded();
        }
      }, EDITOR_VISIBILITY_MAX_DURATION_MS);
      // Layout callers already run after React committed the new geometry.
      // Measure that layout now; only an unresolved native measurement retries
      // on the following frame.
      attempt();
    },
    [clearEditorRevealFrame, clearTopScrollSettleTimer],
  );
  const revealActiveEditor = useCallback(() => {
    const entry = activeEditorGeometryRef.current;
    if (entry) scheduleEditorGeometry(entry);
  }, [scheduleEditorGeometry]);
  const scheduleEditorReveal = useCallback(() => {
    if (
      activeEditorNoteIdRef.current == null ||
      activeEditorTargetRef.current == null
    ) {
      return;
    }
    clearEditorRevealFrame();
    editorRevealFrameRef.current = requestAnimationFrame(() => {
      editorRevealFrameRef.current = null;
      revealActiveEditor();
    });
  }, [clearEditorRevealFrame, revealActiveEditor]);
  const revalidateActiveEditorGeometry = useCallback(() => {
    clearEditorCorrectionRecheckFrame();
    editorGeometryEnvironmentEpochRef.current += 1;
    completedEditorGeometryKeyRef.current = null;
    pendingEditorCorrectionRef.current = null;
    const entry = activeEditorGeometryRef.current;
    if (entry) scheduleEditorGeometry(entry);
  }, [clearEditorCorrectionRecheckFrame, scheduleEditorGeometry]);
  useLayoutEffect(() => {
    revalidateActiveEditorGeometry();
  }, [keyboardTop, revalidateActiveEditorGeometry, rootLayoutHeight]);
  const handleNoteListLayout = useCallback(() => {
    revalidateActiveEditorGeometry();
  }, [revalidateActiveEditorGeometry]);
  const scheduleTopScrollSettle = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y;
      if (y > TOP_SCROLL_SETTLE_THRESHOLD_DP) return;
      clearTopScrollSettleTimer();
      // Keep the native edge stretch while the finger is down. Once the
      // gesture has ended, settle a tiny residual offset to the real top so
      // the next touch cannot release it as a visible jump.
      topScrollSettleTimerRef.current = setTimeout(() => {
        if (scrollOffsetRef.current <= TOP_SCROLL_SETTLE_THRESHOLD_DP) {
          settleAtTop();
        }
      }, TOP_SCROLL_SETTLE_DELAY_MS);
    },
    [clearTopScrollSettleTimer, settleAtTop],
  );
  const handleNotesScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y;
      if (Math.abs(y - scrollOffsetRef.current) > 0.01) {
        observedScrollGenerationRef.current += 1;
      }
      scrollOffsetRef.current = y;
      const pendingCorrection = pendingEditorCorrectionRef.current;
      if (pendingCorrection != null) {
        const requestedDelta =
          pendingCorrection.requestedOffset - pendingCorrection.fromOffset;
        const observedDelta = y - pendingCorrection.fromOffset;
        const direction = Math.sign(requestedDelta);
        const movedTowardTarget =
          direction !== 0 &&
          observedDelta * direction > EDITOR_VISIBILITY_TOLERANCE_DP;
        const reachedTarget =
          Math.abs(y - pendingCorrection.requestedOffset) <=
          EDITOR_VISIBILITY_TOLERANCE_DP;
        if (movedTowardTarget || reachedTarget) {
          pendingEditorCorrectionRef.current = null;
          clearEditorCorrectionRecheckFrame();
        }
      }
      if (
        isMomentumScrollActiveRef.current &&
        !isScrollDragActiveRef.current &&
        y <= TOP_SCROLL_SETTLE_THRESHOLD_DP
      ) {
        isMomentumScrollActiveRef.current = false;
        clearTopScrollSettleTimer();
        settleAtTop();
      }
    },
    [clearEditorCorrectionRecheckFrame, clearTopScrollSettleTimer, settleAtTop],
  );
  const handleNotesScrollBeginDrag = useCallback(() => {
    isScrollDragActiveRef.current = true;
    isMomentumScrollActiveRef.current = false;
    clearTopScrollSettleTimer();
  }, [clearTopScrollSettleTimer]);
  const handleNotesScrollEndDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      isScrollDragActiveRef.current = false;
      scheduleTopScrollSettle(event);
    },
    [scheduleTopScrollSettle],
  );
  const handleNotesMomentumScrollBegin = useCallback(() => {
    isMomentumScrollActiveRef.current = true;
    clearTopScrollSettleTimer();
  }, [clearTopScrollSettleTimer]);
  const handleNotesMomentumScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      isMomentumScrollActiveRef.current = false;
      scheduleTopScrollSettle(event);
    },
    [scheduleTopScrollSettle],
  );
  useEffect(
    () => () => {
      clearTopScrollSettleTimer();
      clearEditorRevealFrame();
      clearEditorGeometryFrames();
    },
    [
      clearEditorGeometryFrames,
      clearEditorRevealFrame,
      clearTopScrollSettleTimer,
    ],
  );
  useEffect(() => {
    const showEvent =
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent =
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const keyboardShownSubscription = Keyboard.addListener(
      showEvent,
      (event) => {
        const eventHeight = event.endCoordinates?.height ?? 0;
        const screenY = event.endCoordinates?.screenY;
        const screenHeight = Dimensions.get("screen").height;
        const overlapFromScreenY =
          typeof screenY === "number" ? Math.max(0, screenHeight - screenY) : 0;
        const selectedOverlap = getReportedKeyboardOverlap({
          eventHeight,
          overlapFromScreenY,
        });
        const nextKeyboardTop =
          typeof screenY === "number" && Number.isFinite(screenY)
            ? screenY
            : screenHeight - selectedOverlap;
        keyboardTopRef.current = nextKeyboardTop;
        setKeyboardTop(nextKeyboardTop);
        setKeyboardOverlap(selectedOverlap);
        measureNoteRoot();
        scheduleEditorReveal();
      },
    );
    const keyboardHiddenSubscription = Keyboard.addListener(hideEvent, () => {
      setComposerReleasePending(false);
      keyboardTopRef.current = null;
      setKeyboardTop(null);
      setKeyboardOverlap(0);
      pendingEditorCorrectionRef.current = null;
      clearEditorGeometryFrames();
    });
    return () => {
      keyboardShownSubscription.remove();
      keyboardHiddenSubscription.remove();
    };
  }, [
    clearEditorGeometryFrames,
    measureNoteRoot,
    scheduleEditorReveal,
  ]);
  useEffect(() => {
    if (editorKeyboardLift > 0) scheduleEditorReveal();
  }, [editorKeyboardLift, scheduleEditorReveal]);
  const handleSend = (text: string): boolean => {
    shouldScrollToNewNoteRef.current = true;
    const submission = notesSession.create(text);
    if (!submission.accepted) shouldScrollToNewNoteRef.current = false;
    return submission.accepted;
  };
  const handleSave = useCallback(
    (noteId: number, text: string): boolean => {
      const submission = notesSession.update(noteId, text);
      if (submission.accepted) {
        setNoteRecoveryDrafts((current) => {
          if (!current.has(noteId)) return current;
          const next = new Map(current);
          next.delete(noteId);
          return next;
        });
      }
      return submission.accepted;
    },
    [notesSession],
  );
  const handleDeleteRequest = useCallback((noteId: number) => {
    setDeleteTarget(noteId);
  }, []);
  const handleDelete = () => {
    if (deleteTarget == null) return;
    const targetId = deleteTarget;
    setDeleteTarget(null);
    const submission = notesSession.delete(targetId);
    if (submission.accepted) {
      setNoteRecoveryDrafts((current) => {
        if (!current.has(targetId)) return current;
        const next = new Map(current);
        next.delete(targetId);
        return next;
      });
    }
  };
  const handleNoteEditingChange = useCallback(
    (noteId: number, editing: boolean, saveDraft?: () => boolean, owner?: NoteEditorRowOwner) => {
      if (!editing && owner != null && activeEditorSaveRef.current?.owner !== owner) {
        return false;
      }
      if (editing) {
        if (!saveDraft) return false;
        const previousEditor = activeEditorSaveRef.current;
        const previousDraft = editorSession.getActiveDraft();
        if (previousDraft && previousDraft.noteId !== noteId) {
          editorHandoffInProgressRef.current = true;
          try {
            if (previousEditor?.noteId === previousDraft.noteId && previousEditor.owner?.live !== false) {
              if (!previousEditor.saveDraft()) return false;
            } else {
              const trimmed = previousDraft.text.trim();
              if (!trimmed) return false;
              const previousNote = notesSession.getSnapshot().notes.find(
                (note) => note.clientMutationId === previousDraft.clientMutationId,
              );
              if (
                previousNote &&
                trimmed !== previousNote.text &&
                !handleSave(previousNote.id, trimmed)
              ) {
                return false;
              }
              editorSession.finish(previousDraft.clientMutationId);
            }
          } finally {
            editorHandoffInProgressRef.current = false;
          }
        }
        activeEditorSaveRef.current = { noteId, saveDraft, owner };
        shouldScrollToNewNoteRef.current = false;
        activeEditorNoteIdRef.current = noteId;
        activeEditorTargetRef.current = null;
        clearTopScrollSettleTimer();
      } else if (activeEditorNoteIdRef.current === noteId) {
        activeEditorSaveRef.current = null;
        activeEditorNoteIdRef.current = null;
        activeEditorTargetRef.current = null;
        activeEditorGeometryRef.current = null;
        completedEditorGeometryKeyRef.current = null;
        pendingEditorCorrectionRef.current = null;
        clearEditorRevealFrame();
        clearEditorGeometryFrames();
        if (!editorHandoffInProgressRef.current) {
          if (keyboardVisibleRef.current) setComposerReleasePending(true);
          Keyboard.dismiss();
        }
      }
      setEditingNoteIds((current) => {
        if (editing) return new Set([noteId]);
        const alreadyTracked = current.has(noteId);
        if (!alreadyTracked) return current;
        const next = new Set(current);
        next.delete(noteId);
        return next;
      });
      return true;
    },
    [
      clearEditorGeometryFrames,
      clearEditorRevealFrame,
      clearTopScrollSettleTimer,
      editorSession,
      handleSave,
      notesSession,
    ],
  );
  const handleNoteEditorUnmount = useCallback(
    (noteId: number, clientMutationId: string, owner: NoteEditorRowOwner) => {
      if (activeEditorNoteIdRef.current !== noteId) return;
      if (activeEditorSaveRef.current?.owner !== owner) return;
      if (editorSession.getDraft(clientMutationId) == null) {
        handleNoteEditingChange(noteId, false);
        return;
      }
      // Virtualization detaches native targets, not the logical editor.
      activeEditorSaveRef.current = null;
      activeEditorTargetRef.current = null;
      activeEditorGeometryRef.current = null;
      completedEditorGeometryKeyRef.current = null;
      pendingEditorCorrectionRef.current = null;
      clearEditorRevealFrame();
      clearEditorGeometryFrames();
    },
    [
      clearEditorGeometryFrames,
      clearEditorRevealFrame,
      editorSession,
      handleNoteEditingChange,
    ],
  );
  useLayoutEffect(() => {
    editorSession.reconcile(noteList);
    const activeNoteId = activeEditorNoteIdRef.current;
    if (activeNoteId != null && editorSession.getActiveDraft() == null) {
      handleNoteEditingChange(activeNoteId, false);
    }
  }, [editorSession, handleNoteEditingChange, noteList]);
  const handleNoteEditorReady = useCallback(
    (noteId: number, target: View | null, phase: "focus" | "layout") => {
      if (!target || activeEditorSaveRef.current?.noteId !== noteId) return;
      activeEditorNoteIdRef.current = noteId;
      activeEditorTargetRef.current = target;
      clearTopScrollSettleTimer();
      if (phase === "layout") {
        clearEditorRevealFrame();
        revealActiveEditor();
      } else {
        scheduleEditorReveal();
      }
    },
    [
      clearEditorRevealFrame,
      clearTopScrollSettleTimer,
      revealActiveEditor,
      scheduleEditorReveal,
    ],
  );
  const handleNoteEditorGeometry = useCallback(
    (
      requestId: number,
      targets: NoteEditorGeometryTargets,
      metrics: NoteEditorGeometryMetrics,
    ) => {
      if (activeEditorSaveRef.current?.noteId !== targets.noteId) return;
      scheduleEditorGeometry({
        requestId,
        targets,
        metrics,
      });
    },
    [scheduleEditorGeometry],
  );
  const handleRecoveryApplied = useCallback(
    (noteId: number, sequence: number) => {
      if (!notesSession.acknowledgeRecovery(notesSnapshot.generation, sequence)) return;
      setNoteRecoveryDrafts((current) => {
        if (current.get(noteId)?.sequence !== sequence) return current;
        const next = new Map(current);
        next.delete(noteId);
        return next;
      });
    },
    [notesSession, notesSnapshot.generation],
  );
  const renderNote = useCallback(
    ({ item }: ListRenderItemInfo<NotesSessionNote>) => (
      <NoteCard
        key={`${editorSession.generation}:${item.clientMutationId}`}
        note={item}
        editorSession={editorSession}
        onSave={handleSave}
        onDelete={handleDeleteRequest}
        onEditingChange={handleNoteEditingChange}
        onEditorUnmount={handleNoteEditorUnmount}
        onEditorReady={handleNoteEditorReady}
        onEditorGeometry={handleNoteEditorGeometry}
        recoveryDraft={noteRecoveryDrafts.get(item.id) ?? null}
        onRecoveryApplied={handleRecoveryApplied}
      />
    ),
    [
      handleDeleteRequest,
      handleNoteEditingChange,
      handleNoteEditorUnmount,
      handleNoteEditorGeometry,
      handleNoteEditorReady,
      handleSave,
      handleRecoveryApplied,
      editorSession,
      noteRecoveryDrafts,
    ],
  );
  const handleNoteListContentSizeChange = useCallback(() => {
    const pendingCorrection = pendingEditorCorrectionRef.current;
    if (pendingCorrection != null && activeEditorGeometryRef.current != null) {
      // Give the native non-animated scroll two frames to acknowledge before
      // treating content growth as a clamped/no-op request. Clearing here
      // synchronously would permit a duplicate stale-offset correction.
      clearEditorCorrectionRecheckFrame();
      editorCorrectionRecheckFrameRef.current = requestAnimationFrame(() => {
        editorCorrectionRecheckFrameRef.current = requestAnimationFrame(() => {
          editorCorrectionRecheckFrameRef.current = null;
          if (
            pendingEditorCorrectionRef.current !== pendingCorrection ||
            activeEditorGeometryRef.current == null
          ) {
            return;
          }
          pendingEditorCorrectionRef.current = null;
          revalidateActiveEditorGeometry();
        });
      });
    }
    if (!shouldScrollToNewNoteRef.current) return;
    shouldScrollToNewNoteRef.current = false;
    noteListRef.current?.scrollToEnd({ animated: true });
  }, [clearEditorCorrectionRecheckFrame, revalidateActiveEditorGeometry]);
  const handleRootLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
    const { width, y } = event.nativeEvent.layout;
    const owner = rootMeasurementRef.current;
    if (!owner.live) return;
    if (Platform.OS === "android") {
      const target = isPageMeasurable(event.target) ? event.target : null;
      if (owner.target !== target || owner.layoutWidth !== width || owner.layoutY !== y) {
        owner.originY = null;
      }
      owner.target = target;
      owner.layoutWidth = width;
      owner.layoutY = y;
      setMeasuredRootBottom(owner.originY == null ? null : owner.originY + nextHeight);
    }
    maximumRootLayoutHeightRef.current = Math.max(
      maximumRootLayoutHeightRef.current,
      nextHeight,
    );
    setRootLayoutHeight((current) =>
      Math.abs(current - nextHeight) < 0.5 ? current : nextHeight,
    );
    measureNoteRoot();
  }, [measureNoteRoot]);
  useLayoutEffect(() => {
    const currentSnapshot = notesSession.getSnapshot();
    if (currentSnapshot.generation !== notesSnapshot.generation) return;
    const unclaimedSequences = new Set(
      currentSnapshot.presentationChanges
        .filter((change) => change.kind === "rollback" && change.recoveryText != null)
        .map((change) => change.sequence),
    );
    for (const change of notesSnapshot.presentationChanges) {
      const unclaimedRecovery = change.kind === "rollback" && change.recoveryText != null && unclaimedSequences.has(change.sequence);
      if (!unclaimedRecovery && change.sequence <= lastProcessedPresentationChangeRef.current) {
        continue;
      }
      lastProcessedPresentationChangeRef.current = Math.max(
        lastProcessedPresentationChangeRef.current,
        change.sequence,
      );
      if (!unclaimedRecovery || change.recoveryText == null) continue;
      const currentNote = noteList.find(
        (note) => note.clientMutationId === change.clientMutationId,
      );
      const expectedStateIsVisible = change.expectedPresent
        ? currentNote != null &&
          (change.expectedText == null ||
            currentNote.text === change.expectedText) &&
          (change.expectedUpdatedAt == null ||
            currentNote.updatedAt === change.expectedUpdatedAt)
        : currentNote == null;
      if (!expectedStateIsVisible) continue;
      const recovery = {
        sequence: change.sequence,
        text: change.recoveryText,
      };
      if (change.source === "create") {
        if (noteInputRef.current?.restoreDraft(recovery)) {
          notesSession.acknowledgeRecovery(notesSnapshot.generation, change.sequence);
        }
      } else if (change.source === "update" || change.source === "delete") {
        setNoteRecoveryDrafts((current) => {
          if (current.get(change.noteId)?.sequence === recovery.sequence) return current;
          const next = new Map(current);
          next.set(change.noteId, recovery);
          return next;
        });
      }
    }
  }, [hideComposer, noteList, notesSession, notesSnapshot.generation, notesSnapshot.presentationChanges]);
  return (
    <KeyboardAvoidingView
      cssInterop={false}
      style={{ flex: 1, backgroundColor }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      onLayout={handleRootLayout}
    >
      <Header
        title={t("notes.title")}
        showBack
        onBack={() => {
          router.back();
        }}
        centerTitle
      />

      {habitExists === false ? (
        <View className="flex-1 items-center justify-center px-xl">
          <MaterialIcons name="search-off" size={52} color="#9E9E9E" />
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
      ) : null}

      {habitExists === true && loadError ? (
        <InlineErrorBanner
          message={`${loadError} · ${t("notes.retry")}`}
          onPress={() => {
            void notesSession.reload(getKnownHabitExists);
          }}
          accessibilityLabel={`${loadError}. ${t("notes.retry")}`}
        />
      ) : null}

      {habitExists === true && mutationError ? (
        <InlineErrorBanner message={mutationError} />
      ) : null}

      {habitExists === false ? null : habitExists === null ? (
        isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" color="#9E9E9E" />
          </View>
        ) : loadError ? (
          <View className="flex-1 items-center justify-center px-xl">
            <MaterialIcons name="error-outline" size={52} color="#9E9E9E" />
            <Text className="mt-md text-center text-base text-muted">
              {loadError}
            </Text>
            <Pressable
              onPress={() => {
                void notesSession.reload(getKnownHabitExists);
              }}
              accessibilityRole="button"
              accessibilityLabel={t("notes.retry")}
              className="mt-md min-h-[44px] items-center justify-center px-lg"
            >
              <Text className="text-base font-semibold text-primary">
                {t("notes.retry")}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="small" color="#9E9E9E" />
          </View>
        )
      ) : isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="small" color="#9E9E9E" />
        </View>
      ) : noteList.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <MaterialIcons
            name="sticky-note-2"
            size={64}
            color="#9E9E9E"
            style={{ opacity: 0.4 }}
          />
          <Text className="text-muted text-base mt-base">
            {t("notes.emptyTitle")}
          </Text>
        </View>
      ) : (
        <NoteEditorViewport style={{ flex: 1, paddingBottom: editorBottomPadding, overflow: "hidden" }}>
        <FlatList
          ref={noteListRef}
          data={noteList}
          keyExtractor={noteKeyExtractor}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={
            Platform.OS === "ios" ? "interactive" : "on-drag"
          }
          bounces
          alwaysBounceVertical
          style={extendEditorPainting ? { overflow: "visible" } : undefined}
          removeClippedSubviews={extendEditorPainting ? false : undefined}
          overScrollMode="always"
          onScroll={handleNotesScroll}
          onScrollBeginDrag={handleNotesScrollBeginDrag}
          onScrollEndDrag={handleNotesScrollEndDrag}
          onMomentumScrollBegin={handleNotesMomentumScrollBegin}
          onMomentumScrollEnd={handleNotesMomentumScrollEnd}
          onLayout={handleNoteListLayout}
          scrollEventThrottle={16}
          renderItem={renderNote}
          contentContainerStyle={NOTE_LIST_CONTENT_STYLE}
          onContentSizeChange={handleNoteListContentSizeChange}
        />
        </NoteEditorViewport>
      )}

      {habitExists === true ? (
        <NoteInput
          ref={noteInputRef}
          onSend={handleSend}
          hidden={hideComposer}
          keyboardVisible={keyboardVisible}
          extraKeyboardLift={composerKeyboardLift}
          onDirtyChange={setHasComposerDraft}
        />
      ) : null}

      {/* Delete confirmation */}
      <Dialog
        visible={deleteTarget != null}
        title={t("notes.deleteTitle")}
        actions={[
          {
            label: t("notes.cancel"),
            onPress: () => {
              setDeleteTarget(null);
            },
            role: "cancel",
          },
          {
            label: t("notes.delete"),
            onPress: handleDelete,
            variant: "destructive",
          },
        ]}
      />
      <UnsavedNotesGuard
        editorSession={editorSession}
        hasComposerDraft={hasComposerDraft}
        enabled={habitExists === true}
      />
    </KeyboardAvoidingView>
  );
}
