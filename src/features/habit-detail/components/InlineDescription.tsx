/** @jsxImportSource nativewind */
import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
} from "react";
import { View, Text, TextInput, Keyboard, PanResponder } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useTranslation } from "react-i18next";
import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
import { lightTheme } from "@/theme/colors";
import {
  persistDescriptionVisibleLines,
  readPersistedDescriptionVisibleLines,
} from "@/composition/settings";
import {
  DESCRIPTION_LINES_MAX,
  DESCRIPTION_LINES_MIN,
  clampDescriptionVisibleLines,
} from "@/application/settings/habit-description-lines-setting";
import { mergeRecoveredDraft } from "@/utils/recovered-draft";
interface InlineDescriptionProps {
  habitId: number;
  description: string | null;
  visible: boolean;
  onSave: (text: string) => boolean;
  onEditingChange?: (editing: boolean) => void;
  registerSaveHandler?: (handler: (() => void) | null) => void;
  editable?: boolean;
  recoveryDraft?: {
    sequence: number;
    text: string;
  } | null;
}
const INPUT_LINE_HEIGHT = 22;
const INPUT_VERTICAL_PADDING = 10;
const INPUT_HORIZONTAL_PADDING = 12;
const MIN_VISIBLE_LINES = DESCRIPTION_LINES_MIN;
const MAX_VISIBLE_LINES = DESCRIPTION_LINES_MAX;
const INPUT_MIN_HEIGHT = 44;
function clampVisibleLines(lines: number): number {
  return clampDescriptionVisibleLines(lines);
}
function linesToHeight(lines: number): number {
  const raw = lines * INPUT_LINE_HEIGHT + INPUT_VERTICAL_PADDING * 2;
  return Math.max(INPUT_MIN_HEIGHT, Math.round(raw));
}
function clampHeight(height: number): number {
  const min = linesToHeight(MIN_VISIBLE_LINES);
  const max = linesToHeight(MAX_VISIBLE_LINES);
  return Math.max(min, Math.min(max, height));
}
function heightToLines(height: number): number {
  const contentHeight = Math.max(0, height - INPUT_VERTICAL_PADDING * 2);
  const raw = contentHeight / INPUT_LINE_HEIGHT;
  return clampVisibleLines(raw);
}
// Description block with Edit/Save action and draggable size handle.
export const InlineDescription = React.memo(function InlineDescription({
  habitId,
  description,
  visible,
  onSave,
  onEditingChange,
  registerSaveHandler,
  editable = true,
  recoveryDraft = null,
}: InlineDescriptionProps) {
  const { t } = useTranslation();
  const effectiveMode = useVisualEffectiveMode();
  const isDark = effectiveMode === "dark";
  const cardBackgroundColor = isDark ? "#262626" : lightTheme.surfaceElevated;
  const cardBorderColor = isDark ? "#5F5F5F" : lightTheme.border;
  const sectionHeaderBackgroundColor = isDark ? "#2F2F2F" : lightTheme.surface;
  const sectionDividerColor = isDark ? "#6B6B6B" : lightTheme.divider;
  const sectionTitleColor = isDark ? "#D8D8D8" : lightTheme.muted;
  const controlBorderColor = isDark ? "#666666" : lightTheme.border;
  const controlBackgroundColor = isDark ? "#383838" : lightTheme.pressHighlight;
  const initialVisibleLinesRef = useRef<number | null>(null);
  if (initialVisibleLinesRef.current == null) {
    initialVisibleLinesRef.current =
      readPersistedDescriptionVisibleLines(habitId);
  }
  const initialVisibleLines = initialVisibleLinesRef.current;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(description ?? "");
  const [, setVisibleLines] = useState(initialVisibleLines);
  const [inputHeight, setInputHeight] = useState(
    linesToHeight(initialVisibleLines),
  );
  const descriptionInputRef = useRef<TextInput>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const draftBaseTextRef = useRef(description ?? "");
  const appliedRecoverySequenceRef = useRef(0);
  const recoveryFocusFrameRef = useRef<number | null>(null);
  const dragStartHeightRef = useRef(linesToHeight(initialVisibleLines));
  const inputHeightRef = useRef(linesToHeight(initialVisibleLines));
  const resizeGestureActiveRef = useRef(false);
  useLayoutEffect(() => {
    // Once the native editor owns a draft, a late optimistic acknowledgement
    // or rollback must not replace newer typing. Recovery below reconciles the
    // confirmed value with that draft using its exact provenance.
    if (editing) return;
    const nextText = description ?? "";
    textRef.current = nextText;
    draftBaseTextRef.current = nextText;
    setText(nextText);
  }, [description, editing]);
  useLayoutEffect(() => {
    if (
      !recoveryDraft ||
      recoveryDraft.sequence <= appliedRecoverySequenceRef.current
    ) {
      return;
    }
    appliedRecoverySequenceRef.current = recoveryDraft.sequence;
    const nextText = mergeRecoveredDraft(
      recoveryDraft.text,
      textRef.current,
      description ?? "",
      draftBaseTextRef.current,
    );
    textRef.current = nextText;
    setText(nextText);
    setEditing(true);
    onEditingChange?.(true);
    if (recoveryFocusFrameRef.current != null) {
      cancelAnimationFrame(recoveryFocusFrameRef.current);
    }
    recoveryFocusFrameRef.current = requestAnimationFrame(() => {
      recoveryFocusFrameRef.current = null;
      descriptionInputRef.current?.focus();
    });
  }, [description, onEditingChange, recoveryDraft]);
  useEffect(() => {
    inputHeightRef.current = inputHeight;
  }, [inputHeight]);
  useEffect(() => {
    const stored = readPersistedDescriptionVisibleLines(habitId);
    const storedHeight = linesToHeight(stored);
    setVisibleLines(stored);
    setInputHeight(storedHeight);
    inputHeightRef.current = storedHeight;
    dragStartHeightRef.current = storedHeight;
  }, [habitId]);
  const handleSave = useCallback(() => {
    if (!editable) return;
    if (text === (description ?? "")) {
      Keyboard.dismiss();
      setEditing(false);
      onEditingChange?.(false);
      return;
    }
    Keyboard.dismiss();
    setEditing(false);
    onEditingChange?.(false);
    const saved = onSave(text);
    if (saved === false) {
      setEditing(true);
      onEditingChange?.(true);
    }
  }, [description, editable, onEditingChange, onSave, text]);
  const handleInputFocus = () => {
    if (!editable || editing) return;
    draftBaseTextRef.current = textRef.current;
    setEditing(true);
    onEditingChange?.(true);
  };
  const handleTextChange = (value: string) => {
    setText(value);
  };
  const applyDraggedHeight = (dy: number) => {
    // Follow finger smoothly: drag down grows, drag up shrinks.
    const nextHeight = clampHeight(dragStartHeightRef.current + dy);
    setInputHeight((prev) =>
      Math.abs(prev - nextHeight) < 0.5 ? prev : nextHeight,
    );
  };
  const finishDraggedHeight = useCallback(() => {
    if (!resizeGestureActiveRef.current) return;
    resizeGestureActiveRef.current = false;
    const snappedLines = heightToLines(inputHeightRef.current);
    const snappedHeight = linesToHeight(snappedLines);
    setVisibleLines(snappedLines);
    setInputHeight(snappedHeight);
    inputHeightRef.current = snappedHeight;
    dragStartHeightRef.current = snappedHeight;
    void persistDescriptionVisibleLines(habitId, snappedLines).then(
      (result) => {
        if (result.status !== "failed" || !result.isLatest) return;
        const rollbackLines = result.confirmedValue;
        const rollbackHeight = linesToHeight(rollbackLines);
        setVisibleLines(rollbackLines);
        setInputHeight(rollbackHeight);
        inputHeightRef.current = rollbackHeight;
        dragStartHeightRef.current = rollbackHeight;
        console.error("Failed to save description height", result.error);
      },
    );
  }, [habitId]);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => editable,
        onMoveShouldSetPanResponder: (_, gestureState) =>
          editable && Math.abs(gestureState.dy) > 1,
        onPanResponderGrant: () => {
          if (!editable) return;
          resizeGestureActiveRef.current = true;
          dragStartHeightRef.current = inputHeightRef.current;
        },
        onPanResponderMove: (_, gestureState) => {
          if (!editable) return;
          applyDraggedHeight(gestureState.dy);
        },
        onPanResponderRelease: finishDraggedHeight,
        onPanResponderTerminate: finishDraggedHeight,
      }),
    [editable, finishDraggedHeight],
  );
  useEffect(
    () => () => {
      resizeGestureActiveRef.current = false;
      if (recoveryFocusFrameRef.current != null) {
        cancelAnimationFrame(recoveryFocusFrameRef.current);
        recoveryFocusFrameRef.current = null;
      }
    },
    [],
  );
  const liveVisibleLines = useMemo(
    () => heightToLines(inputHeight),
    [inputHeight],
  );
  useEffect(() => {
    if (!registerSaveHandler) return;
    if (!visible) {
      registerSaveHandler(null);
      return;
    }
    registerSaveHandler(handleSave);
    return () => registerSaveHandler(null);
  }, [handleSave, registerSaveHandler, visible]);
  useEffect(() => {
    if (visible) return;
    if (editing) {
      setEditing(false);
    }
    onEditingChange?.(false);
    registerSaveHandler?.(null);
  }, [editing, onEditingChange, registerSaveHandler, visible]);
  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "auto" : "no-hide-descendants"}
      className="mx-[14px] mt-[10px] overflow-hidden rounded-section-card border border-border"
      style={{
        display: visible ? "flex" : "none",
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
          {t("detail.description")}
        </Text>
      </View>

      <View className={editable ? "p-md pb-0" : "p-md"}>
        {editable ? (
          <TextInput
            ref={descriptionInputRef}
            value={text}
            onChange={(event) => handleTextChange(event.nativeEvent.text)}
            editable={editable}
            multiline
            scrollEnabled={editing}
            onFocus={handleInputFocus}
            accessibilityLabel={t("detail.description")}
            className="rounded-input border border-border bg-surface text-base text-primary"
            style={{
              minHeight: INPUT_MIN_HEIGHT,
              height: inputHeight,
              maxHeight: linesToHeight(MAX_VISIBLE_LINES),
              backgroundColor: controlBackgroundColor,
              paddingHorizontal: INPUT_HORIZONTAL_PADDING,
              paddingTop: INPUT_VERTICAL_PADDING,
              paddingBottom: INPUT_VERTICAL_PADDING,
              lineHeight: INPUT_LINE_HEIGHT,
              borderColor: controlBorderColor,
              borderWidth: 0.5,
            }}
            textAlignVertical="top"
            returnKeyType="default"
            blurOnSubmit={false}
            placeholder={t("detail.description")}
            placeholderTextColor="#9E9E9E"
          />
        ) : (
          <View
            className="rounded-input border border-border bg-surface"
            style={{
              minHeight: INPUT_MIN_HEIGHT,
              height: inputHeight,
              backgroundColor: controlBackgroundColor,
              paddingHorizontal: INPUT_HORIZONTAL_PADDING,
              paddingTop: INPUT_VERTICAL_PADDING,
              paddingBottom: INPUT_VERTICAL_PADDING,
              borderColor: controlBorderColor,
              borderWidth: 0.5,
            }}
          >
            <Text
              numberOfLines={liveVisibleLines}
              ellipsizeMode="tail"
              className={
                text.trim() ? "text-base text-primary" : "text-base text-muted"
              }
              style={{ lineHeight: INPUT_LINE_HEIGHT }}
            >
              {text.trim() ? text : t("detail.description")}
            </Text>
          </View>
        )}
      </View>

      {editable ? (
        <View
          {...panResponder.panHandlers}
          className="px-md"
          style={{ paddingVertical: 2 }}
        >
          <View
            className="relative items-center justify-center"
            style={{ minHeight: 16 }}
          >
            <View
              className="absolute left-0 right-0 border-t border-divider"
              style={{
                top: "50%",
                borderTopColor: sectionDividerColor,
                borderTopWidth: 0.5,
              }}
            />
            <View
              className="rounded-full px-xs"
              style={{ backgroundColor: cardBackgroundColor }}
            >
              <MaterialIcons name="drag-handle" size={18} color="#9E9E9E" />
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
});
