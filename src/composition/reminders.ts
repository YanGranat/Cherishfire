import {
  createReminderService,
  type PendingReminderReplacementBoundary,
  type ReminderSyncIntent,
} from "@/application/reminders/reminder-service";
import { createReminderSnapshotReader } from "@/application/reminders/reminder-snapshot";
import { sqliteReminderDayRecordRepository } from "@/data/sqlite/reminder-day-record-repository";
import { habitPersistence } from "@/composition/habits";
import { settingsRepository } from "@/data/sqlite/settings-repository";
import {
  createExpoReminderNotificationAdapter,
  openReminderSystemSettings,
} from "@/platform/notifications/expo-reminder-notification-adapter";
import {
  createReminderPermissionStatusStore,
  withReminderPermissionStatusRefresh,
} from "@/application/reminders/reminder-permission-status";
import { reactNativeReminderWorkScheduling } from "@/platform/react-native/reminder-work-scheduling";
import { reminderClock } from "@/platform/time/reminder-clock";
import type { Habit } from "@/types/habit";

const notificationAdapter = createExpoReminderNotificationAdapter();
export const reminderPermissionStatus = createReminderPermissionStatusStore({
  readPermissionStatus: () => notificationAdapter.readPermissionStatus(),
  openSystemSettings: openReminderSystemSettings,
});

const reminderService = createReminderService({
  snapshot: createReminderSnapshotReader({
    readHabits: habitPersistence.readAllHabits,
    readSettings: settingsRepository.readAll,
  }),
  dayRecords: sqliteReminderDayRecordRepository,
  notifications: withReminderPermissionStatusRefresh(
    notificationAdapter,
    reminderPermissionStatus.refreshIfObserved,
  ),
  workScheduling: reactNativeReminderWorkScheduling,
  clock: reminderClock,
});

export function setReminderNotificationsEnabled(
  enabled: boolean,
  intent?: ReminderSyncIntent,
): Promise<void> {
  return reminderService.setReminderNotificationsEnabled(enabled, intent);
}

export function scheduleReminderNotificationLocalizationRefresh(): void {
  reminderService.scheduleReminderNotificationLocalizationRefresh();
}

export function refreshReminderNotificationTimezone(): Promise<void> {
  return reminderService.refreshReminderNotificationTimezone();
}

export function subscribeToReminderNotificationResponses(
  onOpenMainScreen: () => void,
): () => void {
  return reminderService.subscribeToReminderNotificationResponses(
    onOpenMainScreen,
  );
}

export function warmupHabitReminders(): Promise<void> {
  return reminderService.warmupHabitReminders();
}

export function scheduleHabitRemindersSync(
  habitsList: Habit[],
  intent?: ReminderSyncIntent,
): void {
  reminderService.scheduleHabitRemindersSync(habitsList, intent);
}

export function scheduleHabitReminderAfterRecordChange(
  habitsList: Habit[],
  habitId: number,
): void {
  reminderService.scheduleHabitReminderAfterRecordChange(habitsList, habitId);
}

export function startPendingReminderWorkBeforeBackground(): void {
  reminderService.startPendingReminderWorkBeforeBackground();
}

export function flushAndFreezePendingReminderWork(): Promise<PendingReminderReplacementBoundary> {
  return reminderService.flushAndFreezePendingReminderWork();
}

export function reconcileReminderNotificationsAfterImport(): Promise<void> {
  return reminderService.reconcileReminderNotificationsAfterImport();
}
