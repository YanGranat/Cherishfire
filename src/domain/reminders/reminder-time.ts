const REMINDER_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidReminderTime(value: string): boolean {
  return REMINDER_TIME_RE.test(value);
}

function normalizeReminderTimesList(values: string[]): string[] {
  const unique = new Set<string>();
  const normalized: string[] = [];

  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!isValidReminderTime(value)) continue;
    if (unique.has(value)) continue;
    unique.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function parseReminderTimes(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (isValidReminderTime(trimmed)) {
    return [trimmed];
  }

  if (!trimmed.startsWith("[")) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];
    return normalizeReminderTimesList(parsed);
  } catch {
    return [];
  }
}

export function encodeReminderTimes(times: string[]): string | null {
  const normalized = normalizeReminderTimesList(times);
  if (normalized.length === 0) return null;
  if (normalized.length === 1) return normalized[0];
  return JSON.stringify(normalized);
}

export function getReminderSummary(value: string | null): string | null {
  const times = parseReminderTimes(value);
  if (times.length === 0) return null;
  if (times.length === 1) return times[0];
  return `${times[0]} +${times.length - 1}`;
}

export function formatReminderTime(date: Date): string {
  return `${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

export interface ReminderTimeRemoval {
  times: string[];
  removedIndex: number | null;
}

/**
 * Remove the time named by the rendered row, not whatever happens to occupy
 * its old numeric index after another rapid tap. Returning the same array for
 * an already-consumed intent also prevents a duplicate tap from deleting the
 * next row.
 */
export function removeReminderTimeIntent(
  times: string[],
  target: string,
): ReminderTimeRemoval {
  const removedIndex = times.indexOf(target);
  if (removedIndex < 0) return { times, removedIndex: null };
  return {
    times: [
      ...times.slice(0, removedIndex),
      ...times.slice(removedIndex + 1),
    ],
    removedIndex,
  };
}
