/** @jsxImportSource nativewind */
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  Platform,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import { lightTheme, semantic } from "@/theme/colors";
import {
  useVisualLanguage,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import type { Note } from "@/types/note";
import { formatLocalizedDate } from "@/utils/date";
import { radii } from "@/theme/tokens";
import { mergeRecoveredDraft } from "@/utils/recovered-draft";
import { getNoteEditorContentHeight } from "@/features/notes/utils/editor-visibility";
export interface NoteEditorGeometryTargets {
  noteId: number;
  editor: View | null;
  actions: View | null;
  requestId: number;
  getRequestId: () => number;
}
export interface NoteEditorGeometryMetrics {
  length: number;
  lineCount: number;
  heightBucket: number;
}
interface NoteCardProps {
  note: Note;
  recoveryDraft?: {
    sequence: number;
    text: string;
  } | null;
  onSave: (id: number, text: string) => boolean;
  onUnchangedSave?: (id: number) => void;
  onDelete: (id: number) => void;
  onEditingChange?: (
    id: number,
    editing: boolean,
    saveDraft?: () => boolean,
  ) => boolean | void;
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
  recoveryDraft,
  onSave,
  onUnchangedSave,
  onDelete,
  onEditingChange,
  onEditorReady,
  onEditorGeometry,
}: NoteCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [hasDraftText, setHasDraftText] = useState(note.text.trim().length > 0);
  const [editorViewportHeight, setEditorViewportHeight] =
    useState(NOTE_LINE_HEIGHT);
  const editorViewportHeightRef = useRef(NOTE_LINE_HEIGHT);
  const cardRef = useRef<View>(null);
  const inputRef = useRef<TextInput>(null);
  const editorViewportRef = useRef<View>(null);
  const actionsRef = useRef<View>(null);
  const draftTextRef = useRef(note.text);
  const draftBaseTextRef = useRef(note.text);
  const hasDraftTextRef = useRef(note.text.trim().length > 0);
  const editingRef = useRef(false);
  const previousEditingRef = useRef(false);
  const focusFrameRef = useRef<number | null>(null);
  const readTextLayoutHeightRef = useRef(NOTE_LINE_HEIGHT);
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;
  const pendingGeometryRef = useRef<{
    requestId: number;
    metrics: NoteEditorGeometryMetrics;
  } | null>(null);
  const geometryFrameRef = useRef<number | null>(null);
  const lastEditMayShrinkRef = useRef(true);
  const latestGeometryRequestIdRef = useRef(0);
  const renderedNoteTextRef = useRef(note.text);
  const appliedRecoverySequenceRef = useRef(0);
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
      },
      pending.metrics,
    );
  }, [note.id, onEditorGeometry]);
  const language = useVisualLanguage();
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
    // While the uncontrolled native editor is mounted, its visible text is
    // the sole draft owner. An optimistic persistence rollback may replace
    // note.text with an older value, but it must never silently replace the
    // value that the user can still see and save.
    if (editingRef.current) return;
    draftTextRef.current = note.text;
    draftBaseTextRef.current = note.text;
    const nextHasDraftText = note.text.trim().length > 0;
    hasDraftTextRef.current = nextHasDraftText;
    setHasDraftText(nextHasDraftText);
  }, [note.text]);
  useEffect(() => {
    if (!editing) return;
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (!inputRef.current?.isFocused()) inputRef.current?.focus();
    });
    return () => {
      if (focusFrameRef.current == null) return;
      cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    };
  }, [editing]);
  useEffect(() => {
    return () => {
      if (editingRef.current) onEditingChangeRef.current?.(note.id, false);
    };
  }, [note.id]);
  const leaveEditing = React.useCallback(() => {
    if (!editingRef.current) return;
    editingRef.current = false;
    onEditingChange?.(note.id, false);
    setEditing(false);
  }, [note.id, onEditingChange]);
  const saveForEditorHandoff = React.useCallback(() => {
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
    leaveEditing();
    return true;
  }, [leaveEditing, note.id, onSave]);
  const enterEditing = React.useCallback(
    (initialDraft = note.text) => {
      if (editingRef.current) return;
      const accepted = onEditingChange?.(note.id, true, saveForEditorHandoff);
      if (accepted === false) {
        return;
      }
      // Initialize synchronously before mounting TextInput. defaultValue is read
      // only on that mount and must agree with the ref used by Save/handoff.
      draftTextRef.current = initialDraft;
      draftBaseTextRef.current = initialDraft;
      lastEditMayShrinkRef.current = true;
      pendingGeometryRef.current = null;
      cancelGeometryFrame();
      const nextHasDraftText = draftTextRef.current.trim().length > 0;
      hasDraftTextRef.current = nextHasDraftText;
      setHasDraftText(nextHasDraftText);
      editingRef.current = true;
      editorViewportHeightRef.current = readTextLayoutHeightRef.current;
      setEditorViewportHeight(readTextLayoutHeightRef.current);
      // Notify the screen in the same tap batch so the composer is visually
      // collapsed as this editor mounts. The composer remains mounted until the
      // native focus transfer completes; unmounting the old Android focus owner
      // here can close and immediately reopen the keyboard.
      setEditing(true);
    },
    [
      cancelGeometryFrame,
      note.id,
      note.text,
      onEditingChange,
      saveForEditorHandoff,
    ],
  );
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
    const nextHasDraftText = nextDraft.trim().length > 0;
    hasDraftTextRef.current = nextHasDraftText;
    setHasDraftText(nextHasDraftText);
    if (editingRef.current) {
      inputRef.current?.setNativeProps({ text: nextDraft });
      inputRef.current?.focus();
      return;
    }
    enterEditing(nextDraft);
  }, [enterEditing, note.text, recoveryDraft]);
  const handleEditorFocus = () => {
    onEditorReady?.(note.id, cardRef.current, "focus");
    queueEditorGeometry(editorViewportHeightRef.current);
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
  const handleSave = () => {
    const trimmed = draftTextRef.current.trim();
    if (!trimmed) return;
    if (trimmed === renderedNoteTextRef.current) {
      onUnchangedSave?.(note.id);
      leaveEditing();
      return;
    }
    const saved = onSave(note.id, trimmed);
    if (saved) {
      leaveEditing();
    }
  };
  const handleEditPress = () => {
    if (editing) {
      handleSave();
      return;
    }
    enterEditing();
  };
  const handleTextChange = (value: string) => {
    const previousValue = draftTextRef.current;
    lastEditMayShrinkRef.current =
      value.length < previousValue.length ||
      value.split(/\r\n|\r|\n/).length <
        previousValue.split(/\r\n|\r|\n/).length;
    draftTextRef.current = value;
    cancelGeometryFrame();
    geometryFrameRef.current = requestAnimationFrame(() => {
      geometryFrameRef.current = null;
      if (!editingRef.current) return;
      queueEditorGeometry(editorViewportHeightRef.current);
      publishEditorGeometry();
    });
    const nextHasDraftText = value.trim().length > 0;
    if (nextHasDraftText === hasDraftTextRef.current) return;
    hasDraftTextRef.current = nextHasDraftText;
    setHasDraftText(nextHasDraftText);
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
    const nativeHeight = event.nativeEvent.contentSize.height;
    const currentHeight = editorViewportHeightRef.current;
    const nextHeight = getNoteEditorContentHeight({
      nativeHeight,
      currentHeight,
      minimumHeight: NOTE_LINE_HEIGHT,
      mayShrink: lastEditMayShrinkRef.current,
    });
    if (nextHeight == null) return;
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
              onLayout={handleEditorLayout}
              style={
                Platform.OS === "android"
                  ? { height: editorViewportHeight, overflow: "hidden" }
                  : null
              }
            >
              <TextInput
                ref={inputRef}
                defaultValue={draftTextRef.current}
                onChange={(event) => handleTextChange(event.nativeEvent.text)}
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
            onLayout={handleEditorLayout}
            className="flex-row justify-end mt-sm"
            style={{ marginRight: 0 }}
          >
            <Pressable
              onPress={() => {
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
              className={`min-h-[32px] min-w-[48px] items-center justify-center pl-sm py-xs ${
                editing && !hasDraftText
                  ? "opacity-[0.45]"
                  : "active:opacity-60"
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
