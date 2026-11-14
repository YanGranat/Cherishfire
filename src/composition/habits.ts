import { createHabitDetailQueries } from "@/application/habits/habit-detail-queries";
import { createHabitPersistenceApplication } from "@/application/habits/habit-persistence";
import { sqliteHabitRepository } from "@/data/sqlite/habit-repository";

// Composition root only: application owns use cases; SQLite owns persistence.
export const habitPersistence = createHabitPersistenceApplication(
  sqliteHabitRepository,
);

export const habitDetailQueries = createHabitDetailQueries({
  readHabit: (habitId) => sqliteHabitRepository.readHabit(habitId),
  readDayRecords: (habitId) =>
    sqliteHabitRepository.readDayRecordsForHabit(habitId),
});
