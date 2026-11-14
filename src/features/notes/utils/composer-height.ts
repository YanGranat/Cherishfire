interface NoteComposerContentHeightParams {
  textLength: number;
  contentHeight: number;
  currentHeight: number;
  baseHeight: number;
  maximumHeight: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function getNoteComposerContentHeight({
  textLength,
  contentHeight,
  currentHeight,
  baseHeight,
  maximumHeight,
}: NoteComposerContentHeightParams): number {
  const safeBaseHeight = Math.max(0, finiteOr(baseHeight, 0));
  const safeMaximumHeight = Math.max(
    safeBaseHeight,
    finiteOr(maximumHeight, safeBaseHeight)
  );

  // Android may deliver a stale content-size event from the submitted text
  // after the controlled value has already been cleared. Empty text always
  // owns the collapsed one-line height.
  if (textLength <= 0) return safeBaseHeight;

  const safeCurrentHeight = Math.min(
    safeMaximumHeight,
    Math.max(safeBaseHeight, finiteOr(currentHeight, safeBaseHeight))
  );
  const safeContentHeight = Math.round(
    Math.min(
      safeMaximumHeight,
      Math.max(safeBaseHeight, finiteOr(contentHeight, safeBaseHeight))
    )
  );

  return safeContentHeight > safeCurrentHeight + 1
    ? safeContentHeight
    : safeCurrentHeight;
}
