const MIN_INTERVAL = 2;
const MAX_INTERVAL = 365;

export function normalizeIntervalDraft(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return MIN_INTERVAL;
  return Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, parsed));
}
