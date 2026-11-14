import type { DayRecord } from "@/types/habit";

/**
 * Projects one persisted/optimistic day mutation over the already scoped
 * records of a single habit. The helper preserves the repository order and
 * mirrors the store's uniqueness semantics without rescanning every habit's
 * history on each checkbox tap.
 */
export function projectHabitDayRecordsForDate(
  habitRecords: readonly DayRecord[],
  date: string,
  nextRecord: DayRecord | null,
): DayRecord[] {
  if (nextRecord == null) {
    return habitRecords.filter((record) => record.date !== date);
  }

  let replaced = false;
  const projected = habitRecords.map((record) => {
    if (record.date !== date) return record;
    replaced = true;
    return nextRecord;
  });
  return replaced ? projected : [...projected, nextRecord];
}
