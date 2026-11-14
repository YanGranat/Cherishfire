import type { DayRecord, Habit } from "@/types/habit";

export interface HabitDetailReader {
  readHabit(habitId: number): Promise<Habit | null>;
  readDayRecords(habitId: number): Promise<DayRecord[]>;
}

export interface HabitDetailQuery {
  habitId: number;
  includeHabit: boolean;
  includeDayRecords: boolean;
}

export interface HabitDetailQueryResult {
  habit: Habit | null;
  dayRecords: DayRecord[] | null;
}

/**
 * Application-facing read use case for a cold or forced habit-detail load.
 * Presentation decides which already-cached pieces it needs; the SQLite
 * adapter and query shape stay behind this boundary.
 */
export function createHabitDetailQueries(reader: HabitDetailReader) {
  return {
    async load(query: HabitDetailQuery): Promise<HabitDetailQueryResult> {
      const [habit, dayRecords] = await Promise.all([
        query.includeHabit
          ? reader.readHabit(query.habitId)
          : Promise.resolve(null),
        query.includeDayRecords
          ? reader.readDayRecords(query.habitId)
          : Promise.resolve(null),
      ]);
      return { habit, dayRecords };
    },
  };
}
