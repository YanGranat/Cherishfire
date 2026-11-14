/**
 * Restore a failed optimistic draft without overwriting text entered after the
 * failed submission. If the editor still contains only the confirmed value,
 * the failed draft can replace it exactly. Otherwise keep both user inputs.
 */
export function mergeRecoveredDraft(
  recovered: string,
  current: string,
  confirmed = "",
  currentBase = confirmed,
): string {
  if (current === recovered) return current;
  // The user may have reopened the optimistically saved value and continued
  // editing it before persistence rejected that save. In that case `current`
  // already contains `recovered`; concatenating both would duplicate text.
  // Preserve the newer derivative even when it is now empty because deleting
  // the inherited draft is also an explicit user decision.
  if (currentBase === recovered) return current;
  if (current === confirmed || current.length === 0) return recovered;
  return `${recovered}\n\n${current}`;
}
