import { isCivilDateKey } from "@/domain/dates/civil-date";

// Repeat schedule as a discriminated union.
// In DB, stored as repeat_type (TEXT) + repeat_config (JSON without the type field).
// Conversion between DB and app representation happens in the data access layer.
export type RepeatSchedule =
  | { type: "daily" }
  | { type: "weekdays"; days: number[] } // 1=Mon..7=Sun, at least 1
  | { type: "monthly"; dates: number[] } // 1..31, at least 1
  | { type: "interval"; every: number; fromCompletion?: boolean }; // 2..365

export type RepeatType = RepeatSchedule["type"];

export function areRepeatSchedulesEqual(
  left: RepeatSchedule,
  right: RepeatSchedule
): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "daily" && right.type === "daily") return true;
  if (left.type === "weekdays" && right.type === "weekdays") {
    return [...left.days].sort((a, b) => a - b).join(",") ===
      [...right.days].sort((a, b) => a - b).join(",");
  }
  if (left.type === "monthly" && right.type === "monthly") {
    return [...left.dates].sort((a, b) => a - b).join(",") ===
      [...right.dates].sort((a, b) => a - b).join(",");
  }
  if (left.type === "interval" && right.type === "interval") {
    return (
      left.every === right.every &&
      (left.fromCompletion === true) === (right.fromCompletion === true)
    );
  }
  return false;
}

export interface ScheduleHistoryEntry {
  effectiveFrom: string; // local ISO date when this version became active
  startDate: string;
  repeatSchedule: RepeatSchedule;
}

export type DayStatus = "done" | "minimum" | "maximum" | "skipped" | "failure";

export interface ArchivePeriod {
  archivedAt: number; // timestamp ms
  restoredAt: number | null; // timestamp ms; null while habit remains archived
  archivedDate?: string; // immutable local ISO date captured when archived
  restoredDate?: string | null; // immutable local ISO date captured when restored
}

export interface Habit {
  id: number;
  name: string;
  description: string | null;
  descriptionVisible: boolean;
  repeatSchedule: RepeatSchedule;
  scheduleHistory?: ScheduleHistoryEntry[];
  startDate: string; // ISO YYYY-MM-DD
  reminderEnabled: boolean;
  reminderTime: string | null; // HH:MM | JSON array of HH:MM
  displayOrder: number;
  isArchived: boolean;
  archivedAt: number | null; // timestamp ms
  archiveHistory: ArchivePeriod[];
  createdAt: number; // timestamp ms
  updatedAt: number; // timestamp ms
}

export interface DayRecord {
  id: number;
  habitId: number;
  date: string; // ISO YYYY-MM-DD
  status: DayStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CreateHabitInput {
  name: string;
  description?: string;
  repeatSchedule: RepeatSchedule;
  startDate: string;
  reminderEnabled: boolean;
  reminderTime?: string; // HH:MM | JSON array of HH:MM
}

export interface UpdateHabitInput {
  description?: string;
  descriptionVisible?: boolean;
  repeatSchedule?: RepeatSchedule;
  startDate?: string;
  reminderEnabled?: boolean;
  reminderTime?: string | null; // HH:MM | JSON array of HH:MM
}

// Convert DB row (repeat_type + repeat_config) to app RepeatSchedule
export function toRepeatSchedule(
  repeatType: string,
  repeatConfig: Record<string, unknown>
): RepeatSchedule {
  switch (repeatType) {
    case "weekdays":
      return { type: "weekdays", days: repeatConfig.days as number[] };
    case "monthly":
      return { type: "monthly", dates: repeatConfig.dates as number[] };
    case "interval": {
      const rawEvery = Number(repeatConfig.every);
      return {
        type: "interval",
        every:
          Number.isInteger(rawEvery) && rawEvery >= 2 && rawEvery <= 365
            ? rawEvery
            : 2,
        fromCompletion: repeatConfig.fromCompletion === true,
      };
    }
    default:
      return { type: "daily" };
  }
}

// Convert app RepeatSchedule to DB columns
export function fromRepeatSchedule(
  schedule: RepeatSchedule,
  scheduleHistory?: ScheduleHistoryEntry[]
): {
  repeatType: string;
  repeatConfig: Record<string, unknown>;
} {
  const withHistory = (config: Record<string, unknown>) =>
    scheduleHistory && scheduleHistory.length > 0
      ? { ...config, scheduleHistory }
      : config;

  switch (schedule.type) {
    case "weekdays":
      return {
        repeatType: "weekdays",
        repeatConfig: withHistory({ days: schedule.days }),
      };
    case "monthly":
      return {
        repeatType: "monthly",
        repeatConfig: withHistory({ dates: schedule.dates }),
      };
    case "interval":
      return {
        repeatType: "interval",
        repeatConfig: withHistory({
          every: schedule.every,
          fromCompletion: schedule.fromCompletion === true,
        }),
      };
    default:
      return { repeatType: "daily", repeatConfig: withHistory({}) };
  }
}

function parseSchedule(value: unknown): RepeatSchedule | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.type === "daily") return { type: "daily" };
  if (raw.type === "weekdays" && Array.isArray(raw.days)) {
    const days = raw.days.filter(
      (day): day is number => Number.isInteger(day) && day >= 1 && day <= 7
    );
    return days.length > 0 ? { type: "weekdays", days } : null;
  }
  if (raw.type === "monthly" && Array.isArray(raw.dates)) {
    const dates = raw.dates.filter(
      (date): date is number => Number.isInteger(date) && date >= 1 && date <= 31
    );
    return dates.length > 0 ? { type: "monthly", dates } : null;
  }
  if (
    raw.type === "interval" &&
    Number.isInteger(raw.every) &&
    Number(raw.every) >= 2 &&
    Number(raw.every) <= 365
  ) {
    return {
      type: "interval",
      every: Number(raw.every),
      fromCompletion: raw.fromCompletion === true,
    };
  }
  return null;
}

export function toScheduleHistory(
  repeatConfig: Record<string, unknown>,
  currentSchedule: RepeatSchedule,
  currentStartDate: string
): ScheduleHistoryEntry[] {
  const rawHistory = repeatConfig.scheduleHistory;
  const byEffectiveDate = new Map<string, ScheduleHistoryEntry>();

  if (Array.isArray(rawHistory)) {
    for (const item of rawHistory) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      const repeatSchedule = parseSchedule(raw.repeatSchedule);
      if (!isCivilDateKey(raw.effectiveFrom) || !isCivilDateKey(raw.startDate) || !repeatSchedule) {
        continue;
      }
      byEffectiveDate.set(raw.effectiveFrom, {
        effectiveFrom: raw.effectiveFrom,
        startDate: raw.startDate,
        repeatSchedule,
      });
    }
  }

  if (byEffectiveDate.size === 0) {
    return [
      {
        effectiveFrom: currentStartDate,
        startDate: currentStartDate,
        repeatSchedule: currentSchedule,
      },
    ];
  }

  return Array.from(byEffectiveDate.values()).sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0
  );
}

export function updateScheduleHistory(
  history: ScheduleHistoryEntry[] | undefined,
  previousSchedule: RepeatSchedule,
  previousStartDate: string,
  effectiveFrom: string,
  nextSchedule: RepeatSchedule,
  nextStartDate: string
): ScheduleHistoryEntry[] {
  const normalized =
    history && history.length > 0
      ? [...history]
      : [
          {
            effectiveFrom: previousStartDate,
            startDate: previousStartDate,
            repeatSchedule: previousSchedule,
          },
        ];
  const nextEntry: ScheduleHistoryEntry = {
    effectiveFrom,
    startDate: nextStartDate,
    repeatSchedule: nextSchedule,
  };
  const beforeChange = normalized.filter(
    (entry) => entry.effectiveFrom < effectiveFrom
  );
  beforeChange.push(nextEntry);
  return beforeChange.sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0
  );
}
