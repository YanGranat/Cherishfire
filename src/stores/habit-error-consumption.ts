export function canConsumeHabitStoreError(
  error: string | null,
  currentRevision: number,
  expectedRevision?: number,
): boolean {
  return (
    error != null &&
    (expectedRevision == null || currentRevision === expectedRevision)
  );
}
