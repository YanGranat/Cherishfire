import type { ReminderClockPort } from "@/application/reminders/reminder-ports";

export const reminderClock: ReminderClockPort = {
  now: () => new Date(),
  timezoneSignature() {
    const timeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown";
    return `${timeZone}:${new Date().getTimezoneOffset()}`;
  },
};
