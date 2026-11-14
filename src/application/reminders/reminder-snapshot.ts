import type { ReminderSnapshotReadPort } from "@/application/reminders/reminder-ports";
import type { PersistedSettingRow } from "@/application/settings/settings-repository-port";
import type { Habit } from "@/types/habit";
import { DEFAULT_SETTINGS, SETTINGS_KEYS } from "@/types/settings";

export function createReminderSnapshotReader(dependencies: {
  readHabits(): Promise<Habit[]>;
  readSettings(): Promise<PersistedSettingRow[]>;
}): ReminderSnapshotReadPort {
  return {
    async readSnapshot() {
      const [habits, settings] = await Promise.all([
        dependencies.readHabits(),
        dependencies.readSettings(),
      ]);
      const reminderSetting = settings.find(
        (row) => row.key === SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED,
      );
      let notificationsEnabled = DEFAULT_SETTINGS.reminderNotificationsEnabled;
      if (reminderSetting) {
        try {
          const parsed = JSON.parse(reminderSetting.value) as unknown;
          if (typeof parsed === "boolean") notificationsEnabled = parsed;
        } catch {
          // Validation normally prevents malformed persisted settings.
        }
      }
      return { habits, notificationsEnabled };
    },
  };
}
