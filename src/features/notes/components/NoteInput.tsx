/** @jsxImportSource nativewind */
import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { View, TextInput, Pressable } from "react-native";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { getAccentScheme, lightTheme } from "@/theme/colors";
import {
  useVisualColorScheme,
  useVisualEffectiveMode,
} from "@/components/ScreenPreferencesBoundary";
import { useTranslation } from "react-i18next";
import { sizes } from "@/theme/tokens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getNoteComposerBottomPadding } from "@/features/notes/utils/keyboard-layout";
import { getNoteComposerContentHeight } from "@/features/notes/utils/composer-height";
import { mergeRecoveredDraft } from "@/utils/recovered-draft";
interface NoteInputProps {
  onSend: (text: string) => boolean;
  hidden?: boolean;
  keyboardVisible: boolean;
  extraKeyboardLift: number;
}
export interface NoteInputHandle {
  restoreDraft(recovery: { sequence: number; text: string }): void;
}
// Bottom composer with bounded growth and an empty-draft disabled send action.
export const NoteInput = forwardRef<NoteInputHandle, NoteInputProps>(
  function NoteInput(
    {
      onSend,
      hidden = false,
      keyboardVisible,
      extraKeyboardLift,
    }: NoteInputProps,
    forwardedRef,
  ) {
    const maxVisibleLines = 7;
    const baseInputHeight = 38;
    const [text, setText] = useState("");
    const [inputHeight, setInputHeight] = useState(baseInputHeight);
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const effectiveMode = useVisualEffectiveMode();
    const isDark = effectiveMode === "dark";
    const colorScheme = useVisualColorScheme();
    const accent = getAccentScheme(colorScheme).base;
    const canSend = text.trim().length > 0;
    const bottomPadding = getNoteComposerBottomPadding({
      bottomInset: insets.bottom,
      extraKeyboardLift,
      keyboardVisible,
    });
    const composerBackground = isDark ? "#1B1B1B" : lightTheme.surface;
    const composerBorderColor = isDark ? "#505050" : "#C7C7C7";
    const inputLineHeight = 22;
    const maxInputHeight =
      baseInputHeight + inputLineHeight * (maxVisibleLines - 1);
    const sendButtonSize = sizes.sendButton + 2;
    const measuredInputHeightRef = useRef(baseInputHeight);
    const textValueRef = useRef("");
    const draftBaseTextRef = useRef("");
    const prevTextLengthRef = useRef(0);
    const lastEditWasDeleteRef = useRef(false);
    const inputRef = useRef<TextInput>(null);
    const appliedRecoverySequenceRef = useRef(0);
    const isSingleLineInput = inputHeight <= baseInputHeight + 1;
    const applyInputHeight = (value: number) => {
      const nextHeight = Math.round(
        Math.min(maxInputHeight, Math.max(baseInputHeight, value)),
      );
      if (Math.abs(nextHeight - measuredInputHeightRef.current) < 1) {
        return;
      }
      measuredInputHeightRef.current = nextHeight;
      setInputHeight(nextHeight);
    };
    const getExplicitLinesHeight = (value: string) => {
      const explicitLines = value.split("\n").length;
      const clampedLines = Math.max(
        1,
        Math.min(maxVisibleLines, explicitLines),
      );
      return baseInputHeight + inputLineHeight * (clampedLines - 1);
    };
    useImperativeHandle(forwardedRef, () => ({
      restoreDraft(recovery) {
        if (recovery.sequence <= appliedRecoverySequenceRef.current) return;
        appliedRecoverySequenceRef.current = recovery.sequence;
        const nextText = mergeRecoveredDraft(
          recovery.text,
          textValueRef.current,
          "",
          draftBaseTextRef.current,
        );
        textValueRef.current = nextText;
        draftBaseTextRef.current = nextText;
        prevTextLengthRef.current = nextText.length;
        lastEditWasDeleteRef.current = false;
        setText(nextText);
        applyInputHeight(getExplicitLinesHeight(nextText));
        inputRef.current?.focus();
      },
    }));
    const handleSend = () => {
      const submittedText = textValueRef.current.trim();
      if (!submittedText) return;
      const sent = onSend(submittedText);
      if (sent) {
        textValueRef.current = "";
        draftBaseTextRef.current = "";
        measuredInputHeightRef.current = baseInputHeight;
        setText("");
        setInputHeight(baseInputHeight);
        prevTextLengthRef.current = 0;
        lastEditWasDeleteRef.current = false;
        return;
      }
    };
    return (
      <View
        pointerEvents={hidden ? "none" : "auto"}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        style={
          hidden
            ? { height: 0, opacity: 0, overflow: "hidden" }
            : {
                paddingHorizontal: 10,
                paddingTop: keyboardVisible ? 2 : 3,
                paddingBottom: bottomPadding + 2,
              }
        }
      >
        <View
          className="flex-row items-end"
          style={{
            borderWidth: 1.2,
            borderColor: composerBorderColor,
            borderRadius: 24,
            backgroundColor: composerBackground,
            paddingLeft: 14,
            paddingRight: 6,
            paddingTop: 4,
            paddingBottom: 4,
          }}
        >
          <TextInput
            ref={inputRef}
            value={text}
            selectionColor={accent}
            cursorColor={accent}
            onChange={(event) => {
              const value = event.nativeEvent.text;
              textValueRef.current = value;
              const prevLength = prevTextLengthRef.current;
              lastEditWasDeleteRef.current = value.length < prevLength;
              prevTextLengthRef.current = value.length;
              setText(value);
              if (value.length === 0) {
                applyInputHeight(baseInputHeight);
                return;
              }
              const explicitTargetHeight = getExplicitLinesHeight(value);
              if (explicitTargetHeight > measuredInputHeightRef.current) {
                applyInputHeight(explicitTargetHeight);
              } else if (
                lastEditWasDeleteRef.current &&
                explicitTargetHeight < measuredInputHeightRef.current
              ) {
                applyInputHeight(explicitTargetHeight);
              }
            }}
            placeholder={t("notes.placeholder")}
            multiline
            maxLength={2000}
            className="flex-1 text-primary text-base mr-sm"
            style={{
              minHeight: baseInputHeight,
              height: inputHeight,
              maxHeight: maxInputHeight,
              lineHeight: inputLineHeight,
              paddingTop: isSingleLineInput ? 0 : 6,
              paddingBottom: isSingleLineInput ? 0 : 6,
            }}
            scrollEnabled={inputHeight >= maxInputHeight - 1}
            onContentSizeChange={(event) => {
              const nextHeight = getNoteComposerContentHeight({
                textLength: textValueRef.current.length,
                contentHeight: event.nativeEvent.contentSize.height,
                currentHeight: measuredInputHeightRef.current,
                baseHeight: baseInputHeight,
                maximumHeight: maxInputHeight,
              });
              // Critical: while typing, content metrics can briefly oscillate.
              // Allow only growth for non-empty text; a cleared value always
              // collapses even if Android sends one stale pre-submit event.
              applyInputHeight(nextHeight);
            }}
            placeholderTextColor={isDark ? "#A0A0A0" : "#8A8A8A"}
            textAlignVertical={isSingleLineInput ? "center" : "top"}
          />
          <Pressable
            onPress={handleSend}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityLabel={t("notes.send")}
            accessibilityState={{ disabled: !canSend }}
            className="items-center justify-center"
            style={{
              width: sendButtonSize,
              height: sendButtonSize,
              borderRadius: sendButtonSize / 2,
              backgroundColor: canSend
                ? accent
                : isDark
                  ? "#3D3D3D"
                  : "#D1D1D1",
              opacity: canSend ? 1 : 0.7,
            }}
          >
            <FontAwesome6 name="arrow-up" size={16} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>
    );
  },
);
