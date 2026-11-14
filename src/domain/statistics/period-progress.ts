import type { DayStatus } from "@/types/habit";

export interface PeriodProgress {
  completed: number;
  planned: number;
  occurrences: number;
  percentageLabel: string;
}

export function isCompletedStatus(
  status: DayStatus | null | undefined,
): boolean {
  return status === "done" || status === "minimum" || status === "maximum";
}

function formatPercentage(
  completed: number,
  planned: number,
  occurrences: number,
): string {
  if (planned === 0) return occurrences > 0 ? "—" : "0";
  if (completed === 0) return "0";
  if (completed >= planned) return "100";

  const exactPercentage = (completed / planned) * 100;
  if (exactPercentage < 1) return "<1";

  // An incomplete period must never look fully complete after rounding.
  return String(Math.min(99, Math.round(exactPercentage)));
}

export function calculatePeriodProgress(
  scheduledStatuses: readonly (DayStatus | null | undefined)[],
): PeriodProgress {
  let planned = 0;
  let completed = 0;

  for (const status of scheduledStatuses) {
    // A skip cancels this particular obligation instead of counting as missed.
    if (status === "skipped") continue;

    planned += 1;
    if (isCompletedStatus(status)) completed += 1;
  }

  return {
    completed,
    planned,
    occurrences: scheduledStatuses.length,
    percentageLabel: formatPercentage(
      completed,
      planned,
      scheduledStatuses.length,
    ),
  };
}
