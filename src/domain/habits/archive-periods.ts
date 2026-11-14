import { format } from "date-fns/format";
import { isCivilDateKey } from "@/domain/dates/civil-date";
import type { ArchivePeriod, Habit } from "@/types/habit";
import { getEarliestScheduleStartDate } from "@/domain/habits/schedule";

function toFiniteTimestamp(value: unknown): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}

function localDateForTimestamp(timestamp: number): string {
  return format(new Date(timestamp), "yyyy-MM-dd");
}

export function normalizeArchiveHistory(value: unknown): ArchivePeriod[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item): ArchivePeriod | null => {
      if (typeof item !== "object" || item == null || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const archivedAt = toFiniteTimestamp(record.archivedAt);
      if (archivedAt == null) return null;
      const restoredAt =
        record.restoredAt == null
          ? null
          : toFiniteTimestamp(record.restoredAt);
      if (record.restoredAt != null && restoredAt == null) return null;
      if (restoredAt != null && restoredAt < archivedAt) return null;
      const archivedDate = isCivilDateKey(record.archivedDate)
        ? record.archivedDate
        : localDateForTimestamp(archivedAt);
      const restoredDate =
        restoredAt == null
          ? null
          : isCivilDateKey(record.restoredDate)
            ? record.restoredDate
            : localDateForTimestamp(restoredAt);
      return { archivedAt, restoredAt, archivedDate, restoredDate };
    })
    .filter((period): period is ArchivePeriod => period != null)
    .sort((a, b) => a.archivedAt - b.archivedAt);
}

export function startArchivePeriod(
  history: ArchivePeriod[],
  archivedAt: number,
  archivedDate = localDateForTimestamp(archivedAt)
): ArchivePeriod[] {
  const normalized = normalizeArchiveHistory(history);
  if (normalized.some((period) => period.restoredAt == null)) {
    return normalized;
  }
  return [
    ...normalized,
    { archivedAt, restoredAt: null, archivedDate, restoredDate: null },
  ];
}

export function closeArchivePeriod(
  history: ArchivePeriod[],
  restoredAt: number,
  fallbackArchivedAt?: number | null,
  restoredDate = localDateForTimestamp(restoredAt)
): ArchivePeriod[] {
  const normalized = normalizeArchiveHistory(history);
  const openIndex = normalized.findLastIndex(
    (period) => period.restoredAt == null
  );

  if (openIndex < 0) {
    if (fallbackArchivedAt == null || restoredAt < fallbackArchivedAt) {
      return normalized;
    }
    return [
      ...normalized,
      {
        archivedAt: fallbackArchivedAt,
        restoredAt,
        archivedDate: localDateForTimestamp(fallbackArchivedAt),
        restoredDate,
      },
    ].sort((a, b) => a.archivedAt - b.archivedAt);
  }

  return normalized.map((period, index) =>
    index === openIndex
      ? {
          ...period,
          restoredAt: Math.max(restoredAt, period.archivedAt),
          restoredDate,
        }
      : period
  );
}

export function isDateInArchiveHistory(
  date: string,
  history: ArchivePeriod[]
): boolean {
  return history.some((period) => {
    if (!Number.isFinite(period.archivedAt)) return false;
    const archiveDate =
      period.archivedDate ?? localDateForTimestamp(period.archivedAt);
    if (date < archiveDate) return false;
    if (period.restoredAt == null) return true;
    if (!Number.isFinite(period.restoredAt)) return false;
    const restoreDate =
      period.restoredDate ?? localDateForTimestamp(period.restoredAt);
    return date < restoreDate;
  });
}

export function isHabitTrackingActiveOnDate(
  habit: Pick<Habit, "startDate" | "archiveHistory" | "scheduleHistory">,
  date: string
): boolean {
  return (
    date >= getEarliestScheduleStartDate(habit.startDate, habit.scheduleHistory) &&
    !isDateInArchiveHistory(date, habit.archiveHistory)
  );
}
