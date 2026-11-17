/** @jsxImportSource nativewind */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Platform,
  findNodeHandle,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import { getAccentScheme, lightTheme, semantic } from "@/theme/colors";
import {
  useVisualLanguage,
  useVisualEffectiveMode,
  useVisualColorScheme,
} from "@/components/ScreenPreferencesBoundary";
import type { Note } from "@/types/note";
import { formatLocalizedDate } from "@/utils/date";
import { radii } from "@/theme/tokens";
import { mergeRecoveredDraft } from "@/utils/recovered-draft";
import { getNoteEditorContentHeight } from "@/features/notes/utils/editor-visibility";
import {
  hasNoteEditorCaretMetrics,
  readNoteEditorCaretMetrics,
  type NoteEditorCaretMetrics,
} from "@/platform/note-editor-metrics";
import type { NoteEditorRowOwner, NoteEditorSession } from "@/features/notes/utils/note-editor-session";
export interface NoteEditorGeometryTargets {
  noteId: number;
  editor: View | null;
  actions: View | null;
  requestId: number;
  getRequestId: () => number;
  input: TextInput | null;
  caretMetricsAvailable: boolean;
  readCaretMetrics: () => Promise<NoteEditorCaretMetrics | null>;
}
export interface NoteEditorGeometryMetrics {
  length: number;
  lineCount: number;
  heightBucket: number;
  selectionAtEnd: boolean;
  contentRevision: number;
  selectionStart: number | null;
  selectionEnd: number | null;
}
interface NoteCardProps {
  note: Note & { clientMutationId: string };
  editorSession: NoteEditorSession;
  recoveryDraft?: {
    sequence: number;
    text: string;
  } | null;
  onSave: (id: number, text: string) => boolean;
  onDelete: (id: number) => void;
  onEditingChange?: (
    id: number,
    editing: boolean,
    saveDraft?: () => boolean,
    owner?: NoteEditorRowOwner,
  ) => boolean | void;
  onEditorUnmount?: (id: number, clientMutationId: string, owner: NoteEditorRowOwner) => void;
  onEditorReady?: (
    id: number,
    target: View | null,
    phase: "focus" | "layout",
  ) => void;
  onEditorGeometry?: (
    requestId: number,
    targets: NoteEditorGeometryTargets,
    metrics: NoteEditorGeometryMetrics,
  ) => void;
}
const CARD_RADIUS = radii.listCard;
const CARD_BOTTOM_GAP = 11.5;
const NOTE_LINE_HEIGHT = 20;
const NOTE_TEXT_STYLE = {
  fontSize: 14,
  lineHeight: NOTE_LINE_HEIGHT,
  fontWeight: "400" as const,
};
const ACTION_LABEL_STYLE = {
  fontSize: 13,
  lineHeight: 18,
  fontWeight: "400" as const,
};
let nextNoteEditorGeometryRequestId = 1;
function allocateNoteEditorGeometryRequestId(): number {
  const requestId = nextNoteEditorGeometryRequestId;
  nextNoteEditorGeometryRequestId += 1;
  return requestId;
}
// Card-style note with date and actions inside.
function NoteCardComponent({
  note,
  editorSession,
  recoveryDraft,
  onSave,
  onDelete,
  onEditingChange,
  onEditorUnmount,
  onEditorReady,
  onEditorGeometry,
}: NoteCardProps) {
  const { t } = useTranslation();
  const editorOwner = useRef<NoteEditorRowOwner>({ live: false }).current;
  useLayoutEffect(() => {
    editorOwner.live = true;
    return () => { editorOwner.live = false; };
  }, [editorOwner]);
  const initialDraft = useRef(editorSession.getDraft(note.clientMutationId)).current;
  const initialText = initialDraft?.text ?? note.text;
  const initialHeight = initialDraft?.viewportHeight ?? NOTE_LINE_HEIGHT;
  const [editing, setEditing] = useState(initialDraft != null);
  const [editorInitialText, setEditorInitialText] = useState(initialText);
  const [hasDraftText, setHasDraftText] = useState(initialText.trim().length > 0);
  const hasDraftTextRef = useRef(initialText.trim().length > 0);
  const [editorViewportHeight, setEditorViewportHeight] =
    useState(initialHeight);
  const editorViewportHeightRef = useRef(initialHeight);
  const cardRef = useRef<View>(null);
  const inputRef = useRef<TextInput>(null);
  const editorViewportRef = useRef<View>(null);
  const actionsRef = useRef<View>(null);
  const draftTextRef = useRef(initialText);
  const editorSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const contentRevisionRef = useRef(0);
  const nativeEventCountRef = useRef(0);
  const pendingNativeTextRef = useRef<string | null>(null);
  const initialEndSelectionPendingRef = useRef(false);
  const editorStartsAtEndRef = useRef(false);
  const draftBaseTextRef = useRef(initialDraft?.baseText ?? note.text);
  const editingRef = useRef(initialDraft != null);
  const previousEditingRef = useRef(false);
  const focusFrameRef = useRef<number | null>(null);
  const readTextLayoutHeightRef = useRef(NOTE_LINE_HEIGHT);
  const onEditorUnmountRef = useRef(onEditorUnmount);
  onEditorUnmountRef.current = onEditorUnmount;
  const pendingGeometryRef = useRef<{
    requestId: number;
    metrics: NoteEditorGeometryMetrics;
  } | null>(null);
  const geometryFrameRef = useRef<number | null>(null);
  const lastEditMayShrinkRef = useRef(true);
  const latestGeometryRequestIdRef = useRef(0);
  const renderedNoteTextRef = useRef(note.text);
  const appliedRecoverySequenceRef = useRef(initialDraft?.recoverySequence ?? 0);
  const updateDraftAvailability = React.useCallback((text: string) => {
    const next = text.trim().length > 0;
    if (hasDraftTextRef.current === next) return;
    hasDraftTextRef.current = next;
    setHasDraftText(next);
  }, []);
  const cancelGeometryFrame = React.useCallback(() => {
    if (geometryFrameRef.current == null) return;
    cancelAnimationFrame(geometryFrameRef.current);
    geometryFrameRef.current = null;
  }, []);
  const getEditorMetrics = React.useCallback(
    (height = editorViewportHeightRef.current): NoteEditorGeometryMetrics => ({
      length: draftTextRef.current.length,
      lineCount: draftTextRef.current.split(/\r\n|\r|\n/).length,
      heightBucket: Math.round(height / 8) * 8,
      selectionAtEnd:
        editorSelectionRef.current?.start === draftTextRef.current.length &&
        editorSelectionRef.current?.end === draftTextRef.current.length,
      contentRevision: contentRevisionRef.current,
      selectionStart: editorSelectionRef.current?.start ?? null,
      selectionEnd: editorSelectionRef.current?.end ?? null,
    }),
    [],
  );
  const queueEditorGeometry = React.useCallback(
    (height = editorViewportHeightRef.current) => {
      cancelGeometryFrame();
      const requestId = allocateNoteEditorGeometryRequestId();
      latestGeometryRequestIdRef.current = requestId;
      pendingGeometryRef.current = {
        requestId,
        metrics: getEditorMetrics(height),
      };
    },
    [cancelGeometryFrame, getEditorMetrics],
  );
  const publishEditorGeometry = React.useCallback(() => {
    if (!editorOwner.live) return;
    const pending = pendingGeometryRef.current;
    if (!pending) return;
    pendingGeometryRef.current = null;
    onEditorGeometry?.(
      pending.requestId,
      {
        noteId: note.id,
        editor: editorViewportRef.current,
        actions: actionsRef.current,
        requestId: pending.requestId,
        getRequestId: () => latestGeometryRequestIdRef.current,
        input: inputRef.current,
        caretMetricsAvailable: hasNoteEditorCaretMetrics,
        readCaretMetrics: async () => {
          const input = inputRef.current;
          if (!input || !editorOwner.live || !editingRef.current) return null;
          const tag = findNodeHandle(input);
          if (tag == null) return null;
          const result = await readNoteEditorCaretMetrics(
            tag, nativeEventCountRef.current, pendingNativeTextRef.current,
          );
          if (
            !result || !editorOwner.live || !editingRef.current || inputRef.current !== input ||
            latestGeometryRequestIdRef.current !== pending.requestId ||
            contentRevisionRef.current !== pending.metrics.contentRevision ||
            result.textLength !== pending.metrics.length ||
            (pending.metrics.selectionStart != null &&
              result.selectionStart !== pending.metrics.selectionStart) ||
            (pending.metrics.selectionEnd != null &&
              result.selectionEnd !== pending.metrics.selectionEnd) ||
            (Platform.OS === "android" && result.bottom > editorViewportHeightRef.current + 0.5)
          ) return null;
          pendingNativeTextRef.current = null;
          return result;
        },
      },
      pending.metrics,
    );
  }, [editorOwner, note.id, onEditorGeometry]);
  const language = useVisualLanguage();
  const accent = getAccentScheme(useVisualColorScheme()).base;
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const cardBackgroundColor = isDark ? "#1B1B1B" : lightTheme.surfaceElevated;
  const metaTextColor = isDark ? "#A3A3A3" : "#6F6F6F";
  const dateLabel = formatLocalizedDate(note.date, language);
  const reasonType =
    note.reasonType ?? (note.isFailureReason ? "failure" : null);
  const reasonLabel =
    reasonType === "failure"
      ? t("calendarDayMenu.failure")
      : reasonType === "skipped"
        ? t("calendarDayMenu.skip")
        : null;
  useLayoutEffect(() => {
    renderedNoteTextRef.current = note.text;
    // The uncontrolled native editor mirrors the route-owned draft. A
    // persistence rollback may replace
    // note.text with an older value, but it must never silently replace the
    // value that the user can still see and save.
    if (editingRef.current) return;
    draftTextRef.current = note.text;
    draftBaseTextRef.current = note.text;
    updateDraftAvailability(note.text);
  }, [note.text, updateDraftAvailability]);
  useEffect(() => {
    if (!editing) return;
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (!editorOwner.live || !editingRef.current) return;
      if (!inputRef.current?.isFocused()) inputRef.current?.focus();
    });
    return () => {
      if (focusFrameRef.current == null) return;
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    };
  }, [editing, editorOwner]);
  useEffect(() => {
    return () => {
      if (editingRef.current) {
        onEditorUnmountRef.current?.(note.id, note.clientMutationId, editorOwner);
      }
    };
  }, [editorOwner, note.clientMutationId, note.id]);
  const leaveEditing = React.useCallback((dismissFocus = false) => {
    if (!editorOwner.live) return;
    if (!editingRef.current) return;
    editingRef.current = false;
    initialEndSelectionPendingRef.current = false;
    if (focusFrameRef.current != null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = null;
    if (dismissFocus) inputRef.current?.blur();
    editorSession.finish(note.clientMutationId);
    onEditingChange?.(note.id, false, undefined, editorOwner);
    setEditing(false);
  }, [editorOwner, editorSession, note.clientMutationId, note.id, onEditingChange]);
  const saveForEditorHandoff = React.useCallback((dismissFocus = false) => {
    if (!editingRef.current) return true;
    const trimmed = draftTextRef.current.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return false;
    }
    if (trimmed !== renderedNoteTextRef.current) {
      if (!onSave(note.id, trimmed)) {
        inputRef.current?.focus();
        return false;
      }
    }
    leaveEditing(dismissFocus);
    return true;
  }, [leaveEditing, note.id, onSave]);
  const enterEditing = React.useCallback(
    (initialDraft = note.text, placeCursorAtEnd = false) => {
      if (!editorOwner.live) return;
      if (editingRef.current) return;
      const accepted = onEditingChange?.(note.id, true, saveForEditorHandoff, editorOwner);
      if (accepted === false) {
        return;
      }
      // Keep the native input's initial value stable until it unmounts. The
      // live draft is read separately by Save/handoff and recovery commands.
      setEditorInitialText(initialDraft);
      draftTextRef.current = initialDraft;
      updateDraftAvailability(initialDraft);
      contentRevisionRef.current += 1;
      nativeEventCountRef.current = 0;
      pendingNativeTextRef.current = null;
      editorSelectionRef.current = null;
      initialEndSelectionPendingRef.current = placeCursorAtEnd;
      editorStartsAtEndRef.current = placeCursorAtEnd;
      draftBaseTextRef.current = initialDraft;
      lastEditMayShrinkRef.current = true;
      pendingGeometryRef.current = null;
      cancelGeometryFrame();
      editingRef.current = true;
      editorViewportHeightRef.current = readTextLayoutHeightRef.current;
      setEditorViewportHeight(readTextLayoutHeightRef.current);
      editorSession.begin({
        clientMutationId: note.clientMutationId,
        noteId: note.id,
        text: initialDraft,
        baseText: initialDraft,
        recoverySequence: appliedRecoverySequenceRef.current,
        viewportHeight: readTextLayoutHeightRef.current,
      });
      // Notify the screen in the same tap batch so the composer is visually
      // collapsed as this editor mounts. The composer remains mounted until the
      // native focus transfer completes; unmounting the old Android focus owner
      // here can close and immediately reopen the keyboard.
      setEditing(true);
    },
    [
      cancelGeometryFrame,
      editorOwner,
      editorSession,
      note.clientMutationId,
      note.id,
      note.text,
      onEditingChange,
      saveForEditorHandoff,
      updateDraftAvailability,
    ],
  );
  useLayoutEffect(() => {
    if (initialDraft == null || !editingRef.current) return;
    onEditingChange?.(note.id, true, saveForEditorHandoff, editorOwner);
  }, [editorOwner, initialDraft, note.id, onEditingChange, saveForEditorHandoff]);
  useEffect(
    () => () => {
      cancelGeometryFrame();
      pendingGeometryRef.current = null;
    },
    [cancelGeometryFrame],
  );
  useLayoutEffect(() => {
    if (
      !recoveryDraft ||
      recoveryDraft.sequence <= appliedRecoverySequenceRef.current
    ) {
      return;
    }
    appliedRecoverySequenceRef.current = recoveryDraft.sequence;
    const nextDraft = mergeRecoveredDraft(
      recoveryDraft.text,
      draftTextRef.current,
      note.text,
      draftBaseTextRef.current,
    );
    const previousDraft = draftTextRef.current;
    lastEditMayShrinkRef.current =
      nextDraft.length < previousDraft.length ||
      nextDraft.split(/\r\n|\r|\n/).length <
        previousDraft.split(/\r\n|\r|\n/).length;
    draftTextRef.current = nextDraft;
    updateDraftAvailability(nextDraft);
    contentRevisionRef.current += 1;
    editorSelectionRef.current = null;
    editorSession.update(note.clientMutationId, {
      text: nextDraft,
      recoverySequence: recoveryDraft.sequence,
    });
    if (editingRef.current) {
      pendingNativeTextRef.current = nextDraft;
      queueEditorGeometry(editorViewportHeightRef.current);
      inputRef.current?.setNativeProps({ text: nextDraft });
      inputRef.current?.focus();
      geometryFrameRef.current = requestAnimationFrame(() => {
        geometryFrameRef.current = null;
        if (!editorOwner.live || !editingRef.current) return;
        publishEditorGeometry();
      });
      return;
    }
    enterEditing(nextDraft);
  }, [editorOwner, editorSession, enterEditing, note.clientMutationId, note.text, publishEditorGeometry, queueEditorGeometry, recoveryDraft, updateDraftAvailability]);
  const handleEditorFocus = () => {
    if (!editorOwner.live || !editingRef.current) return;
    if (initialEndSelectionPendingRef.current && inputRef.current != null) {
      initialEndSelectionPendingRef.current = false;
      const end = draftTextRef.current.length;
      const input = inputRef.current as TextInput & {
        setSelectionRange?: (start: number, end: number) => void;
      };
      const setSelection = typeof input.setSelection === "function"
        ? input.setSelection
        : input.setSelectionRange;
      if (typeof setSelection === "function") {
        setSelection.call(input, end, end);
        editorSelectionRef.current = { start: end, end };
      }
    }
    onEditorReady?.(note.id, cardRef.current, "focus");
    queueEditorGeometry(editorViewportHeightRef.current);
    publishEditorGeometry();
  };
  const handleEditorPressIn = () => {
    if (!editorOwner.live || !editingRef.current) return;
    initialEndSelectionPendingRef.current = false;
    editorSelectionRef.current = null;
    queueEditorGeometry();
    publishEditorGeometry();
  };
  const handleEditorBlur = () => {
    if (!editorOwner.live || !editingRef.current) return;
    initialEndSelectionPendingRef.current = false;
    editorSelectionRef.current = null;
    queueEditorGeometry();
    publishEditorGeometry();
  };
  const handleEditorSelectionChange = (selection: { start: number; end: number }) => {
    if (!editorOwner.live || !editingRef.current) return;
    const previous = editorSelectionRef.current;
    const next =
      Number.isInteger(selection.start) && Number.isInteger(selection.end) &&
      selection.start >= 0 && selection.end >= selection.start
        ? { start: selection.start, end: selection.end }
        : null;
    editorSelectionRef.current = next;
    if (previous?.start === next?.start && previous?.end === next?.end) return;
    queueEditorGeometry();
    publishEditorGeometry();
  };
  useLayoutEffect(() => {
    if (editing) {
      onEditorReady?.(note.id, cardRef.current, "layout");
      if (!pendingGeometryRef.current) {
        queueEditorGeometry(editorViewportHeightRef.current);
      }
      publishEditorGeometry();
    } else if (previousEditingRef.current) {
      cancelGeometryFrame();
      pendingGeometryRef.current = null;
    }
    previousEditingRef.current = editing;
  }, [
    editing,
    editorViewportHeight,
    note.id,
    onEditorReady,
    cancelGeometryFrame,
    publishEditorGeometry,
    queueEditorGeometry,
  ]);
  const handleEditPress = () => {
    if (!editorOwner.live) return;
    if (editing) {
      saveForEditorHandoff(true);
      return;
    }
    enterEditing(note.text, true);
  };
  const handleTextChange = (value: string, eventCount: number) => {
    if (!editorOwner.live || !editingRef.current) return;
    const previousValue = draftTextRef.current;
    const previousSelection = editorSelectionRef.current;
    if (
      previousSelection?.start === previousValue.length &&
      previousSelection?.end === previousValue.length
    ) {
      editorSelectionRef.current = { start: value.length, end: value.length };
    }
    lastEditMayShrinkRef.current =
      value.length < previousValue.length ||
      value.split(/\r\n|\r|\n/).length <
        previousValue.split(/\r\n|\r|\n/).length;
    draftTextRef.current = value;
    updateDraftAvailability(value);
    contentRevisionRef.current += 1;
    nativeEventCountRef.current = eventCount;
    pendingNativeTextRef.current = null;
    editorSession.update(note.clientMutationId, { text: value });
    queueEditorGeometry(editorViewportHeightRef.current);
    geometryFrameRef.current = requestAnimationFrame(() => {
      geometryFrameRef.current = null;
      if (!editingRef.current) return;
      publishEditorGeometry();
    });
  };
  const handleReadTextLayout = (event: LayoutChangeEvent) => {
    readTextLayoutHeightRef.current = Math.max(
      NOTE_LINE_HEIGHT,
      Math.ceil(event.nativeEvent.layout.height),
    );
  };
  const handleEditorContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    if (!editorOwner.live) return;
    const nativeHeight = event.nativeEvent.contentSize.height;
    const currentHeight = editorViewportHeightRef.current;
    const nextHeight = getNoteEditorContentHeight({
      nativeHeight,
      currentHeight,
      minimumHeight: NOTE_LINE_HEIGHT,
      mayShrink: lastEditMayShrinkRef.current,
    });
    if (nextHeight == null) return;
    editorSession.update(note.clientMutationId, { viewportHeight: nextHeight });
    if (nextHeight < currentHeight - 0.5) {
      lastEditMayShrinkRef.current = false;
    }
    // Editor visibility follows the latest measured native text height.
    queueEditorGeometry(nextHeight);
    if (Platform.OS !== "android") {
      editorViewportHeightRef.current = nextHeight;
      onEditorReady?.(note.id, cardRef.current, "layout");
      publishEditorGeometry();
      return;
    }
    if (currentHeight !== nextHeight) {
      editorViewportHeightRef.current = nextHeight;
      setEditorViewportHeight(nextHeight);
      return;
    }
    publishEditorGeometry();
  };
  const handleEditorLayout = () => {
    if (!editorOwner.live) return;
    if (!editingRef.current) return;
    if (!pendingGeometryRef.current) {
      queueEditorGeometry(editorViewportHeightRef.current);
    }
    publishEditorGeometry();
  };
  return (
    <View
      ref={cardRef}
      collapsable={false}
      style={{ paddingHorizontal: 11, marginBottom: CARD_BOTTOM_GAP }}
    >
      <View
        style={
          reasonType === "failure"
            ? {
                borderWidth: 0.75,
                borderColor: semantic.failure,
                borderRadius: CARD_RADIUS,
              }
            : null
        }
      >
        <View
          className="p-md"
          style={{
            backgroundColor: cardBackgroundColor,
            borderRadius:
              reasonType === "failure" ? CARD_RADIUS - 0.75 : CARD_RADIUS,
          }}
        >
          <View
            className="flex-row items-start justify-between"
            style={{ marginBottom: 8 }}
          >
            <Text style={{ color: metaTextColor, fontSize: 12, flexShrink: 1 }}>
              {dateLabel}
            </Text>
            {reasonLabel ? (
              <Text
                style={{
                  marginLeft: 10,
                  color: metaTextColor,
                  fontSize: 11,
                }}
              >
                {reasonLabel}
              </Text>
            ) : null}
          </View>

          {editing ? (
            <View
              ref={editorViewportRef}
              collapsable={false}
              onLayout={handleEditorLayout}
              style={
                Platform.OS === "android"
                  ? { height: editorViewportHeight, overflow: "hidden" }
                  : null
              }
            >
              <TextInput
                ref={inputRef}
                nativeID={`${editorStartsAtEndRef.current ? "note-editor-end:" : "note-editor:"}${note.clientMutationId}`}
                defaultValue={editorInitialText}
                selectionColor={accent}
                cursorColor={accent}
                onChange={(event) => handleTextChange(event.nativeEvent.text, event.nativeEvent.eventCount)}
                multiline
                autoFocus
                className="text-primary"
                style={[
                  NOTE_TEXT_STYLE,
                  {
                    minHeight: NOTE_LINE_HEIGHT,
                    paddingHorizontal: 0,
                    paddingVertical: 0,
                  },
                  Platform.OS === "android"
                    ? { height: editorViewportHeight + NOTE_LINE_HEIGHT }
                    : null,
                ]}
                textAlignVertical="top"
                blurOnSubmit={false}
                scrollEnabled={false}
                underlineColorAndroid="transparent"
                onFocus={handleEditorFocus}
                onPressIn={handleEditorPressIn}
                onBlur={handleEditorBlur}
                onSelectionChange={(event) =>
                  handleEditorSelectionChange(event.nativeEvent.selection)
                }
                onContentSizeChange={handleEditorContentSizeChange}
              />
            </View>
          ) : (
            <Text
              className="text-primary"
              style={NOTE_TEXT_STYLE}
              onLayout={handleReadTextLayout}
            >
              {note.text}
            </Text>
          )}

          <View
            ref={actionsRef}
            nativeID={`note-editor-actions:${note.clientMutationId}`}
            collapsable={false}
            onLayout={handleEditorLayout}
            className="flex-row justify-end mt-sm"
            style={{ marginRight: 0 }}
          >
            <Pressable
              onPress={() => {
                if (!editorOwner.live) return;
                onDelete(note.id);
              }}
              accessibilityRole="button"
              accessibilityLabel={t("notes.delete")}
              className="min-h-[32px] min-w-[48px] items-center justify-center px-sm py-xs mr-xs active:opacity-60"
            >
              <Text className="text-destructive" style={ACTION_LABEL_STYLE}>
                {t("notes.delete")}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleEditPress}
              disabled={editing && !hasDraftText}
              accessibilityRole="button"
              accessibilityLabel={editing ? t("common.save") : t("notes.edit")}
              accessibilityState={{ disabled: editing && !hasDraftText }}
              className={`min-h-[32px] min-w-[48px] items-center justify-center pl-sm py-xs ${
                editing && !hasDraftText ? "opacity-[0.45]" : "active:opacity-60"
              }`}
              style={{ paddingRight: 0 }}
            >
              <Text className="text-primary" style={ACTION_LABEL_STYLE}>
                {editing ? t("common.save") : t("notes.edit")}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
export const NoteCard = React.memo(NoteCardComponent);
