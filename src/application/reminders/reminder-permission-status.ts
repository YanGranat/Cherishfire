import type {
  ReminderNotificationPort,
  ReminderPermissionStatus,
} from "@/application/reminders/reminder-ports";

export type ReminderPermissionPresentation =
  | ReminderPermissionStatus
  | "unknown"
  | "error";

export function withReminderPermissionStatusRefresh(
  notifications: ReminderNotificationPort,
  refreshIfObserved: () => void,
): ReminderNotificationPort {
  return {
    ...notifications,
    async requestPermission() {
      try {
        return await notifications.requestPermission();
      } finally {
        refreshIfObserved();
      }
    },
  };
}

export function createReminderPermissionStatusStore(dependencies: {
  readPermissionStatus(): Promise<ReminderPermissionStatus>;
  openSystemSettings(): Promise<void>;
}) {
  let status: ReminderPermissionPresentation = "unknown";
  let revision = 0;
  let openingSettings: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();

  const publish = (next: ReminderPermissionPresentation) => {
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener();
  };
  const refresh = async (): Promise<void> => {
    const requestedRevision = ++revision;
    let next: ReminderPermissionPresentation;
    let readError: unknown;
    try {
      next = await dependencies.readPermissionStatus();
    } catch (error) {
      readError = error;
      next = "error";
    }
    if (requestedRevision !== revision) return;
    if (next === "error" && status !== "error") {
      console.warn("Failed to read reminder notification permissions", readError);
    }
    publish(next);
  };

  return {
    getSnapshot: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    refreshIfObserved() {
      if (listeners.size > 0) void refresh();
    },
    openSystemSettings(): Promise<boolean> {
      if (openingSettings) return openingSettings;
      const requestedRevision = ++revision;
      const opening = (async () => {
        try {
          await dependencies.openSystemSettings();
          return true;
        } catch (error) {
          if (requestedRevision === revision) {
            if (status !== "error") {
              console.warn("Failed to open system notification settings", error);
            }
            publish("error");
          }
          return false;
        }
      })();
      const tracked = opening.finally(() => {
        if (openingSettings === tracked) openingSettings = null;
      });
      openingSettings = tracked;
      return tracked;
    },
  };
}
