interface NoteKeyboardLayoutParams {
  maximumLayoutHeight: number;
  currentLayoutHeight: number;
  keyboardOverlap: number;
  bottomInset: number;
  nativeLayoutOwner: boolean;
}

interface ReportedKeyboardOverlapParams {
  eventHeight: number;
  overlapFromScreenY: number;
  preferEventHeight: boolean;
}

interface NoteComposerBottomPaddingParams {
  bottomInset: number;
  extraKeyboardLift: number;
  keyboardVisible: boolean;
}

export interface NoteKeyboardLayoutMetrics {
  keyboardVisible: boolean;
  systemResizeInset: number;
  composerKeyboardLift: number;
  viewportKeyboardLift: number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export const NOTE_COMPOSER_KEYBOARD_GAP = 6;

export function getReportedKeyboardOverlap({
  eventHeight,
  overlapFromScreenY,
  preferEventHeight,
}: ReportedKeyboardOverlapParams): number {
  const safeEventHeight = finiteNonNegative(eventHeight);
  const safeScreenOverlap = finiteNonNegative(overlapFromScreenY);
  if (preferEventHeight && safeEventHeight > 0) return safeEventHeight;
  return Math.max(safeEventHeight, safeScreenOverlap);
}

export function getNoteComposerBottomPadding({
  bottomInset,
  extraKeyboardLift,
  keyboardVisible,
}: NoteComposerBottomPaddingParams): number {
  const safeBottomInset = finiteNonNegative(bottomInset);
  const safeKeyboardLift = finiteNonNegative(extraKeyboardLift);

  if (keyboardVisible) {
    return safeBottomInset + safeKeyboardLift + NOTE_COMPOSER_KEYBOARD_GAP;
  }

  return Math.max(safeBottomInset, 12);
}

export function getNoteKeyboardLayoutMetrics({
  maximumLayoutHeight,
  currentLayoutHeight,
  keyboardOverlap,
  bottomInset,
  nativeLayoutOwner,
}: NoteKeyboardLayoutParams): NoteKeyboardLayoutMetrics {
  const safeCurrentLayoutHeight = finiteNonNegative(currentLayoutHeight);
  const baselineLayoutHeight = Math.max(
    safeCurrentLayoutHeight,
    finiteNonNegative(maximumLayoutHeight)
  );
  const visibleKeyboardOverlap = finiteNonNegative(keyboardOverlap);
  const safeBottomInset = finiteNonNegative(bottomInset);
  const keyboardVisible = visibleKeyboardOverlap > 0.5;
  const systemResizeInset = keyboardVisible
    ? nativeLayoutOwner
      ? visibleKeyboardOverlap
      : Math.max(0, baselineLayoutHeight - safeCurrentLayoutHeight)
    : 0;
  const viewportKeyboardLift = Math.max(
    0,
    visibleKeyboardOverlap - systemResizeInset
  );
  const composerKeyboardLift = Math.max(
    0,
    viewportKeyboardLift - safeBottomInset
  );

  return {
    keyboardVisible,
    systemResizeInset,
    composerKeyboardLift,
    viewportKeyboardLift,
  };
}
