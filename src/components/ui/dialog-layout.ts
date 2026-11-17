export function getDialogViewportHeight(
  rootHeight: number,
  rootScreenY: number,
  keyboardScreenY: number | null,
): number {
  if (keyboardScreenY == null) return rootHeight;
  return Math.max(0, Math.min(rootHeight, keyboardScreenY - rootScreenY));
}

export function getColorPaletteHeight(
  naturalCardHeight: number,
  availableCardHeight: number,
): number {
  return Math.max(64, 176 - Math.max(0, naturalCardHeight - availableCardHeight));
}
