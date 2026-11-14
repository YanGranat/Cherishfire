export const DESCRIPTION_LINES_KEY_PREFIX = "habit_description_lines_v1:";
const DESCRIPTION_LINES_SCOPE_PREFIX = "habitDescriptionLines:";
export const DESCRIPTION_LINES_MIN = 1;
export const DESCRIPTION_LINES_MAX = 40;
export const DESCRIPTION_LINES_DEFAULT = 1;

export type HabitDescriptionLinesScope =
  `${typeof DESCRIPTION_LINES_SCOPE_PREFIX}${number}`;

export function clampDescriptionVisibleLines(lines: number): number {
  return Math.max(
    DESCRIPTION_LINES_MIN,
    Math.min(DESCRIPTION_LINES_MAX, Math.round(lines)),
  );
}

export function getDescriptionLinesSettingKey(habitId: number): string {
  return `${DESCRIPTION_LINES_KEY_PREFIX}${habitId}`;
}

export function getHabitDescriptionLinesScope(
  habitId: number,
): HabitDescriptionLinesScope {
  if (!Number.isSafeInteger(habitId) || habitId <= 0) {
    throw new Error(`Invalid habit id for description lines: ${habitId}`);
  }
  return `${DESCRIPTION_LINES_SCOPE_PREFIX}${habitId}`;
}

export function getHabitDescriptionLinesScopeHabitId(
  scope: string,
): number | null {
  if (!scope.startsWith(DESCRIPTION_LINES_SCOPE_PREFIX)) return null;
  const rawHabitId = scope.slice(DESCRIPTION_LINES_SCOPE_PREFIX.length);
  if (!/^\d+$/.test(rawHabitId)) return null;
  const habitId = Number(rawHabitId);
  return Number.isSafeInteger(habitId) && habitId > 0 ? habitId : null;
}

export function getDescriptionLinesSettingHabitId(key: string): number | null {
  if (!key.startsWith(DESCRIPTION_LINES_KEY_PREFIX)) return null;
  const rawHabitId = key.slice(DESCRIPTION_LINES_KEY_PREFIX.length);
  if (!/^\d+$/.test(rawHabitId)) return null;
  const habitId = Number(rawHabitId);
  return Number.isSafeInteger(habitId) && habitId > 0 ? habitId : null;
}

export function isValidDescriptionLinesValue(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    Number(value) >= DESCRIPTION_LINES_MIN &&
    Number(value) <= DESCRIPTION_LINES_MAX
  );
}

export interface PersistedDescriptionLinesRow {
  readonly key: string;
  readonly value: string;
}

/** Pure bootstrap/import parser. It never mutates the live coordinator cache. */
export function parsePersistedDescriptionLines(
  rows: Iterable<PersistedDescriptionLinesRow>,
): ReadonlyMap<number, number> {
  const values = new Map<number, number>();
  for (const row of rows) {
    const habitId = getDescriptionLinesSettingHabitId(row.key);
    if (habitId == null) continue;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (!isValidDescriptionLinesValue(parsed)) continue;
      values.set(habitId, clampDescriptionVisibleLines(parsed));
    } catch {
      // Optional UI state with invalid JSON falls back to the default height.
    }
  }
  return values;
}
