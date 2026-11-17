import { Linking, Platform } from "react-native";
import { uuid } from "expo-modules-core";
import type * as ExpoNotifications from "expo-notifications";
import i18n from "@/i18n/config";
import {
  createReminderNotificationAdapter,
  type ReminderNotificationsNativeModule,
} from "@/platform/notifications/reminder-notification-adapter-core";
import { createReminderSchedulingJournal } from "@/platform/notifications/reminder-scheduling-journal";

type ExpoNotificationsModule = Pick<
  typeof ExpoNotifications,
  | "addNotificationResponseReceivedListener"
  | "AndroidImportance"
  | "AndroidNotificationVisibility"
  | "cancelScheduledNotificationAsync"
  | "clearLastNotificationResponse"
  | "getAllScheduledNotificationsAsync"
  | "getLastNotificationResponse"
  | "getPermissionsAsync"
  | "IosAuthorizationStatus"
  | "requestPermissionsAsync"
  | "SchedulableTriggerInputTypes"
  | "scheduleNotificationAsync"
  | "setNotificationChannelAsync"
  | "setNotificationHandler"
>;

async function importLocalNotificationsModule(): Promise<ExpoNotificationsModule> {
  // The package barrel also loads remote-push auto-registration. Expo Go then
  // prints a red remote-push error even though Cherishfire only uses local
  // notifications. Importing the local APIs directly avoids that side effect.
  const [
    scheduler,
    scheduledRequests,
    cancellation,
    channels,
    handler,
    permissions,
    responses,
    notificationTypes,
    channelTypes,
    permissionTypes,
  ] = await Promise.all([
    import("expo-notifications/build/scheduleNotificationAsync"),
    import("expo-notifications/build/getAllScheduledNotificationsAsync"),
    import("expo-notifications/build/cancelScheduledNotificationAsync"),
    import("expo-notifications/build/setNotificationChannelAsync"),
    import("expo-notifications/build/NotificationsHandler"),
    import("expo-notifications/build/NotificationPermissions"),
    import("expo-notifications/build/NotificationsEmitter"),
    import("expo-notifications/build/Notifications.types"),
    import("expo-notifications/build/NotificationChannelManager.types"),
    import("expo-notifications/build/NotificationPermissions.types"),
  ]);

  return {
    addNotificationResponseReceivedListener:
      responses.addNotificationResponseReceivedListener,
    AndroidImportance: channelTypes.AndroidImportance,
    AndroidNotificationVisibility: channelTypes.AndroidNotificationVisibility,
    cancelScheduledNotificationAsync: cancellation.default,
    clearLastNotificationResponse: responses.clearLastNotificationResponse,
    getAllScheduledNotificationsAsync: scheduledRequests.default,
    getLastNotificationResponse: responses.getLastNotificationResponse,
    getPermissionsAsync: permissions.getPermissionsAsync,
    IosAuthorizationStatus: permissionTypes.IosAuthorizationStatus,
    requestPermissionsAsync: permissions.requestPermissionsAsync,
    SchedulableTriggerInputTypes:
      notificationTypes.SchedulableTriggerInputTypes,
    scheduleNotificationAsync: scheduler.default,
    setNotificationChannelAsync: channels.default,
    setNotificationHandler: handler.setNotificationHandler,
  };
}

export function createExpoReminderNotificationAdapter() {
  return createReminderNotificationAdapter({
    platform: Platform.OS,
    createNotificationIdentifier: () => uuid.v4(),
    schedulingJournal: createReminderSchedulingJournal(),
    loadModule: async () =>
      (await importLocalNotificationsModule()) as unknown as ReminderNotificationsNativeModule,
    copy: {
      channelName: () => i18n.t("reminderScreen.channelName"),
      notificationTitle: () => i18n.t("reminderScreen.notificationTitle"),
      notificationBody: (habitName) =>
        i18n.t("reminderScreen.notificationBody", { name: habitName }),
    },
  });
}

export function openReminderSystemSettings(): Promise<void> {
  return Linking.openSettings();
}
