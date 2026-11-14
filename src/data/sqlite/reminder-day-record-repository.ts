import type {
  ReminderDayRecordReadPort,
  ReminderDayRecordRow,
} from "@/application/reminders/reminder-ports";
import { runtimeDb } from "@/db/runtime";

const REMINDER_QUERY_HABIT_CHUNK_SIZE = 800;

export const sqliteReminderDayRecordRepository: ReminderDayRecordReadPort = {
  async readByHabitIds(habitIds) {
    if (habitIds.length === 0) return [];

    const rows: ReminderDayRecordRow[] = [];
    for (
      let index = 0;
      index < habitIds.length;
      index += REMINDER_QUERY_HABIT_CHUNK_SIZE
    ) {
      const chunk = habitIds.slice(
        index,
        index + REMINDER_QUERY_HABIT_CHUNK_SIZE,
      );
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(
        ...(await runtimeDb.getAll<ReminderDayRecordRow>(
          `SELECT habit_id AS habitId, date, status
           FROM day_records
           WHERE habit_id IN (${placeholders})`,
          [...chunk],
        )),
      );
    }

    return rows;
  },
};
