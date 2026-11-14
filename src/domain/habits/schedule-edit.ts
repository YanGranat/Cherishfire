import {
  areRepeatSchedulesEqual,
  updateScheduleHistory,
  type DayStatus,
  type RepeatSchedule,
  type ScheduleHistoryEntry,
} from "@/types/habit";
import {
  createScheduleDateFacts,
  createScheduleDateFactsFromDayNumber,
  isHabitScheduledForDate,
  partitionRecordsForScheduleVersion,
} from "@/domain/habits/schedule";

type ScheduleRecord = {
  date: string;
  status: DayStatus;
};

export interface HabitScheduleEditPlan<T extends ScheduleRecord> {
  changed: boolean;
  repeatSchedule: RepeatSchedule;
  startDate: string;
  effectiveFrom: string;
  preserveBeforeEffectiveFrom: boolean;
  scheduleHistory: ScheduleHistoryEntry[];
  keptRecords: T[];
  removedRecords: T[];
}

/**
 * One semantic model for both the optimistic screen snapshot and the SQLite
 * transaction. Keeping this decision pure prevents a frame where the repeat
 * row uses the new schedule while the calendar still uses the old history.
 */
export function planHabitScheduleEdit<T extends ScheduleRecord>(params: {
  previousSchedule: RepeatSchedule;
  previousStartDate: string;
  previousHistory?: ScheduleHistoryEntry[];
  records: T[];
  nextSchedule?: RepeatSchedule;
  nextStartDate?: string;
  today: string;
}): HabitScheduleEditPlan<T> {
  const repeatSchedule = params.nextSchedule ?? params.previousSchedule;
  const startDate = params.nextStartDate ?? params.previousStartDate;
  const startDateChanged = startDate !== params.previousStartDate;
  const repeatScheduleChanged = !areRepeatSchedulesEqual(
    params.previousSchedule,
    repeatSchedule,
  );

  if (!startDateChanged && !repeatScheduleChanged) {
    return {
      changed: false,
      repeatSchedule,
      startDate,
      effectiveFrom: params.today,
      preserveBeforeEffectiveFrom: true,
      scheduleHistory:
        params.previousHistory && params.previousHistory.length > 0
          ? params.previousHistory
          : [
              {
                effectiveFrom: params.previousStartDate,
                startDate: params.previousStartDate,
                repeatSchedule: params.previousSchedule,
              },
            ],
      keptRecords: params.records,
      removedRecords: [],
    };
  }

  let effectiveFrom = startDateChanged ? startDate : params.today;
  const preserveBeforeEffectiveFrom = !startDateChanged;

  if (!startDateChanged) {
    const existingTodayRecord = params.records.find(
      (record) => record.date === params.today,
    );
    const todayFitsNextSchedule = isHabitScheduledForDate(
      repeatSchedule,
      startDate,
      params.today,
      params.records,
      [
        {
          effectiveFrom: params.today,
          startDate,
          repeatSchedule,
        },
      ],
    );

    // A valid mark already made today retains today's historical meaning.
    // The new repeat begins tomorrow. If the new repeat makes today
    // impossible, it begins today and that stale mark is removed.
    if (existingTodayRecord && todayFitsNextSchedule) {
      effectiveFrom = createScheduleDateFactsFromDayNumber(
        createScheduleDateFacts(params.today).civilDayNumber + 1,
      ).date;
    }
  }

  const scheduleHistory = startDateChanged
    ? [
        {
          effectiveFrom: startDate,
          startDate,
          repeatSchedule,
        },
      ]
    : updateScheduleHistory(
        params.previousHistory,
        params.previousSchedule,
        params.previousStartDate,
        effectiveFrom,
        repeatSchedule,
        startDate,
      );
  const partition = partitionRecordsForScheduleVersion(
    params.records,
    repeatSchedule,
    startDate,
    effectiveFrom,
    preserveBeforeEffectiveFrom,
  );

  return {
    changed: true,
    repeatSchedule,
    startDate,
    effectiveFrom,
    preserveBeforeEffectiveFrom,
    scheduleHistory,
    keptRecords: partition.kept,
    removedRecords: partition.removed,
  };
}
