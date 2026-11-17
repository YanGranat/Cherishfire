export const NOTE_EDITOR_VISIBILITY_TOLERANCE_DP = 0.5;
export const NOTE_EDITOR_KEYBOARD_GAP_DP = 12;

interface NoteCaretVisibilityParams {
  viewportTop: number;
  viewportHeight: number;
  inputTop: number;
  caretTop: number;
  caretBottom: number;
  keyboardTop: number;
  gap?: number;
}

/** Uses the native text layout, including soft wraps and the current selection. */
export function getNoteCaretScrollDelta({
  viewportTop, viewportHeight, inputTop, caretTop, caretBottom, keyboardTop,
  gap = NOTE_EDITOR_KEYBOARD_GAP_DP,
}: NoteCaretVisibilityParams): number | null {
  if (
    ![viewportTop, viewportHeight, inputTop, caretTop, caretBottom, keyboardTop, gap]
      .every(Number.isFinite) ||
    viewportHeight <= 0 || caretBottom <= caretTop || gap < 0
  ) return null;
  const visibleTop = viewportTop + gap;
  const visibleBottom = Math.min(viewportTop + viewportHeight, keyboardTop) - gap;
  if (visibleBottom - visibleTop < caretBottom - caretTop) return null;
  const top = inputTop + caretTop;
  const bottom = inputTop + caretBottom;
  if (bottom > visibleBottom + NOTE_EDITOR_VISIBILITY_TOLERANCE_DP) {
    return bottom - visibleBottom;
  }
  if (top < visibleTop - NOTE_EDITOR_VISIBILITY_TOLERANCE_DP) return top - visibleTop;
  return 0;
}

interface NoteEditorContentHeightParams {
  nativeHeight: number;
  currentHeight: number;
  minimumHeight: number;
  mayShrink: boolean;
}

/** Rejects the stale smaller size Android can emit after a newer insertion. */
export function getNoteEditorContentHeight({
  nativeHeight,
  currentHeight,
  minimumHeight,
  mayShrink,
}: NoteEditorContentHeightParams): number | null {
  if (
    ![nativeHeight, currentHeight, minimumHeight].every(Number.isFinite) ||
    nativeHeight <= 0 ||
    minimumHeight <= 0
  ) {
    return null;
  }
  const safeCurrentHeight = Math.max(minimumHeight, currentHeight);
  const measuredHeight = Math.max(minimumHeight, Math.ceil(nativeHeight));
  return measuredHeight < safeCurrentHeight - 0.5 && !mayShrink
    ? safeCurrentHeight
    : measuredHeight;
}

export interface NoteEditorVisibilityParams {
  viewportHeight: number;
  viewportPageY: number;
  editorHeight: number;
  editorPageY: number;
  actionsHeight: number;
  actionsPageY: number;
  keyboardTop: number;
  selectionAtEnd: boolean;
  keyboardGap?: number;
  tolerance?: number;
}

export interface NoteEditorVisibilityMeasurement {
  viewportTop: number;
  viewportBottom: number;
  effectiveBottom: number;
  leafTop: number;
  leafBottom: number;
  actionsTop: number;
  actionsBottom: number;
  unionTop: number;
  unionBottom: number;
  unionHeight: number;
  availableHeight: number;
  keyboardTop: number;
  keyboardGap: number;
  textVisible: boolean;
  actionsVisible: boolean;
  unionVisible: boolean;
}

export type NoteEditorVisibilityDecision =
  | { valid: false }
  | {
      valid: true;
      measurement: NoteEditorVisibilityMeasurement;
      visible: boolean;
      targetTooTall: boolean;
      visibilityMode: "full-editor" | "actions-and-editor-viewport" | "native-caret";
      scrollDelta: number;
    };

/** Pure geometry owner used by the production Notes convergence loop. */
export function getNoteEditorVisibilityDecision({
  viewportHeight,
  viewportPageY,
  editorHeight,
  editorPageY,
  actionsHeight,
  actionsPageY,
  keyboardTop,
  selectionAtEnd,
  keyboardGap = NOTE_EDITOR_KEYBOARD_GAP_DP,
  tolerance = NOTE_EDITOR_VISIBILITY_TOLERANCE_DP,
}: NoteEditorVisibilityParams): NoteEditorVisibilityDecision {
  if (
    ![
      viewportHeight,
      viewportPageY,
      editorHeight,
      editorPageY,
      actionsHeight,
      actionsPageY,
      keyboardTop,
      keyboardGap,
      tolerance,
    ].every(Number.isFinite) ||
    viewportHeight <= 0 ||
    editorHeight <= 0 ||
    actionsHeight <= 0 ||
    tolerance < 0 ||
    keyboardGap < 0
  ) {
    return { valid: false };
  }

  const viewportBottom = viewportPageY + viewportHeight;
  const effectiveBottom = Math.min(
    viewportBottom,
    keyboardTop - keyboardGap,
  );
  const editorBottom = editorPageY + editorHeight;
  const actionsBottom = actionsPageY + actionsHeight;
  const unionTop = Math.min(editorPageY, actionsPageY);
  const unionBottom = Math.max(editorBottom, actionsBottom);
  const availableHeight = Math.max(0, effectiveBottom - viewportPageY);
  const unionHeight = Math.max(0, unionBottom - unionTop);
  const textVisible =
    editorPageY >= viewportPageY - tolerance &&
    editorBottom <= effectiveBottom + tolerance;
  const actionsVisible =
    actionsPageY >= viewportPageY - tolerance &&
    actionsBottom <= effectiveBottom + tolerance;
  const unionVisible =
    unionTop >= viewportPageY - tolerance &&
    unionBottom <= effectiveBottom + tolerance;
  const targetTooTall = unionHeight > availableHeight + tolerance;
  const nativeCaretOwnsVisibility = targetTooTall && !selectionAtEnd;
  const oversizedTargetIsUsable =
    targetTooTall &&
    actionsVisible &&
    editorBottom <= effectiveBottom + tolerance &&
    editorBottom > viewportPageY - tolerance;

  let scrollDelta = 0;
  if (nativeCaretOwnsVisibility) {
    scrollDelta = 0;
  } else if (unionBottom > effectiveBottom + tolerance) {
    scrollDelta = unionBottom - effectiveBottom;
  } else if (!targetTooTall && unionTop < viewportPageY - tolerance) {
    scrollDelta = unionTop - viewportPageY;
  }

  return {
    valid: true,
    measurement: {
      viewportTop: viewportPageY,
      viewportBottom,
      effectiveBottom,
      leafTop: editorPageY,
      leafBottom: editorBottom,
      actionsTop: actionsPageY,
      actionsBottom,
      unionTop,
      unionBottom,
      unionHeight,
      availableHeight,
      keyboardTop,
      keyboardGap,
      textVisible,
      actionsVisible,
      unionVisible,
    },
    visible: unionVisible || oversizedTargetIsUsable,
    targetTooTall,
    visibilityMode: nativeCaretOwnsVisibility
      ? "native-caret"
      : targetTooTall
        ? "actions-and-editor-viewport"
        : "full-editor",
    scrollDelta,
  };
}
