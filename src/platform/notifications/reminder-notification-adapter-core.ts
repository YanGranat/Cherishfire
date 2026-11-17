import { format } from "date-fns/format";
import type { ReminderSchedulingJournal } from "@/platform/notifications/reminder-scheduling-journal";
import type {
  ReminderNativeScheduleInput,
  ReminderNotificationPort,
  ReminderPermissionStatus,
  ScheduledHabitReminder,
} from "@/application/reminders/reminder-ports";

const REMINDER_NOTIFICATION_KIND = "habit-reminder-v1";
const REMINDER_ANDROID_CHANNEL_ID = "habit-reminders";
export const IOS_PENDING_REMINDER_LIMIT = 64;
export const ANDROID_PENDING_REMINDER_LIMIT = 500;
const HANDLED_REMINDER_RESPONSE_IDENTIFIER_LIMIT = 64;
const processHandledResponseIdentifiers = new Set<string>();

function rememberBoundedProcessResponseIdentifier(identifier: string): boolean {
  const wasHandled = processHandledResponseIdentifiers.delete(identifier);
  processHandledResponseIdentifiers.add(identifier);
  while (
    processHandledResponseIdentifiers.size >
    HANDLED_REMINDER_RESPONSE_IDENTIFIER_LIMIT
  ) {
    const oldestIdentifier = processHandledResponseIdentifiers
      .values()
      .next().value;
    if (oldestIdentifier == null) break;
    processHandledResponseIdentifiers.delete(oldestIdentifier);
  }
  return wasHandled;
}

interface NativeNotificationResponse {
  readonly notification: {
    readonly request: {
      readonly identifier: string;
      readonly content: {
        readonly data: unknown;
      };
    };
  };
}

interface NativeNotificationPermissionStatus {
  readonly granted: boolean;
  readonly status?: string;
  readonly ios?: {
    readonly status: number;
  };
}

export interface ReminderNotificationsNativeModule {
  readonly AndroidImportance: { readonly HIGH: number };
  readonly AndroidNotificationVisibility: { readonly PUBLIC: number };
  readonly IosAuthorizationStatus: { readonly PROVISIONAL: number };
  readonly SchedulableTriggerInputTypes: { readonly DATE: string };
  addNotificationResponseReceivedListener(
    listener: (response: NativeNotificationResponse) => void,
  ): { remove(): void };
  cancelScheduledNotificationAsync(identifier: string): Promise<void>;
  clearLastNotificationResponse(): void;
  getAllScheduledNotificationsAsync(): Promise<
    readonly {
      readonly identifier: string;
      readonly content: { readonly data: unknown };
    }[]
  >;
  getLastNotificationResponse(): NativeNotificationResponse | null;
  getPermissionsAsync(): Promise<NativeNotificationPermissionStatus>;
  requestPermissionsAsync(options: {
    readonly ios: {
      readonly allowAlert: true;
      readonly allowSound: true;
      readonly allowBadge: false;
    };
  }): Promise<NativeNotificationPermissionStatus>;
  scheduleNotificationAsync(request: {
    readonly identifier: string;
    readonly content: {
      readonly title: string;
      readonly body: string;
      readonly sound: "default";
      readonly data: {
        readonly kind: typeof REMINDER_NOTIFICATION_KIND;
        readonly habitId: number;
        readonly date: string;
        readonly scheduleKey: string;
      };
    };
    readonly trigger: {
      readonly type: string;
      readonly date: Date;
      readonly channelId?: string;
    };
  }): Promise<string>;
  setNotificationChannelAsync(
    identifier: string,
    channel: {
      readonly name: string;
      readonly importance: number;
      readonly vibrationPattern: readonly number[];
      readonly sound: "default";
      readonly lockscreenVisibility: number;
    },
  ): Promise<unknown>;
  setNotificationHandler(handler: {
    readonly handleNotification: () => Promise<{
      readonly shouldShowAlert: true;
      readonly shouldShowBanner: true;
      readonly shouldShowList: true;
      readonly shouldPlaySound: true;
      readonly shouldSetBadge: false;
    }>;
  }): void;
}

export interface ReminderNotificationAdapterDependencies {
  readonly platform: string;
  loadModule(): Promise<ReminderNotificationsNativeModule>;
  createNotificationIdentifier(): string;
  readonly schedulingJournal: ReminderSchedulingJournal;
  readonly copy: {
    channelName(): string;
    notificationTitle(): string;
    notificationBody(habitName: string): string;
  };
}

function toReminderDataHabitId(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.kind !== REMINDER_NOTIFICATION_KIND) return null;
  const rawHabitId = record.habitId;
  if (typeof rawHabitId === "number" && Number.isFinite(rawHabitId)) {
    return rawHabitId;
  }
  if (typeof rawHabitId === "string" && rawHabitId.trim().length > 0) {
    const parsed = Number(rawHabitId);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toReminderDataScheduleKey(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>).scheduleKey;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function createReminderNotificationAdapter(
  dependencies: ReminderNotificationAdapterDependencies,
): ReminderNotificationPort {
  interface ResponseSubscriber {
    readonly onOpenMainScreen: () => void;
    readonly handledResponseIdentifiers: Set<string>;
  }

  let runtimeConfigured = false;
  let runtimeConfigurePromise: Promise<boolean> | null = null;
  let permissionRequestPromise: Promise<boolean> | null = null;
  let moduleCache: ReminderNotificationsNativeModule | null | undefined;
  let modulePromise: Promise<ReminderNotificationsNativeModule | null> | null =
    null;
  let schedulingQueue: Promise<void> = Promise.resolve();
  let pendingSchedulingIdentifiers: readonly string[] | null | undefined;
  const responseSubscribers = new Map<number, ResponseSubscriber>();
  let nextResponseSubscriberId = 1;
  let nativeResponseSubscription: { remove(): void } | null = null;
  let nativeResponseListenerInstallInProgress = false;

  function runSchedulingOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = schedulingQueue.then(operation);
    schedulingQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async function recoverPendingScheduling(
    module: ReminderNotificationsNativeModule,
  ): Promise<void> {
    if (pendingSchedulingIdentifiers === undefined) {
      pendingSchedulingIdentifiers = await dependencies.schedulingJournal.read();
    }
    if (pendingSchedulingIdentifiers === null) {
      const requests = await module.getAllScheduledNotificationsAsync();
      for (const request of requests) {
        if (toReminderDataHabitId(request.content.data) != null) {
          await module.cancelScheduledNotificationAsync(request.identifier);
        }
      }
      await dependencies.schedulingJournal.write([]);
      pendingSchedulingIdentifiers = [];
      return;
    }
    if (pendingSchedulingIdentifiers.length === 0) return;
    const requests = await module.getAllScheduledNotificationsAsync();
    const requestsByIdentifier = new Map(
      requests.map((request) => [request.identifier, request]),
    );
    for (const identifier of pendingSchedulingIdentifiers) {
      const request = requestsByIdentifier.get(identifier);
      if (request && toReminderDataHabitId(request.content.data) == null) {
        continue;
      }
      await module.cancelScheduledNotificationAsync(identifier);
    }
    await dependencies.schedulingJournal.write([]);
    pendingSchedulingIdentifiers = [];
  }

  function getHabitReminderScheduleKey(
    input: ReminderNativeScheduleInput,
  ): string {
    // The key describes every user-visible/native scheduling input. A change
    // to time, habit name or localized copy replaces only the affected native
    // request; an identical reconciliation performs no native mutations.
    return JSON.stringify([
      2,
      input.habitId,
      input.date.getTime(),
      input.habitName,
      dependencies.copy.notificationTitle(),
      dependencies.copy.notificationBody(input.habitName),
    ]);
  }

  function handleResponse(
    module: ReminderNotificationsNativeModule,
    response: NativeNotificationResponse | null,
  ): void {
    if (!response || responseSubscribers.size === 0) return;
    const request = response.notification.request;
    if (toReminderDataHabitId(request.content.data) == null) return;

    const freshSubscribers: ResponseSubscriber[] = [];
    for (const subscriber of responseSubscribers.values()) {
      if (subscriber.handledResponseIdentifiers.has(request.identifier)) {
        continue;
      }
      subscriber.handledResponseIdentifiers.add(request.identifier);
      freshSubscribers.push(subscriber);
    }
    if (freshSubscribers.length === 0) return;

    const wasHandledInThisProcess = rememberBoundedProcessResponseIdentifier(
      request.identifier,
    );
    if (!wasHandledInThisProcess) {
      try {
        // Overlapping root owners are possible briefly during a remount. One
        // response is one navigation intent, so the oldest still-live owner
        // handles it while every owner records the identifier for exact local
        // deduplication.
        freshSubscribers[0]?.onOpenMainScreen();
      } catch {}
    }

    try {
      module.clearLastNotificationResponse();
    } catch {
      // Clearing is best-effort. The bounded process cache prevents a stale
      // cold response from reopening Home after a root remount.
    }
  }

  function ensureResponseListenerForModule(
    module: ReminderNotificationsNativeModule,
  ): void {
    if (
      responseSubscribers.size === 0 ||
      nativeResponseSubscription !== null ||
      nativeResponseListenerInstallInProgress
    ) {
      return;
    }

    nativeResponseListenerInstallInProgress = true;
    try {
      try {
        const installedSubscription =
          module.addNotificationResponseReceivedListener((response) => {
            handleResponse(module, response);
          });
        nativeResponseSubscription = installedSubscription;
        if (responseSubscribers.size === 0) {
          try {
            installedSubscription.remove();
            if (nativeResponseSubscription === installedSubscription) {
              nativeResponseSubscription = null;
            }
          } catch {}
        }
      } catch {}

      // Read the cold response after attempting live registration. Even when
      // native listener installation fails transiently, the already available
      // launch response must still be delivered. A later explicit adapter
      // operation retries installation once; there is no self-scheduled loop.
      try {
        handleResponse(module, module.getLastNotificationResponse());
      } catch {
        // Some runtimes do not expose a synchronous last response.
      }
    } finally {
      nativeResponseListenerInstallInProgress = false;
    }
  }

  async function getModule(): Promise<ReminderNotificationsNativeModule | null> {
    if (dependencies.platform === "web") {
      moduleCache = null;
      return null;
    }

    if (moduleCache !== undefined) {
      if (moduleCache) ensureResponseListenerForModule(moduleCache);
      return moduleCache;
    }
    if (modulePromise) return modulePromise;

    modulePromise = dependencies
      .loadModule()
      .then((module) => {
        moduleCache = module;
        ensureResponseListenerForModule(module);
        return module;
      })
      .catch((error) => {
        // A native loader failure is transient. Keep the cache unresolved so
        // the next explicit synchronization attempt can retry in this process.
        throw error;
      })
      .finally(() => {
        modulePromise = null;
      });

    return modulePromise;
  }

  async function configureAndroidChannel(
    module: ReminderNotificationsNativeModule,
  ): Promise<void> {
    if (dependencies.platform !== "android") return;
    await module.setNotificationChannelAsync(REMINDER_ANDROID_CHANNEL_ID, {
      name: dependencies.copy.channelName(),
      importance: module.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 120, 200],
      sound: "default",
      lockscreenVisibility: module.AndroidNotificationVisibility.PUBLIC,
    });
  }

  async function configure(options?: {
    refreshAndroidChannel?: boolean;
  }): Promise<boolean> {
    if (runtimeConfigured) {
      const module = await getModule();
      if (!module) return false;
      if (options?.refreshAndroidChannel) {
        await configureAndroidChannel(module);
      }
      return true;
    }
    if (runtimeConfigurePromise) return runtimeConfigurePromise;

    runtimeConfigurePromise = (async () => {
      const module = await getModule();
      if (!module) return false;

      module.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });
      await configureAndroidChannel(module);
      runtimeConfigured = true;
      return true;
    })()
      .catch((error) => {
        // `false` is reserved for an intentionally unsupported runtime.
        // Reject operational failures so the application queue keeps native
        // reconciliation dirty until a later explicit retry succeeds.
        throw error;
      })
      .finally(() => {
        runtimeConfigurePromise = null;
      });

    return runtimeConfigurePromise;
  }

  function isPermissionGranted(
    module: ReminderNotificationsNativeModule,
    permission: NativeNotificationPermissionStatus,
  ): boolean {
    if (permission.granted) return true;
    return permission.ios?.status === module.IosAuthorizationStatus.PROVISIONAL;
  }

  async function hasPermission(): Promise<boolean> {
    const module = await getModule();
    if (!module) return false;
    const current = await module.getPermissionsAsync();
    return isPermissionGranted(module, current);
  }

  async function readPermissionStatus(): Promise<ReminderPermissionStatus> {
    const module = await getModule();
    if (!module) return "unavailable";
    const permission = await module.getPermissionsAsync();
    if (isPermissionGranted(module, permission)) return "granted";
    return permission.status === "denied" ? "denied" : "undetermined";
  }

  async function requestPermission(): Promise<boolean> {
    if (permissionRequestPromise) return permissionRequestPromise;

    permissionRequestPromise = (async () => {
      const module = await getModule();
      if (!module) return false;

      const current = await module.getPermissionsAsync();
      if (isPermissionGranted(module, current)) return true;

      const requested = await module.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowSound: true,
          allowBadge: false,
        },
      });

      return isPermissionGranted(module, requested);
    })().finally(() => {
      permissionRequestPromise = null;
    });

    return permissionRequestPromise;
  }

  async function listScheduledHabitReminders(): Promise<
    Map<number, ScheduledHabitReminder[]>
  > {
    return runSchedulingOperation(async () => {
      const module = await getModule();
      if (!module) return new Map();
      await recoverPendingScheduling(module);

      const requests = await module.getAllScheduledNotificationsAsync();
      const byHabit = new Map<number, ScheduledHabitReminder[]>();
      for (const request of requests) {
        const habitId = toReminderDataHabitId(request.content.data);
        if (habitId == null) continue;
        const scheduled = {
          identifier: request.identifier,
          habitId,
          scheduleKey: toReminderDataScheduleKey(request.content.data),
        };
        const existing = byHabit.get(habitId);
        if (existing) existing.push(scheduled);
        else byHabit.set(habitId, [scheduled]);
      }
      return byHabit;
    });
  }

  async function scheduleHabitReminder(
    input: ReminderNativeScheduleInput,
  ): Promise<void> {
    return runSchedulingOperation(async () => {
      const module = await getModule();
      if (!module) return;
      await recoverPendingScheduling(module);

      const identifier = dependencies.createNotificationIdentifier();
      // Native scheduling can persist a request before admitting its alarm.
      await dependencies.schedulingJournal.write([identifier]);
      pendingSchedulingIdentifiers = [identifier];
      try {
        await module.scheduleNotificationAsync({
          identifier,
          content: {
            title: dependencies.copy.notificationTitle(),
            body: dependencies.copy.notificationBody(input.habitName),
            sound: "default",
            data: {
              kind: REMINDER_NOTIFICATION_KIND,
              habitId: input.habitId,
              date: format(input.date, "yyyy-MM-dd"),
              scheduleKey: getHabitReminderScheduleKey(input),
            },
          },
          trigger: {
            type: module.SchedulableTriggerInputTypes.DATE,
            date: input.date,
            ...(dependencies.platform === "android"
              ? { channelId: REMINDER_ANDROID_CHANNEL_ID }
              : {}),
          },
        });
      } catch (error) {
        try {
          await module.cancelScheduledNotificationAsync(identifier);
          await dependencies.schedulingJournal.write([]);
          pendingSchedulingIdentifiers = [];
        } catch {
          // The durable identifier remains quarantined until native cleanup succeeds.
        }
        throw error;
      }
      await dependencies.schedulingJournal.write([]);
      pendingSchedulingIdentifiers = [];
    });
  }

  function subscribeToResponses(onOpenMainScreen: () => void): () => void {
    const subscriberId = nextResponseSubscriberId;
    nextResponseSubscriberId += 1;
    responseSubscribers.set(subscriberId, {
      onOpenMainScreen,
      handledResponseIdentifiers: new Set<string>(),
    });

    // Keep a final rejection boundary even if the loader changes later.
    void getModule().catch(() => undefined);

    return () => {
      if (!responseSubscribers.delete(subscriberId)) return;
      if (responseSubscribers.size > 0 || nativeResponseSubscription === null) {
        return;
      }
      const subscription = nativeResponseSubscription;
      try {
        subscription.remove();
        if (nativeResponseSubscription === subscription) {
          nativeResponseSubscription = null;
        }
      } catch {}
    };
  }

  return {
    pendingReminderLimit:
      dependencies.platform === "ios"
        ? IOS_PENDING_REMINDER_LIMIT
        : dependencies.platform === "android"
          ? ANDROID_PENDING_REMINDER_LIMIT
          : null,
    configure,
    hasPermission,
    readPermissionStatus,
    requestPermission,
    getHabitReminderScheduleKey,
    listScheduledHabitReminders,
    async cancelScheduledReminder(identifier) {
      return runSchedulingOperation(async () => {
        const module = await getModule();
        if (!module) return;
        await recoverPendingScheduling(module);
        await module.cancelScheduledNotificationAsync(identifier);
      });
    },
    scheduleHabitReminder,
    subscribeToResponses,
  };
}
