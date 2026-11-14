import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Habit } from "../src/types/habit";
import { DeferredReminderWorkCoordinator } from "../src/application/reminders/deferred-reminder-work-coordinator";
import {
  createReminderService,
  type ReminderService,
} from "../src/application/reminders/reminder-service";
import type {
  ReminderDeferredWorkHandle,
  ReminderNotificationPort,
  ScheduledHabitReminder,
} from "../src/application/reminders/reminder-ports";
import { ReminderReplacementGate } from "../src/application/reminders/reminder-replacement-gate";
import { createReminderSnapshotReader } from "../src/application/reminders/reminder-snapshot";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import { SETTINGS_KEYS } from "../src/types/settings";
import {
  buildUpcomingReminderDates,
  REMINDER_MAX_PER_HABIT,
} from "../src/domain/reminders/reminder-schedule";
import { buildReminderSyncSignature } from "../src/domain/reminders/reminder-sync-signature";
import { removeReminderTimeIntent } from "../src/domain/reminders/reminder-time";
import {
  createReminderNotificationAdapter,
  IOS_PENDING_REMINDER_LIMIT,
  type ReminderNotificationsNativeModule,
} from "../src/platform/notifications/reminder-notification-adapter-core";

const projectRoot = resolve(import.meta.dirname, "..");

function readProjectFile(relativePath: string): string {
  return readFileSync(resolve(projectRoot, relativePath), "utf8");
}

function sourceSection(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const reminderScreenSource = readProjectFile(
  "src/features/habit-form/components/ReminderScreen.tsx",
);
const reminderPermissionServiceSource = readProjectFile(
  "src/application/reminders/reminder-service.ts",
);
const habitStoreSource = readProjectFile("src/stores/habit-store.ts");
const explicitPermissionBranchSource = sourceSection(
  reminderPermissionServiceSource,
  "let explicitPermissionGranted: boolean | null = null;",
  "const granted =",
);
assert.equal(
  [
    ...reminderPermissionServiceSource.matchAll(
      /notifications\.requestPermission\(\)/g,
    ),
  ].length,
  1,
  "only the explicit full-sync intent may request notification permission",
);
assert.match(
  explicitPermissionBranchSource,
  /if \(request\.requestPermission\)[\s\S]*notifications\.requestPermission\(\)/,
  "the native permission sheet must remain guarded by an explicit reminder intent",
);
assert.match(
  explicitPermissionBranchSource,
  /if \(request\.requestPermission\)[\s\S]*settledPermissionRequestRevision = Math\.max\([\s\S]*notifications\.requestPermission\(\)/,
  "one-shot prompt authority must be consumed before the fallible native permission boundary",
);
assert.match(
  habitStoreSource,
  /scheduleHabitRemindersSync\(nextHabits, \{[\s\S]{0,100}requestPermission: input\.reminderEnabled === true/,
  "habit creation may request permission only when that new habit explicitly enables reminders",
);
assert.match(
  habitStoreSource,
  /const requestsReminderPermission =\s*input\.reminderEnabled === true && !reminderEnabledBeforeUpdate/,
  "habit updates may request permission only for an actual disabled-to-enabled transition",
);
assert.doesNotMatch(
  habitStoreSource,
  /requestPermission:\s*true/,
  "background habit mutations must never hard-code a permission prompt",
);
const androidTimePickerSource = sourceSection(
  reminderScreenSource,
  "const openAndroidTimePicker",
  "const updateTimeAtIndex",
);
assert.match(
  androidTimePickerSource,
  /interface AndroidReminderPickerSession|AndroidReminderPickerSession/,
  "the Android time picker must have an explicit generation-owned session",
);
assert.match(
  androidTimePickerSource,
  /const consumeCurrentPickerSession =[\s\S]{0,1200}mountedRef\.current[\s\S]{0,160}visibleRef\.current[\s\S]{0,300}currentSession\?\.generation === pickerSession\.generation[\s\S]{0,300}committedSessionKeyRef\.current === pickerSession\.ownerSessionKey/,
  "late Android picker callbacks must be rejected after unmount, hide, replacement, or editor-session change",
);
assert.match(
  androidTimePickerSource,
  /onError: handleOpenError/,
  "datetimepicker 8.4.4 reports asynchronous native open failures only through onError",
);
assert.ok(
  androidTimePickerSource.indexOf("consumeCurrentPickerSession(") <
    androidTimePickerSource.indexOf('if (event.type === "dismissed")'),
  "the Android generation guard must run before cancel/no-value/product callbacks",
);
assert.match(
  reminderScreenSource,
  /React\.useLayoutEffect\(\(\) => \{\s*mountedRef\.current = true;[\s\S]{0,220}mountedRef\.current = false;[\s\S]{0,120}invalidateAndroidPickerSession\(\)/,
  "unmounting the reminder editor must revoke and dismiss an active native picker",
);
assert.match(
  reminderScreenSource,
  /React\.useLayoutEffect\(\(\) => \{\s*visibleRef\.current = visible;[\s\S]{0,180}if \(!visible\) \{[\s\S]{0,100}invalidateAndroidPickerSession\(\)[\s\S]{0,100}invalidateIOSPickerSession\(\)/,
  "closing or unmounting the reminder editor must dismiss an active native picker",
);
function makeHabit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 1,
    name: "Water",
    description: null,
    descriptionVisible: true,
    repeatSchedule: { type: "daily" },
    scheduleHistory: [
      {
        effectiveFrom: "2026-08-01",
        startDate: "2026-08-01",
        repeatSchedule: { type: "daily" },
      },
    ],
    startDate: "2026-08-01",
    reminderEnabled: true,
    reminderTime: "08:00",
    displayOrder: 0,
    isArchived: false,
    archivedAt: null,
    archiveHistory: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const reminderHabit = makeHabit();
const baseSignature = buildReminderSyncSignature([reminderHabit], true);

const firstRapidRemoval = removeReminderTimeIntent(
  ["08:00", "12:00", "18:00"],
  "08:00",
);
assert.deepEqual(firstRapidRemoval, {
  times: ["12:00", "18:00"],
  removedIndex: 0,
});
const duplicateRapidRemoval = removeReminderTimeIntent(
  firstRapidRemoval.times,
  "08:00",
);
assert.strictEqual(duplicateRapidRemoval.times, firstRapidRemoval.times);
assert.equal(duplicateRapidRemoval.removedIndex, null);
assert.deepEqual(
  removeReminderTimeIntent(firstRapidRemoval.times, "12:00").times,
  ["18:00"],
  "two distinct rapid row intents must remove their named rows, not shifted indices",
);

assert.equal(
  buildReminderSyncSignature(
    [
      {
        ...reminderHabit,
        description: "Unrelated edit",
        descriptionVisible: false,
        displayOrder: 8,
        updatedAt: 999,
      },
      makeHabit({
        id: 2,
        name: "No reminder",
        reminderEnabled: false,
        reminderTime: null,
      }),
    ],
    true,
  ),
  baseSignature,
  "unrelated habit fields and non-reminder habits must not reschedule notifications",
);

assert.notEqual(
  buildReminderSyncSignature([{ ...reminderHabit, name: "Drink water" }], true),
  baseSignature,
  "renaming a reminded habit must refresh notification text",
);
assert.notEqual(
  buildReminderSyncSignature(
    [{ ...reminderHabit, reminderTime: "09:30" }],
    true,
  ),
  baseSignature,
  "changing reminder time must reschedule notifications",
);
assert.notEqual(
  buildReminderSyncSignature(
    [{ ...reminderHabit, repeatSchedule: { type: "weekdays", days: [1, 3] } }],
    true,
  ),
  baseSignature,
  "changing the active repeat schedule must reschedule notifications",
);
assert.notEqual(
  buildReminderSyncSignature(
    [
      {
        ...reminderHabit,
        scheduleHistory: [
          ...(reminderHabit.scheduleHistory ?? []),
          {
            effectiveFrom: "2026-08-20",
            startDate: "2026-08-01",
            repeatSchedule: { type: "interval", every: 2 },
          },
        ],
      },
    ],
    true,
  ),
  baseSignature,
  "schedule history must participate in upcoming reminder dates",
);
assert.notEqual(
  buildReminderSyncSignature([{ ...reminderHabit, isArchived: true }], true),
  baseSignature,
  "archiving a reminded habit must cancel its notifications",
);
assert.equal(
  buildReminderSyncSignature([reminderHabit], false),
  buildReminderSyncSignature(
    [makeHabit({ id: 99, reminderTime: "22:00" })],
    false,
  ),
  "habit edits while the master switch is off must not trigger repeated cancellation",
);
assert.equal(
  buildReminderSyncSignature([makeHabit({ id: 2 }), reminderHabit], true),
  buildReminderSyncSignature([reminderHabit, makeHabit({ id: 2 })], true),
  "habit ordering must not affect the reminder signature",
);

function auditReminderScheduleDates(): void {
  const now = new Date(2026, 7, 29, 7, 30, 0, 0);
  const dates = buildUpcomingReminderDates(
    makeHabit({ reminderTime: '["08:00","09:30"]' }),
    [{ date: "2026-08-30", status: "done" }],
    now,
  );

  assert.equal(
    dates.length,
    60,
    "the inclusive 30-day lookahead must skip completed dates without moving its end date",
  );
  assert.deepEqual(
    [dates[0]?.getHours(), dates[0]?.getMinutes()],
    [8, 0],
    "reminder hours must remain local-time wall-clock values",
  );
  assert.deepEqual(
    [dates[1]?.getHours(), dates[1]?.getMinutes()],
    [9, 30],
    "multiple reminder times must preserve their encoded order",
  );
  assert.equal(
    dates.some(
      (date) =>
        date.getFullYear() === 2026 &&
        date.getMonth() === 7 &&
        date.getDate() === 30,
    ),
    false,
    "a completed scheduled day must not retain a native reminder",
  );

  for (const status of [
    "done",
    "minimum",
    "maximum",
    "skipped",
    "failure",
  ] as const) {
    const handledDates = buildUpcomingReminderDates(
      makeHabit({ reminderTime: '["08:00"]' }),
      [{ date: "2026-08-30", status }],
      now,
    );
    assert.equal(
      handledDates.some(
        (date) =>
          date.getFullYear() === 2026 &&
          date.getMonth() === 7 &&
          date.getDate() === 30,
      ),
      false,
      `${status} must suppress every remaining reminder for the handled date`,
    );
  }

  const capped = buildUpcomingReminderDates(
    makeHabit({ reminderTime: '["08:00","09:30","18:45"]' }),
    [],
    now,
  );
  assert.equal(
    capped.length,
    REMINDER_MAX_PER_HABIT,
    "the per-habit native scheduling cap must remain exact",
  );
  assert.deepEqual(
    buildUpcomingReminderDates(
      makeHabit({ isArchived: true, archivedAt: 1 }),
      [],
      now,
    ),
    [],
    "archived habits must never produce reminder dates",
  );
}

function createManualUiScheduler() {
  const scheduled: { cancelled: boolean; task: () => void }[] = [];
  return {
    scheduled,
    schedule(task: () => void): ReminderDeferredWorkHandle {
      const entry = { cancelled: false, task };
      scheduled.push(entry);
      return {
        cancel() {
          entry.cancelled = true;
        },
      };
    },
  };
}

function createReminderServiceHarness(options?: {
  readonly permissionGranted?: boolean;
  readonly existingByHabit?: ReadonlyMap<number, readonly string[]>;
  readonly configureFailures?: number;
  readonly configureResult?: boolean;
  readonly pendingReminderLimit?: number | null;
  readonly preserveScheduledState?: boolean;
  readonly deferPermissionRequest?: boolean;
  readonly permissionRequestFailures?: number;
  readonly readSnapshot?: () => Promise<{
    habits: Habit[];
    notificationsEnabled: boolean;
  }>;
}) {
  const ui = createManualUiScheduler();
  const nativeEvents: string[] = [];
  const cancelled: string[] = [];
  const scheduled: { habitId: number; date: Date }[] = [];
  let nativeInFlight = 0;
  let maxNativeInFlight = 0;
  let yieldCount = 0;
  let recordReadCount = 0;
  let scheduledListReadCount = 0;
  let permissionCount = 0;
  let permissionGranted = options?.permissionGranted ?? true;
  let permissionRequestCount = 0;
  let permissionRequestFailuresRemaining =
    options?.permissionRequestFailures ?? 0;
  let releasePermissionRequest: (() => void) | null = null;
  let markPermissionRequestStarted!: () => void;
  const permissionRequestStarted = new Promise<void>((resolve) => {
    markPermissionRequestStarted = resolve;
  });
  let configureCount = 0;
  let configureFailuresRemaining = options?.configureFailures ?? 0;
  let timezoneSignature = "Europe/Kyiv:fixed";
  let nextNativeIdentifier = 1;
  let now = new Date(2026, 7, 29, 7, 30, 0, 0);
  let authoritativeHabits: Habit[] = [reminderHabit];
  let authoritativeMaster = true;
  let snapshotReadCount = 0;
  let snapshotReadFailures = 0;
  let cancellationFailures = 0;
  let schedulingFailures = 0;
  let schedulingFailureAfter: number | null = null;
  let records: { habitId: number; date: string; status: string }[] = [];
  const nativeScheduledByHabit = new Map<number, ScheduledHabitReminder[]>();
  if (options?.preserveScheduledState) {
    for (const [habitId, identifiers] of options.existingByHabit ?? []) {
      nativeScheduledByHabit.set(
        habitId,
        identifiers.map((identifier) => ({
          identifier,
          habitId,
          scheduleKey: null,
        })),
      );
    }
  }

  async function nativeMutation(label: string): Promise<void> {
    nativeInFlight += 1;
    maxNativeInFlight = Math.max(maxNativeInFlight, nativeInFlight);
    nativeEvents.push(`${label}:start`);
    await Promise.resolve();
    nativeEvents.push(`${label}:end`);
    nativeInFlight -= 1;
  }

  const notifications: ReminderNotificationPort = {
    pendingReminderLimit: options?.pendingReminderLimit ?? null,
    getHabitReminderScheduleKey(input) {
      return JSON.stringify([
        2,
        input.habitId,
        input.date.getTime(),
        input.habitName,
        "test-copy",
      ]);
    },
    async configure() {
      configureCount += 1;
      if (configureFailuresRemaining > 0) {
        configureFailuresRemaining -= 1;
        throw new Error("expected native configure failure");
      }
      return options?.configureResult ?? true;
    },
    async hasPermission() {
      permissionCount += 1;
      return permissionGranted;
    },
    async requestPermission() {
      permissionRequestCount += 1;
      markPermissionRequestStarted();
      if (permissionRequestFailuresRemaining > 0) {
        permissionRequestFailuresRemaining -= 1;
        throw new Error("expected native permission request failure");
      }
      if (options?.deferPermissionRequest) {
        await new Promise<void>((resolve) => {
          releasePermissionRequest = resolve;
        });
      }
      return permissionGranted;
    },
    async listScheduledHabitReminders() {
      scheduledListReadCount += 1;
      if (options?.preserveScheduledState) {
        return new Map(
          [...nativeScheduledByHabit.entries()].map(([habitId, reminders]) => [
            habitId,
            reminders.map((reminder) => ({ ...reminder })),
          ]),
        );
      }
      const initialByHabit: ReadonlyMap<number, readonly string[]> =
        options?.existingByHabit ?? new Map<number, readonly string[]>();
      return new Map(
        [...initialByHabit.entries()].map(([habitId, identifiers]) => [
          habitId,
          identifiers.map((identifier) => ({
            identifier,
            habitId,
            scheduleKey: null,
          })),
        ]),
      );
    },
    async cancelScheduledReminder(identifier) {
      if (cancellationFailures > 0) {
        cancellationFailures -= 1;
        throw new Error("expected native cancellation failure");
      }
      await nativeMutation(`cancel:${identifier}`);
      cancelled.push(identifier);
      if (options?.preserveScheduledState) {
        for (const [habitId, reminders] of nativeScheduledByHabit) {
          const next = reminders.filter(
            (reminder) => reminder.identifier !== identifier,
          );
          if (next.length > 0) nativeScheduledByHabit.set(habitId, next);
          else nativeScheduledByHabit.delete(habitId);
        }
      }
    },
    async scheduleHabitReminder(input) {
      if (schedulingFailureAfter != null) {
        if (schedulingFailureAfter === 0) {
          schedulingFailureAfter = null;
          throw new Error("expected partial native scheduling failure");
        }
        schedulingFailureAfter -= 1;
      }
      if (schedulingFailures > 0) {
        schedulingFailures -= 1;
        throw new Error("expected native scheduling failure");
      }
      await nativeMutation(`schedule:${input.habitId}`);
      scheduled.push({ habitId: input.habitId, date: input.date });
      if (options?.preserveScheduledState) {
        const reminder = {
          identifier: `new-${nextNativeIdentifier}`,
          habitId: input.habitId,
          scheduleKey: notifications.getHabitReminderScheduleKey(input),
        };
        nextNativeIdentifier += 1;
        const existing = nativeScheduledByHabit.get(input.habitId);
        if (existing) existing.push(reminder);
        else nativeScheduledByHabit.set(input.habitId, [reminder]);
      }
    },
    subscribeToResponses() {
      return () => {};
    },
  };

  const service = createReminderService({
    snapshot: {
      async readSnapshot() {
        snapshotReadCount += 1;
        if (snapshotReadFailures > 0) {
          snapshotReadFailures -= 1;
          throw new Error("expected snapshot read failure");
        }
        return options?.readSnapshot
          ? options.readSnapshot()
          : { habits: authoritativeHabits, notificationsEnabled: authoritativeMaster };
      },
    },
    dayRecords: {
      async readByHabitIds() {
        recordReadCount += 1;
        return records;
      },
    },
    notifications,
    workScheduling: {
      scheduleAfterUiSettles: ui.schedule,
      isAppActive: () => true,
      async yieldToUi() {
        yieldCount += 1;
        await Promise.resolve();
      },
    },
    clock: {
      now: () => now,
      timezoneSignature: () => timezoneSignature,
    },
  });

  return {
    service,
    nativeEvents,
    cancelled,
    scheduled,
    get snapshotReadCount() {
      return snapshotReadCount;
    },
    setSnapshot(habits: Habit[], enabled = true) {
      authoritativeHabits = habits;
      authoritativeMaster = enabled;
    },
    failSnapshotReads(count = 1) {
      snapshotReadFailures = count;
    },
    failCancellations(count = 1) {
      cancellationFailures = count;
    },
    failScheduling(count = 1) {
      schedulingFailures = count;
    },
    failSchedulingAfter(successCount: number) {
      schedulingFailureAfter = successCount;
    },
    setRecords(next: typeof records) {
      records = next;
    },
    setNow(value: Date) {
      now = value;
    },
    pendingSchedules() {
      return [...nativeScheduledByHabit.values()].flat();
    },
    expireBefore(value: Date) {
      for (const [habitId, reminders] of nativeScheduledByHabit) {
        nativeScheduledByHabit.set(habitId, reminders.filter((reminder) => {
          if (!reminder.scheduleKey) return true;
          return Number((JSON.parse(reminder.scheduleKey) as unknown[])[2]) > value.getTime();
        }));
      }
    },
    get maxNativeInFlight() {
      return maxNativeInFlight;
    },
    get yieldCount() {
      return yieldCount;
    },
    get recordReadCount() {
      return recordReadCount;
    },
    get scheduledListReadCount() {
      return scheduledListReadCount;
    },
    get permissionCount() {
      return permissionCount;
    },
    get permissionRequestCount() {
      return permissionRequestCount;
    },
    setPermissionGranted(granted: boolean) {
      permissionGranted = granted;
    },
    permissionRequestStarted,
    releasePermissionRequest() {
      releasePermissionRequest?.();
      releasePermissionRequest = null;
    },
    get configureCount() {
      return configureCount;
    },
    setTimezoneSignature(value: string) {
      timezoneSignature = value;
    },
  };
}

async function runDeferredReminderServiceWork(
  service: ReminderService,
): Promise<void> {
  const boundary = await service.flushAndFreezePendingReminderWork();
  await boundary.release("import-aborted");
}

async function auditReminderServiceBehavior(): Promise<void> {
  const sequential = createReminderServiceHarness({
    existingByHabit: new Map([
      [1, ["old-1", "old-2"]],
      [99, ["orphan"]],
    ]),
  });
  sequential.service.scheduleHabitRemindersSync([
    makeHabit({ reminderTime: '["08:00","09:30"]' }),
  ]);
  await runDeferredReminderServiceWork(sequential.service);
  assert.equal(
    sequential.maxNativeInFlight,
    1,
    "native cancellation and scheduling must remain strictly sequential",
  );
  assert.deepEqual(
    sequential.cancelled,
    ["orphan", "old-1", "old-2"],
    "inactive and replaced reminder IDs must retain their cancellation order",
  );
  assert.ok(
    sequential.scheduled.length > 0,
    "an accepted full job must be visible to an immediate import flush",
  );
  assert.ok(
    sequential.yieldCount > 0,
    "large native rebuilds must cross bounded cooperative yield points",
  );
  const lastCancelEnd = sequential.nativeEvents.reduce(
    (latest, event, index) =>
      event.startsWith("cancel:") && event.endsWith(":end") ? index : latest,
    -1,
  );
  const firstScheduleStart = sequential.nativeEvents.findIndex((event) =>
    event.startsWith("schedule:"),
  );
  assert.ok(
    firstScheduleStart > lastCancelEnd,
    "replacement must finish cancellation before scheduling new requests",
  );

  const exact = createReminderServiceHarness({
    existingByHabit: new Map([[1, ["legacy-without-key"]]]),
    preserveScheduledState: true,
  });
  exact.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(exact.service);
  assert.deepEqual(
    exact.cancelled,
    ["legacy-without-key"],
    "a pre-key native request must be replaced once",
  );
  const exactCancelledAfterMigration = exact.cancelled.length;
  const exactScheduledAfterMigration = exact.scheduled.length;
  exact.service.scheduleHabitReminderAfterRecordChange(
    [reminderHabit],
    reminderHabit.id,
  );
  await runDeferredReminderServiceWork(exact.service);
  assert.equal(
    exact.cancelled.length,
    exactCancelledAfterMigration,
    "an unchanged record repair must keep matching native requests",
  );
  assert.equal(
    exact.scheduled.length,
    exactScheduledAfterMigration,
    "an unchanged record repair must not rebuild matching native requests",
  );

  const denied = createReminderServiceHarness({
    permissionGranted: false,
    existingByHabit: new Map([[1, ["keep-when-denied"]]]),
  });
  denied.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(denied.service);
  assert.deepEqual(
    denied.cancelled,
    ["keep-when-denied"],
    "permission denial must remove requests outside the exact current plan",
  );
  assert.equal(denied.recordReadCount, 1);
  assert.equal(denied.scheduled.length, 0);
  assert.equal(
    denied.scheduledListReadCount,
    1,
    "denied delivery permission must not block obsolete native request cleanup",
  );
  assert.equal(
    denied.permissionRequestCount,
    0,
    "background reconciliation must never present notification permission UI",
  );
  const deniedPassiveCheckCount = denied.permissionCount;
  denied.service.scheduleHabitRemindersSync([
    reminderHabit,
    makeHabit({
      id: 2,
      reminderEnabled: false,
      reminderTime: null,
    }),
  ]);
  await runDeferredReminderServiceWork(denied.service);
  assert.equal(
    denied.permissionCount,
    deniedPassiveCheckCount,
    "a denied permission state must settle an unchanged reminder signature instead of creating a retry queue",
  );
  assert.equal(denied.permissionRequestCount, 0);

  const explicitDenied = createReminderServiceHarness({
    permissionGranted: false,
  });
  explicitDenied.service.scheduleHabitRemindersSync([reminderHabit], {
    requestPermission: true,
  });
  await runDeferredReminderServiceWork(explicitDenied.service);
  assert.equal(
    explicitDenied.permissionRequestCount,
    1,
    "an explicit reminder-enable intent must own exactly one permission request",
  );
  const explicitDeniedCheckCount = explicitDenied.permissionCount;
  explicitDenied.service.scheduleHabitRemindersSync([
    reminderHabit,
    makeHabit({
      id: 2,
      reminderEnabled: false,
      reminderTime: null,
    }),
  ]);
  await runDeferredReminderServiceWork(explicitDenied.service);
  assert.equal(explicitDenied.permissionRequestCount, 1);
  assert.equal(
    explicitDenied.scheduledListReadCount,
    1,
    "an explicitly denied request must still inspect stale native schedules once",
  );
  assert.equal(
    explicitDenied.permissionCount,
    explicitDeniedCheckCount,
    "creating an unrelated habit after denial must neither prompt nor restart the settled sync",
  );
  explicitDenied.setPermissionGranted(true);
  await explicitDenied.service.refreshReminderNotificationTimezone();
  assert.equal(
    explicitDenied.permissionRequestCount,
    1,
    "returning from system settings must detect an external grant passively",
  );
  assert.ok(
    explicitDenied.scheduled.length > 0,
    "an externally granted permission must reconcile the previously denied reminder",
  );

  const failedExplicitRequest = createReminderServiceHarness({
    permissionGranted: false,
    permissionRequestFailures: 1,
  });
  failedExplicitRequest.service.scheduleHabitRemindersSync([reminderHabit], {
    requestPermission: true,
  });
  await runDeferredReminderServiceWork(failedExplicitRequest.service);
  assert.equal(failedExplicitRequest.permissionRequestCount, 1);
  failedExplicitRequest.service.scheduleHabitRemindersSync([
    reminderHabit,
    makeHabit({ id: 2, name: "Unrelated", reminderEnabled: false }),
  ]);
  await runDeferredReminderServiceWork(failedExplicitRequest.service);
  assert.equal(
    failedExplicitRequest.permissionRequestCount,
    1,
    "a failed native permission request must consume its one-shot user authority instead of replaying from background repair",
  );
  assert.ok(
    failedExplicitRequest.permissionCount > 0,
    "background repair after a failed explicit request must use a passive permission check",
  );

  const explicitRaced = createReminderServiceHarness({
    permissionGranted: false,
    deferPermissionRequest: true,
  });
  explicitRaced.service.scheduleHabitRemindersSync([reminderHabit], {
    requestPermission: true,
  });
  explicitRaced.service.startPendingReminderWorkBeforeBackground();
  await explicitRaced.permissionRequestStarted;
  explicitRaced.service.scheduleHabitRemindersSync([
    reminderHabit,
    makeHabit({ id: 2, name: "Unrelated", reminderEnabled: false }),
  ]);
  explicitRaced.service.startPendingReminderWorkBeforeBackground();
  explicitRaced.releasePermissionRequest();
  await runDeferredReminderServiceWork(explicitRaced.service);
  assert.equal(
    explicitRaced.permissionRequestCount,
    1,
    "a newer background sync racing a system permission sheet must not present the same request again",
  );

  const globallyLimited = createReminderServiceHarness({
    pendingReminderLimit: IOS_PENDING_REMINDER_LIMIT,
    existingByHabit: new Map([
      [1, ["limited-old-1"]],
      [2, ["limited-old-2"]],
    ]),
  });
  globallyLimited.service.scheduleHabitRemindersSync([
    makeHabit({ id: 1, name: "First", reminderTime: '["08:00","09:30"]' }),
    makeHabit({ id: 2, name: "Second", reminderTime: '["08:00","09:30"]' }),
  ]);
  await runDeferredReminderServiceWork(globallyLimited.service);
  assert.equal(
    globallyLimited.scheduled.length,
    IOS_PENDING_REMINDER_LIMIT,
    "an iOS-style global pending limit must cap the complete app plan, not each habit independently",
  );
  assert.deepEqual(
    new Set(globallyLimited.scheduled.map((entry) => entry.habitId)),
    new Set([1, 2]),
    "the global earliest plan must not let the first habit monopolize iOS notification slots",
  );
  assert.ok(
    globallyLimited.scheduled.every(
      (entry, index, plan) =>
        index === 0 ||
        (plan[index - 1]?.date.getTime() ?? 0) <= entry.date.getTime(),
    ),
    "globally limited reminders must be installed in chronological order",
  );
  const globallyLimitedLastCancel = globallyLimited.nativeEvents.reduce(
    (latest, event, index) =>
      event.startsWith("cancel:") && event.endsWith(":end") ? index : latest,
    -1,
  );
  const globallyLimitedFirstSchedule = globallyLimited.nativeEvents.findIndex(
    (event) => event.startsWith("schedule:"),
  );
  assert.ok(
    globallyLimitedFirstSchedule > globallyLimitedLastCancel,
    "the global iOS replacement must cancel every old active request before installing the new 64-slot plan",
  );

  const scheduledBeforeLimitedRecordChange = globallyLimited.scheduled.length;
  globallyLimited.service.scheduleHabitReminderAfterRecordChange(
    [
      makeHabit({ id: 1, name: "First", reminderTime: '["08:00","09:30"]' }),
      makeHabit({ id: 2, name: "Second", reminderTime: '["08:00","09:30"]' }),
    ],
    1,
  );
  await runDeferredReminderServiceWork(globallyLimited.service);
  assert.deepEqual(
    new Set(
      globallyLimited.scheduled
        .slice(scheduledBeforeLimitedRecordChange)
        .map((entry) => entry.habitId),
    ),
    new Set([1, 2]),
    "a record change under the iOS global cap must refill the complete cross-habit plan",
  );

  const disabled = createReminderServiceHarness({
    existingByHabit: new Map([
      [1, ["disabled-1"]],
      [2, ["disabled-2"]],
    ]),
  });
  await disabled.service.setReminderNotificationsEnabled(false);
  assert.deepEqual(disabled.cancelled, ["disabled-1", "disabled-2"]);
  assert.equal(
    disabled.permissionCount,
    0,
    "master-disable cancellation must not request notification permission",
  );

  const disabledExplicitHabit = createReminderServiceHarness({
    permissionGranted: false,
  });
  await disabledExplicitHabit.service.setReminderNotificationsEnabled(false);
  disabledExplicitHabit.service.scheduleHabitRemindersSync([reminderHabit], {
    requestPermission: true,
  });
  await runDeferredReminderServiceWork(disabledExplicitHabit.service);
  await disabledExplicitHabit.service.setReminderNotificationsEnabled(true);
  assert.equal(
    disabledExplicitHabit.permissionRequestCount,
    0,
    "a reminder enabled while the global master is off must not leak prompt authority into a later passive restore",
  );

  const passiveMasterRestore = createReminderServiceHarness({
    permissionGranted: false,
  });
  passiveMasterRestore.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(passiveMasterRestore.service);
  await passiveMasterRestore.service.setReminderNotificationsEnabled(false);
  await passiveMasterRestore.service.setReminderNotificationsEnabled(true);
  assert.equal(
    passiveMasterRestore.permissionRequestCount,
    0,
    "load, repair and rollback of an enabled master setting must remain passive",
  );

  const latest = createReminderServiceHarness();
  latest.service.scheduleHabitRemindersSync([
    makeHabit({ id: 1, name: "stale" }),
  ]);
  latest.service.startPendingReminderWorkBeforeBackground();
  latest.service.scheduleHabitRemindersSync([
    makeHabit({ id: 2, name: "latest" }),
  ]);
  latest.service.startPendingReminderWorkBeforeBackground();
  await runDeferredReminderServiceWork(latest.service);
  assert.deepEqual(
    new Set(latest.scheduled.map((entry) => entry.habitId)),
    new Set([2]),
    "a newer full-sync revision must be the sole owner of final native state",
  );

  const recordBatch = createReminderServiceHarness();
  const recordBatchHabits = [
    makeHabit({ id: 1, name: "First" }),
    makeHabit({ id: 2, name: "Second" }),
  ];
  recordBatch.service.scheduleHabitReminderAfterRecordChange(
    recordBatchHabits,
    1,
  );
  recordBatch.service.scheduleHabitReminderAfterRecordChange(
    recordBatchHabits,
    2,
  );
  await runDeferredReminderServiceWork(recordBatch.service);
  assert.equal(
    recordBatch.scheduledListReadCount,
    1,
    "one admitted record batch must read the native schedule only once",
  );
  assert.equal(
    recordBatch.permissionCount,
    1,
    "one admitted record batch must check notification permission only once",
  );
  assert.equal(
    recordBatch.recordReadCount,
    1,
    "one admitted record batch must read all affected habit records together",
  );
  assert.deepEqual(
    new Set(recordBatch.scheduled.map((entry) => entry.habitId)),
    new Set([1, 2]),
    "batching must preserve reminder replacement for every affected habit",
  );
  const deniedRecordBatch = createReminderServiceHarness({
    permissionGranted: false,
    existingByHabit: new Map([[1, ["keep-after-denied-record-change"]]]),
  });
  deniedRecordBatch.service.scheduleHabitReminderAfterRecordChange(
    [reminderHabit],
    reminderHabit.id,
  );
  await runDeferredReminderServiceWork(deniedRecordBatch.service);
  assert.equal(deniedRecordBatch.permissionCount, 1);
  assert.equal(
    deniedRecordBatch.scheduledListReadCount,
    1,
    "a denied record repair must inspect stale native schedules",
  );
  assert.equal(deniedRecordBatch.recordReadCount, 1);
  assert.deepEqual(deniedRecordBatch.cancelled, ["keep-after-denied-record-change"]);
  assert.deepEqual(deniedRecordBatch.scheduled, []);

  const imported = createReminderServiceHarness();
  const importBoundary =
    await imported.service.flushAndFreezePendingReminderWork();
  imported.service.scheduleHabitRemindersSync([
    makeHabit({ id: 3, name: "pre-import" }),
  ]);
  await importBoundary.release("import-committed");
  imported.setSnapshot([makeHabit({ id: 4, name: "imported" })]);
  await imported.service.reconcileReminderNotificationsAfterImport();
  assert.deepEqual(
    new Set(imported.scheduled.map((entry) => entry.habitId)),
    new Set([4]),
    "committed import must discard buffered old work and rebuild exact published state",
  );

  const timezone = createReminderServiceHarness();
  timezone.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(timezone.service);
  const configureCountBeforeRefresh = timezone.configureCount;
  timezone.setTimezoneSignature("Europe/Kyiv:changed-offset");
  await timezone.service.refreshReminderNotificationTimezone();
  assert.ok(
    timezone.configureCount > configureCountBeforeRefresh,
    "a changed clock-port timezone signature must force a fresh rebuild",
  );

  const failedToggle = createReminderServiceHarness({
    configureFailures: 1,
    existingByHabit: new Map([[1, ["retry-disabled"]]]),
  });
  await assert.rejects(
    failedToggle.service.setReminderNotificationsEnabled(false),
    /reconciliation failed/,
  );
  assert.equal(failedToggle.cancelled.length, 0);
  await failedToggle.service.setReminderNotificationsEnabled(false);
  assert.deepEqual(
    failedToggle.cancelled,
    ["retry-disabled"],
    "the same reminder setting must retry after an actual native failure",
  );

  const foregroundRepair = createReminderServiceHarness({
    configureFailures: 1,
    existingByHabit: new Map([[1, ["retry-on-foreground"]]]),
  });
  await assert.rejects(
    foregroundRepair.service.setReminderNotificationsEnabled(false),
  );
  await foregroundRepair.service.refreshReminderNotificationTimezone();
  assert.deepEqual(
    foregroundRepair.cancelled,
    ["retry-on-foreground"],
    "an unchanged timezone foreground pass must repair uncertain native state",
  );

  const deferredFullRepair = createReminderServiceHarness({
    configureFailures: 1,
  });
  deferredFullRepair.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(deferredFullRepair.service);
  assert.equal(
    deferredFullRepair.scheduled.length,
    0,
    "a transient deferred full-sync failure must not publish a partial schedule",
  );
  await deferredFullRepair.service.refreshReminderNotificationTimezone();
  assert.ok(
    deferredFullRepair.scheduled.length > 0,
    "a transient deferred full-sync failure must remain dirty for the next explicit foreground repair",
  );

  const failedImport = createReminderServiceHarness({ configureFailures: 1 });
  await (await failedImport.service.flushAndFreezePendingReminderWork()).release("import-committed");
  await assert.rejects(
    failedImport.service.reconcileReminderNotificationsAfterImport(),
    /import reconciliation failed/,
  );
  await failedImport.service.refreshReminderNotificationTimezone();
  assert.ok(
    failedImport.scheduled.length > 0,
    "foreground reconciliation must repair a failed committed-import effect",
  );
  const configureCountAfterRepair = failedImport.configureCount;
  await failedImport.service.refreshReminderNotificationTimezone();
  assert.equal(
    failedImport.configureCount,
    configureCountAfterRepair,
    "a repaired native state must not enter a foreground retry loop",
  );

  const failedChannelRefresh = createReminderServiceHarness({
    configureFailures: 1,
    existingByHabit: new Map([[1, ["must-not-cancel-before-load"]]]),
  });
  failedChannelRefresh.service.scheduleReminderNotificationLocalizationRefresh();
  await runDeferredReminderServiceWork(failedChannelRefresh.service);
  await failedChannelRefresh.service.refreshReminderNotificationTimezone();
  assert.deepEqual(
    failedChannelRefresh.cancelled,
    [],
    "a channel-only retry before habits load must not infer an empty authoritative habit set",
  );

  const supersededFailure = createReminderServiceHarness({
    configureFailures: 1,
  });
  await assert.rejects(
    supersededFailure.service.setReminderNotificationsEnabled(false),
  );
  await supersededFailure.service.setReminderNotificationsEnabled(true);
  const configureCountAfterNewIntent = supersededFailure.configureCount;
  await supersededFailure.service.refreshReminderNotificationTimezone();
  assert.equal(
    supersededFailure.configureCount,
    configureCountAfterNewIntent,
    "a newer successful setting intent must retire the older failed state",
  );

  const deniedImport = createReminderServiceHarness({
    permissionGranted: false,
  });
  await (await deniedImport.service.flushAndFreezePendingReminderWork()).release("import-committed");
  await assert.doesNotReject(() =>
    deniedImport.service.reconcileReminderNotificationsAfterImport(),
  );
  const deniedPermissionCount = deniedImport.permissionCount;
  const deniedConfigureCount = deniedImport.configureCount;
  await deniedImport.service.refreshReminderNotificationTimezone();
  assert.equal(
    deniedImport.permissionCount,
    deniedPermissionCount + 1,
    "foreground repair may passively detect a permission changed in system settings",
  );
  assert.equal(
    deniedImport.configureCount,
    deniedConfigureCount,
    "permission denial is a completed attempt, not a foreground retry loop",
  );

  const unsupported = createReminderServiceHarness({
    configureResult: false,
  });
  await (await unsupported.service.flushAndFreezePendingReminderWork()).release("import-committed");
  await assert.doesNotReject(() =>
    unsupported.service.reconcileReminderNotificationsAfterImport(),
  );
  const unsupportedConfigureCount = unsupported.configureCount;
  await unsupported.service.refreshReminderNotificationTimezone();
  assert.equal(
    unsupported.configureCount,
    unsupportedConfigureCount,
    "an unsupported notification runtime must not retry on every foreground",
  );
}

async function auditReminderSnapshotRecovery(): Promise<void> {
  const source = createReminderSnapshotReader({
    readHabits: async () => [reminderHabit],
    readSettings: async () => [{ key: SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED, value: "false" }],
  });
  assert.equal((await source.readSnapshot()).notificationsEnabled, false);
  for (const value of ["true", "null", "invalid-json"]) {
    const reader = createReminderSnapshotReader({
      readHabits: async () => [reminderHabit],
      readSettings: async () => [{ key: SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED, value }],
    });
    assert.equal((await reader.readSnapshot()).notificationsEnabled, true);
  }
  for (const failingOwner of ["habits", "settings"]) {
    const reader = createReminderSnapshotReader({
      readHabits: async () => {
        if (failingOwner === "habits") throw new Error("expected habits read failure");
        return [reminderHabit];
      },
      readSettings: async () => {
        if (failingOwner === "settings") throw new Error("expected settings read failure");
        return [];
      },
    });
    await assert.rejects(reader.readSnapshot(), /expected .* read failure/);
  }

  const imported = makeHabit({ id: 4, name: "Imported" });
  const repair = createReminderServiceHarness({ preserveScheduledState: true });
  repair.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(repair.service);
  const boundary = await repair.service.flushAndFreezePendingReminderWork();
  repair.service.scheduleHabitRemindersSync([makeHabit({ id: 3, name: "Buffered" })], { requestPermission: true });
  repair.setSnapshot([imported]);
  await boundary.release("import-committed");
  repair.failSnapshotReads();
  const reconcile = loadSourceCallableForAudit<() => Promise<void>>(
    readProjectFile("src/composition/data-transfer.ts"),
    "reconcileCommittedDataTransferPlatformState",
    { reconcileReminderNotificationsAfterImport: () => repair.service.reconcileReminderNotificationsAfterImport() },
  );
  const scheduledBeforeImport = repair.scheduled.length;
  await reconcile();
  assert.equal(repair.snapshotReadCount, 1, "the actual import composition callback must attempt the authoritative read");
  assert.equal(repair.scheduled.length, scheduledBeforeImport, "a failed authoritative read must not schedule captured pre-import habits");
  const firstForeground = repair.service.refreshReminderNotificationTimezone();
  const duplicateForeground = repair.service.refreshReminderNotificationTimezone();
  assert.strictEqual(duplicateForeground, firstForeground, "duplicate foreground callbacks must share one repair");
  await firstForeground;
  assert.equal(repair.snapshotReadCount, 2, "foreground must reread the imported database after a failed first read");
  assert.deepEqual(new Set(repair.pendingSchedules().map((request) => request.habitId)), new Set([4]));
  assert.equal(repair.permissionRequestCount, 0, "discarded pre-import prompt intent must not survive into recovery");
  const configureAfterRepair = repair.configureCount;
  await repair.service.refreshReminderNotificationTimezone();
  assert.equal(repair.snapshotReadCount, 2);
  assert.equal(repair.configureCount, configureAfterRepair, "a successful recovery must settle instead of retrying on each foreground");

  let completeRead!: (snapshot: { habits: Habit[]; notificationsEnabled: boolean }) => void;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  let readCount = 0;
  const newest = makeHabit({ id: 8, name: "Newest" });
  const raced = createReminderServiceHarness({
    preserveScheduledState: true,
    async readSnapshot() {
      readCount += 1;
      if (readCount > 1) return { habits: [newest], notificationsEnabled: false };
      markReadStarted();
      return new Promise((resolve) => { completeRead = resolve; });
    },
  });
  raced.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(raced.service);
  await (await raced.service.flushAndFreezePendingReminderWork()).release("import-committed");
  const recovery = raced.service.refreshReminderNotificationTimezone();
  await readStarted;
  raced.service.scheduleHabitRemindersSync([newest]);
  const disable = raced.service.setReminderNotificationsEnabled(false);
  completeRead({ habits: [imported], notificationsEnabled: true });
  await Promise.all([recovery, disable]);
  await runDeferredReminderServiceWork(raced.service);
  assert.equal(readCount, 2, "a durable intent accepted during a snapshot read must invalidate and reread both snapshot halves");
  assert.deepEqual(raced.pendingSchedules(), [], "a stale imported master must not overwrite the newer disabled master");
  assert.ok(raced.scheduled.every((entry) => entry.habitId === 1), "a superseded snapshot read must never reach native scheduling");

  let rejectStaleRead!: (error: Error) => void;
  let markStaleReadStarted!: () => void;
  const staleReadStarted = new Promise<void>((resolve) => { markStaleReadStarted = resolve; });
  let failingReadCount = 0;
  const staleFailure = createReminderServiceHarness({
    async readSnapshot() {
      failingReadCount += 1;
      if (failingReadCount > 1) return { habits: [newest], notificationsEnabled: false };
      markStaleReadStarted();
      return new Promise((_, reject) => { rejectStaleRead = reject; });
    },
  });
  await (await staleFailure.service.flushAndFreezePendingReminderWork()).release("import-committed");
  const pendingForeground = staleFailure.service.refreshReminderNotificationTimezone();
  await staleReadStarted;
  const newerMaster = staleFailure.service.setReminderNotificationsEnabled(false);
  rejectStaleRead(new Error("expected superseded read failure"));
  await Promise.all([pendingForeground, newerMaster]);
  assert.equal(failingReadCount, 2, "a superseded read error must retry the current generation rather than fail a newer master command");
  assert.deepEqual(staleFailure.scheduled, []);

  for (let turns = 0; turns < 9; turns += 1) {
    let resolveSnapshot!: (snapshot: { habits: Habit[]; notificationsEnabled: boolean }) => void;
    const snapshotGate = new Promise<{ habits: Habit[]; notificationsEnabled: boolean }>((resolve) => { resolveSnapshot = resolve; });
    const masterRace = createReminderServiceHarness({
      preserveScheduledState: true,
      readSnapshot: () => snapshotGate,
    });
    await (await masterRace.service.flushAndFreezePendingReminderWork()).release("import-committed");
    const olderDisable = masterRace.service.setReminderNotificationsEnabled(false);
    let newerEnable!: Promise<void>;
    const admission = snapshotGate.then(async () => {
      for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
      newerEnable = masterRace.service.setReminderNotificationsEnabled(true);
    });
    resolveSnapshot({ habits: [imported], notificationsEnabled: true });
    await Promise.all([olderDisable, admission]);
    assert.ok(newerEnable, "the newer master command must actually be delivered");
    await newerEnable;
    assert.equal(masterRace.pendingSchedules().length, 31, `a newer enabled master must survive an older recovery continuation at microtask offset ${turns}`);
  }

  const passiveRetry = createReminderServiceHarness({ preserveScheduledState: true });
  passiveRetry.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(passiveRetry.service);
  await (await passiveRetry.service.flushAndFreezePendingReminderWork()).release("import-committed");
  passiveRetry.setSnapshot([imported]);
  passiveRetry.failSnapshotReads(2);
  await assert.rejects(passiveRetry.service.reconcileReminderNotificationsAfterImport(), /snapshot read failure/);
  passiveRetry.service.scheduleReminderNotificationLocalizationRefresh();
  await runDeferredReminderServiceWork(passiveRetry.service);
  assert.equal(passiveRetry.snapshotReadCount, 2);
  passiveRetry.service.scheduleHabitReminderAfterRecordChange([imported], imported.id);
  await runDeferredReminderServiceWork(passiveRetry.service);
  assert.deepEqual(new Set(passiveRetry.pendingSchedules().map((request) => request.habitId)), new Set([4]), "record retry must recover the full authoritative generation after repeated read failures");
}

async function auditDeniedReminderCleanup(): Promise<void> {
  for (const replacement of [
    makeHabit({ isArchived: true }),
    makeHabit({ reminderEnabled: false }),
    makeHabit({ name: "Renamed" }),
    makeHabit({ reminderTime: "09:30" }),
    null,
  ]) {
    const harness = createReminderServiceHarness({ preserveScheduledState: true });
    const other = makeHabit({ id: 2, name: "Other" });
    harness.service.scheduleHabitRemindersSync([reminderHabit, other]);
    await runDeferredReminderServiceWork(harness.service);
    const retainedIds = harness.pendingSchedules().filter((request) => request.habitId === 2).map((request) => request.identifier);
    const schedulesBeforeDenial = harness.scheduled.length;
    harness.setPermissionGranted(false);
    harness.service.scheduleHabitRemindersSync(replacement ? [replacement, other] : [other]);
    await runDeferredReminderServiceWork(harness.service);
    assert.deepEqual(harness.pendingSchedules().map((request) => request.identifier), retainedIds, "denied mixed plans must remove only requests no longer matching the desired plan");
    assert.equal(harness.scheduled.length, schedulesBeforeDenial, "cleanup under denied delivery permission must not create missing requests");
    assert.equal(harness.permissionRequestCount, 0);
  }

  const recorded = createReminderServiceHarness({ preserveScheduledState: true });
  recorded.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(recorded.service);
  const original = recorded.pendingSchedules();
  recorded.setPermissionGranted(false);
  recorded.setRecords([{ habitId: 1, date: "2026-08-29", status: "done" }]);
  recorded.service.scheduleHabitReminderAfterRecordChange([reminderHabit], 1);
  await runDeferredReminderServiceWork(recorded.service);
  assert.equal(recorded.pendingSchedules().length, original.length - 1, "a handled day must lose its pending request even while permission is denied");

  const failedCleanup = createReminderServiceHarness({ preserveScheduledState: true });
  failedCleanup.service.scheduleHabitRemindersSync([reminderHabit, makeHabit({ id: 2 })]);
  await runDeferredReminderServiceWork(failedCleanup.service);
  failedCleanup.setPermissionGranted(false);
  failedCleanup.failCancellations();
  failedCleanup.service.scheduleHabitRemindersSync([makeHabit({ id: 2 })]);
  await runDeferredReminderServiceWork(failedCleanup.service);
  await failedCleanup.service.refreshReminderNotificationTimezone();
  assert.deepEqual(new Set(failedCleanup.pendingSchedules().map((request) => request.habitId)), new Set([2]), "a denied cleanup error must remain dirty for foreground retry");

  const partial = createReminderServiceHarness({ preserveScheduledState: true });
  partial.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(partial.service);
  partial.failScheduling();
  partial.service.scheduleHabitRemindersSync([makeHabit({ reminderTime: "09:30" })]);
  await runDeferredReminderServiceWork(partial.service);
  assert.deepEqual(partial.pendingSchedules(), []);
  await partial.service.refreshReminderNotificationTimezone();
  assert.equal(partial.pendingSchedules().length, 31, "failed replacement after cancellation must be rebuilt on passive foreground retry");
  assert.equal(new Set(partial.pendingSchedules().map((request) => request.scheduleKey)).size, 31);

  const partialCreation = createReminderServiceHarness({ preserveScheduledState: true });
  partialCreation.failSchedulingAfter(2);
  partialCreation.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(partialCreation.service);
  assert.equal(partialCreation.pendingSchedules().length, 2, "a native failure may leave an installed prefix of the plan");
  const installedPrefix = partialCreation.pendingSchedules().map((request) => request.identifier);
  await partialCreation.service.refreshReminderNotificationTimezone();
  assert.equal(partialCreation.pendingSchedules().length, 31);
  assert.ok(installedPrefix.every((identifier) => partialCreation.pendingSchedules().some((request) => request.identifier === identifier)), "repair must retain an exact installed prefix instead of recreating it");
}

async function auditReminderCivilDateRefill(): Promise<void> {
  const ordinary = createReminderServiceHarness({ preserveScheduledState: true });
  ordinary.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(ordinary.service);
  const nextDate = new Date(2026, 7, 30, 7, 30);
  ordinary.setNow(nextDate);
  ordinary.expireBefore(nextDate);
  ordinary.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(ordinary.service);
  assert.equal(ordinary.pendingSchedules().length, 31, "an unchanged habit signature on a new civil date must not skip planning");

  const rapid = createReminderServiceHarness({ preserveScheduledState: true });
  rapid.service.scheduleHabitRemindersSync([reminderHabit]);
  await runDeferredReminderServiceWork(rapid.service);
  rapid.service.scheduleHabitRemindersSync([makeHabit({ id: 2 })]);
  rapid.service.startPendingReminderWorkBeforeBackground();
  rapid.service.scheduleHabitRemindersSync([reminderHabit]);
  rapid.service.startPendingReminderWorkBeforeBackground();
  await runDeferredReminderServiceWork(rapid.service);
  assert.equal(rapid.pendingSchedules().length, 31);
  assert.deepEqual(new Set(rapid.pendingSchedules().map((request) => request.habitId)), new Set([1]), "rapid A-to-B-to-A must settle only the latest desired plan");

  for (const limit of [null, IOS_PENDING_REMINDER_LIMIT]) {
    const harness = createReminderServiceHarness({ preserveScheduledState: true, pendingReminderLimit: limit });
    const habits = limit == null ? [reminderHabit] : [
      makeHabit({ reminderTime: '["08:00","09:30"]' }),
      makeHabit({ id: 2, reminderTime: '["08:00","09:30"]' }),
      makeHabit({ id: 3, reminderTime: '["08:00","09:30"]' }),
    ];
    harness.service.scheduleHabitRemindersSync(habits);
    await runDeferredReminderServiceWork(harness.service);
    const initialCount = harness.pendingSchedules().length;
    assert.equal(initialCount, limit ?? 31);
    const nextDay = new Date(2026, 7, 30, 7, 30);
    harness.setNow(nextDay);
    harness.expireBefore(nextDay);
    const readsBefore = harness.scheduledListReadCount;
    const refresh = harness.service.refreshReminderNotificationTimezone();
    assert.strictEqual(harness.service.refreshReminderNotificationTimezone(), refresh);
    await refresh;
    assert.equal(harness.scheduledListReadCount, readsBefore + 1, "one new civil date must coalesce into one complete native plan read");
    assert.equal(harness.pendingSchedules().length, initialCount, "the new civil date must refill expired one-shot slots without extending limits");
    if (limit == null) {
      const latest = Math.max(...harness.pendingSchedules().map((request) => Number((JSON.parse(request.scheduleKey!) as unknown[])[2])));
      assert.equal(latest, new Date(2026, 8, 29, 8).getTime(), "the horizon must include exactly the new now+30 civil day");
    }
    const schedulesAfterRefill = harness.scheduled.length;
    const readsAfterRefill = harness.scheduledListReadCount;
    await harness.service.refreshReminderNotificationTimezone();
    assert.equal(harness.scheduledListReadCount, readsAfterRefill);
    assert.equal(harness.scheduled.length, schedulesAfterRefill);
    assert.equal(harness.permissionRequestCount, 0, "civil-date maintenance must never reuse explicit prompt authority");
    const later = new Date(2026, 11, 1, 7, 30);
    harness.setNow(later);
    harness.expireBefore(later);
    await harness.service.refreshReminderNotificationTimezone();
    assert.equal(harness.pendingSchedules().length, initialCount, "a long background interval must refill an exhausted plan");
  }
}

type NativeNotificationResponseListener = Parameters<
  ReminderNotificationsNativeModule["addNotificationResponseReceivedListener"]
>[0];
type NativeNotificationResponseFixture =
  Parameters<NativeNotificationResponseListener>[0];

function makeNativeNotificationResponse(
  identifier: string,
  habitId: number | null = 1,
): NativeNotificationResponseFixture {
  return {
    notification: {
      request: {
        identifier,
        content: {
          data:
            habitId == null
              ? { kind: "unrelated-notification" }
              : {
                  kind: "habit-reminder-v1",
                  habitId,
                },
        },
      },
    },
  };
}

function createFakeNativeNotificationsModule(options?: {
  readonly provisionalPermission?: boolean;
  readonly rejectListenerRegistration?: boolean;
  readonly shouldRejectListenerRegistration?: () => boolean;
  readonly onChannelConfigure?: () => void | Promise<void>;
  readonly onPermissionRequest?: () => void;
  readonly lastResponse?: NativeNotificationResponseFixture | null;
  readonly onListenerRegistered?: (
    listener: NativeNotificationResponseListener,
  ) => void;
  readonly onListenerRegistrationAttempt?: () => void;
  readonly onLastResponseRead?: () => void;
  readonly onLastResponseCleared?: () => void;
  readonly onListenerRemoved?: () => void;
}): ReminderNotificationsNativeModule {
  return {
    AndroidImportance: { HIGH: 4 },
    AndroidNotificationVisibility: { PUBLIC: 1 },
    IosAuthorizationStatus: { PROVISIONAL: 2 },
    SchedulableTriggerInputTypes: { DATE: "date" },
    addNotificationResponseReceivedListener(listener) {
      options?.onListenerRegistrationAttempt?.();
      if (
        options?.rejectListenerRegistration ||
        options?.shouldRejectListenerRegistration?.()
      ) {
        throw new Error("listener unavailable");
      }
      options?.onListenerRegistered?.(listener);
      return {
        remove() {
          options?.onListenerRemoved?.();
        },
      };
    },
    async cancelScheduledNotificationAsync() {},
    clearLastNotificationResponse() {
      options?.onLastResponseCleared?.();
    },
    async getAllScheduledNotificationsAsync() {
      return [];
    },
    getLastNotificationResponse() {
      options?.onLastResponseRead?.();
      return options?.lastResponse ?? null;
    },
    async getPermissionsAsync() {
      return {
        granted: false,
        ios: { status: options?.provisionalPermission ? 2 : 0 },
      };
    },
    async requestPermissionsAsync() {
      options?.onPermissionRequest?.();
      return { granted: false, ios: { status: 0 } };
    },
    async scheduleNotificationAsync() {
      return "scheduled";
    },
    async setNotificationChannelAsync() {
      await options?.onChannelConfigure?.();
    },
    setNotificationHandler() {},
  };
}

async function auditNotificationAdapterBehavior(): Promise<void> {
  let lazyLoadCount = 0;
  let fallbackOpenCount = 0;
  const listenerAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      lazyLoadCount += 1;
      return createFakeNativeNotificationsModule({
        rejectListenerRegistration: true,
        lastResponse: makeNativeNotificationResponse("last-after-failure"),
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  assert.equal(
    lazyLoadCount,
    0,
    "constructing the adapter must not eagerly load expo-notifications",
  );
  const unsubscribe = listenerAdapter.subscribeToResponses(() => {
    fallbackOpenCount += 1;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(lazyLoadCount, 1);
  assert.equal(
    fallbackOpenCount,
    1,
    "a listener registration failure must not discard the available cold-start response",
  );
  unsubscribe();

  const responseOrder: string[] = [];
  const racedResponse = makeNativeNotificationResponse("raced-response");
  let responseListener: NativeNotificationResponseListener | null = null;
  let responseOpenCount = 0;
  let responseClearCount = 0;
  let responseRemoveCount = 0;
  const responseAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      return createFakeNativeNotificationsModule({
        lastResponse: racedResponse,
        onListenerRegistered(listener) {
          responseOrder.push("listener.registered");
          responseListener = listener;
        },
        onLastResponseRead() {
          responseOrder.push("last-response.read");
          responseListener?.(racedResponse);
        },
        onLastResponseCleared() {
          responseClearCount += 1;
        },
        onListenerRemoved() {
          responseRemoveCount += 1;
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  const unsubscribeResponses = responseAdapter.subscribeToResponses(() => {
    responseOpenCount += 1;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.deepEqual(
    responseOrder,
    ["listener.registered", "last-response.read"],
    "the live response listener must be registered before the cold-start snapshot is read",
  );
  assert.equal(
    responseOpenCount,
    1,
    "the same response delivered live and as the cold-start snapshot must open Home once",
  );
  assert.equal(
    responseClearCount,
    1,
    "a duplicate delivery must clear the native cold-start response once",
  );

  const emitResponse = (response: NativeNotificationResponseFixture) => {
    if (!responseListener) {
      throw new Error("notification response listener was not registered");
    }
    responseListener(response);
  };
  emitResponse(racedResponse);
  assert.equal(
    responseOpenCount,
    1,
    "a repeated native callback with the same request identifier must remain idempotent",
  );
  emitResponse(makeNativeNotificationResponse("distinct-response"));
  assert.equal(
    responseOpenCount,
    2,
    "a different notification request identifier must remain independently actionable",
  );
  assert.equal(responseClearCount, 2);
  emitResponse(makeNativeNotificationResponse("shared-unrelated-id", null));
  assert.equal(
    responseOpenCount,
    2,
    "an unrelated notification response must remain ignored",
  );
  emitResponse(makeNativeNotificationResponse("shared-unrelated-id"));
  assert.equal(
    responseOpenCount,
    3,
    "an ignored response must not consume the identifier of a later valid reminder",
  );
  assert.equal(responseClearCount, 3);
  unsubscribeResponses();
  assert.equal(
    responseRemoveCount,
    1,
    "unsubscribing must still remove the registered native listener",
  );
  emitResponse(makeNativeNotificationResponse("queued-after-unsubscribe"));
  assert.equal(
    responseOpenCount,
    3,
    "a native callback already queued during unsubscribe must not navigate through a disposed owner",
  );
  assert.equal(
    responseClearCount,
    3,
    "a disposed subscription must not consume or clear a response for the next owner",
  );

  const staleAfterClearFailure = makeNativeNotificationResponse(
    "stale-after-clear-failure",
  );
  let remountOpenCount = 0;
  let remountClearAttemptCount = 0;
  const remountAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      return createFakeNativeNotificationsModule({
        lastResponse: staleAfterClearFailure,
        onLastResponseCleared() {
          remountClearAttemptCount += 1;
          throw new Error("expected clear failure");
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  const unsubscribeBeforeRemount = remountAdapter.subscribeToResponses(() => {
    remountOpenCount += 1;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  unsubscribeBeforeRemount();
  const unsubscribeAfterRemount = remountAdapter.subscribeToResponses(() => {
    remountOpenCount += 1;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(
    remountOpenCount,
    1,
    "a cold response whose native clear failed must not reopen Home after the root subscription remounts",
  );
  assert.equal(
    remountClearAttemptCount,
    2,
    "a remount duplicate must retry the best-effort native clear without repeating navigation",
  );
  unsubscribeAfterRemount();

  const overlappingListeners: NativeNotificationResponseListener[] = [];
  let overlappingOpenCount = 0;
  let overlappingClearCount = 0;
  let overlappingRemoveCount = 0;
  const overlappingAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      return createFakeNativeNotificationsModule({
        onListenerRegistered(listener) {
          overlappingListeners.push(listener);
        },
        onLastResponseCleared() {
          overlappingClearCount += 1;
        },
        onListenerRemoved() {
          overlappingRemoveCount += 1;
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  const unsubscribeFirstOverlap = overlappingAdapter.subscribeToResponses(
    () => {
      overlappingOpenCount += 1;
    },
  );
  const unsubscribeSecondOverlap = overlappingAdapter.subscribeToResponses(
    () => {
      overlappingOpenCount += 1;
    },
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(
    overlappingListeners.length,
    1,
    "overlapping adapter subscribers must share one native response listener",
  );
  const overlappingResponse = makeNativeNotificationResponse(
    "overlapping-root-subscriptions",
  );
  for (const listener of overlappingListeners) {
    listener(overlappingResponse);
  }
  assert.equal(
    overlappingOpenCount,
    1,
    "overlapping root subscriptions must not navigate twice for one response",
  );
  assert.equal(
    overlappingClearCount,
    1,
    "one native delivery must clear the cold response once",
  );
  unsubscribeFirstOverlap();
  assert.equal(
    overlappingRemoveCount,
    0,
    "the shared native listener must stay installed while one subscriber remains",
  );
  assert.equal(
    overlappingListeners.length,
    1,
    "removing one adapter subscriber must not reinstall the shared native listener",
  );
  overlappingListeners[0]?.(
    makeNativeNotificationResponse("second-overlapping-owner"),
  );
  assert.equal(
    overlappingOpenCount,
    2,
    "the remaining adapter subscriber must keep receiving native responses",
  );
  unsubscribeSecondOverlap();
  assert.equal(
    overlappingRemoveCount,
    1,
    "the last adapter unsubscribe must remove the shared native listener once",
  );

  let boundedListener: NativeNotificationResponseListener | null = null;
  let boundedOpenCount = 0;
  const boundedAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      return createFakeNativeNotificationsModule({
        onListenerRegistered(listener) {
          boundedListener = listener;
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  const unsubscribeBounded = boundedAdapter.subscribeToResponses(() => {
    boundedOpenCount += 1;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const invokeBoundedListener =
    boundedListener as NativeNotificationResponseListener | null;
  assert.ok(invokeBoundedListener);
  for (let index = 0; index <= 64; index += 1) {
    invokeBoundedListener(
      makeNativeNotificationResponse(`bounded-response-${index}`),
    );
  }
  assert.equal(boundedOpenCount, 65);
  invokeBoundedListener(makeNativeNotificationResponse("bounded-response-0"));
  assert.equal(
    boundedOpenCount,
    65,
    "the live subscription must retain exact idempotence after the process cache reaches its bound",
  );
  unsubscribeBounded();
  const unsubscribeBoundedRemount = boundedAdapter.subscribeToResponses(() => {
    boundedOpenCount += 1;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const invokeBoundedRemountListener =
    boundedListener as NativeNotificationResponseListener | null;
  assert.ok(invokeBoundedRemountListener);
  invokeBoundedRemountListener(
    makeNativeNotificationResponse("bounded-response-0"),
  );
  assert.equal(
    boundedOpenCount,
    66,
    "process-level remount deduplication must be bounded instead of retaining every identifier forever",
  );
  unsubscribeBoundedRemount();

  let callbackFailureClearCount = 0;
  const callbackFailureAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      return createFakeNativeNotificationsModule({
        lastResponse: makeNativeNotificationResponse("callback-failure"),
        onLastResponseCleared() {
          callbackFailureClearCount += 1;
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  const unsubscribeCallbackFailure =
    callbackFailureAdapter.subscribeToResponses(() => {
      throw new Error("expected app callback failure");
    });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(callbackFailureClearCount, 1);
  unsubscribeCallbackFailure();

  let subscriberLoadRetryCount = 0;
  let subscriberLoadRetryListener: NativeNotificationResponseListener | null =
    null;
  let subscriberLoadRetryOpenCount = 0;
  let subscriberLoadRetryRemoveCount = 0;
  const subscriberLoadRetryAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      subscriberLoadRetryCount += 1;
      if (subscriberLoadRetryCount === 1) {
        throw new Error("expected subscriber module load failure");
      }
      return createFakeNativeNotificationsModule({
        onListenerRegistered(listener) {
          subscriberLoadRetryListener = listener;
        },
        onListenerRemoved() {
          subscriberLoadRetryRemoveCount += 1;
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  const unsubscribeSubscriberLoadRetry =
    subscriberLoadRetryAdapter.subscribeToResponses(() => {
      subscriberLoadRetryOpenCount += 1;
    });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(
    subscriberLoadRetryCount,
    1,
    "a response-subscriber load failure must not start an internal retry loop",
  );
  assert.equal(subscriberLoadRetryListener, null);
  assert.equal(
    await subscriberLoadRetryAdapter.configure(),
    true,
    "a later explicit configure must reload the module and repair the listener for the existing subscriber",
  );
  assert.equal(subscriberLoadRetryCount, 2);
  const invokeSubscriberLoadRetryListener =
    subscriberLoadRetryListener as NativeNotificationResponseListener | null;
  assert.ok(invokeSubscriberLoadRetryListener);
  invokeSubscriberLoadRetryListener(
    makeNativeNotificationResponse("subscriber-load-retry"),
  );
  assert.equal(subscriberLoadRetryOpenCount, 1);
  unsubscribeSubscriberLoadRetry();
  assert.equal(subscriberLoadRetryRemoveCount, 1);

  const listenerInstallRetryColdResponse = makeNativeNotificationResponse(
    "listener-install-retry-cold",
  );
  let listenerInstallAttemptCount = 0;
  let listenerInstallRetryListener: NativeNotificationResponseListener | null =
    null;
  let listenerInstallRetryOpenCount = 0;
  let listenerInstallRetryClearCount = 0;
  let listenerInstallRetryRemoveCount = 0;
  const listenerInstallRetryAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      return createFakeNativeNotificationsModule({
        lastResponse: listenerInstallRetryColdResponse,
        onListenerRegistrationAttempt() {
          listenerInstallAttemptCount += 1;
        },
        shouldRejectListenerRegistration() {
          return listenerInstallAttemptCount === 1;
        },
        onListenerRegistered(listener) {
          listenerInstallRetryListener = listener;
        },
        onLastResponseCleared() {
          listenerInstallRetryClearCount += 1;
        },
        onListenerRemoved() {
          listenerInstallRetryRemoveCount += 1;
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  const unsubscribeListenerInstallRetry =
    listenerInstallRetryAdapter.subscribeToResponses(() => {
      listenerInstallRetryOpenCount += 1;
    });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  assert.equal(
    listenerInstallAttemptCount,
    1,
    "a native listener install failure must wait for a later explicit adapter operation",
  );
  assert.equal(
    listenerInstallRetryOpenCount,
    1,
    "a transient listener install failure must still deliver the cold-start response",
  );
  assert.equal(listenerInstallRetryClearCount, 1);
  assert.equal(
    await listenerInstallRetryAdapter.configure(),
    true,
    "a later configure must retry listener installation for the retained subscriber",
  );
  assert.equal(listenerInstallAttemptCount, 2);
  assert.equal(
    listenerInstallRetryOpenCount,
    1,
    "repairing the native listener must not redeliver an already handled cold response",
  );
  assert.equal(listenerInstallRetryClearCount, 1);
  await listenerInstallRetryAdapter.configure();
  assert.equal(
    listenerInstallAttemptCount,
    2,
    "successful listener installation must stay singleton across later configuration calls",
  );
  const invokeListenerInstallRetryListener =
    listenerInstallRetryListener as NativeNotificationResponseListener | null;
  assert.ok(invokeListenerInstallRetryListener);
  invokeListenerInstallRetryListener(
    makeNativeNotificationResponse("listener-install-retry-live"),
  );
  assert.equal(listenerInstallRetryOpenCount, 2);
  assert.equal(listenerInstallRetryClearCount, 2);
  unsubscribeListenerInstallRetry();
  assert.equal(listenerInstallRetryRemoveCount, 1);

  let webLoadCount = 0;
  const webAdapter = createReminderNotificationAdapter({
    platform: "web",
    async loadModule() {
      webLoadCount += 1;
      return createFakeNativeNotificationsModule();
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  assert.equal(await webAdapter.configure(), false);
  assert.equal(await webAdapter.configure(), false);
  assert.equal(webLoadCount, 0);

  let transientLoadCount = 0;
  const transientLoadAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      transientLoadCount += 1;
      if (transientLoadCount === 1) {
        throw new Error("expected transient module load failure");
      }
      return createFakeNativeNotificationsModule();
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  const sharedTransientLoad = await Promise.allSettled([
    transientLoadAdapter.configure(),
    transientLoadAdapter.configure(),
  ]);
  assert.deepEqual(
    sharedTransientLoad.map((result) => result.status),
    ["rejected", "rejected"],
    "concurrent configure calls must share one transient loader rejection",
  );
  assert.equal(
    transientLoadCount,
    1,
    "a failed configure attempt must not create an internal retry storm",
  );
  assert.equal(
    await transientLoadAdapter.configure(),
    true,
    "the next explicit configure must retry a transient module load in the same process",
  );
  assert.equal(transientLoadCount, 2);

  let transientChannelLoadCount = 0;
  let transientChannelConfigureCount = 0;
  const transientChannelAdapter = createReminderNotificationAdapter({
    platform: "android",
    async loadModule() {
      transientChannelLoadCount += 1;
      return createFakeNativeNotificationsModule({
        onChannelConfigure() {
          transientChannelConfigureCount += 1;
          if (transientChannelConfigureCount === 1) {
            throw new Error("expected transient channel configure failure");
          }
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  await assert.rejects(
    transientChannelAdapter.configure(),
    /transient channel configure failure/,
  );
  assert.equal(
    transientChannelConfigureCount,
    1,
    "a failed channel configuration must wait for an explicit retry",
  );
  assert.equal(
    await transientChannelAdapter.configure(),
    true,
    "the next explicit configure must retry transient channel setup in the same process",
  );
  assert.equal(
    transientChannelLoadCount,
    1,
    "a configuration failure must retain the successfully loaded native module",
  );
  assert.equal(transientChannelConfigureCount, 2);

  let permissionRequests = 0;
  const provisionalAdapter = createReminderNotificationAdapter({
    platform: "ios",
    async loadModule() {
      return createFakeNativeNotificationsModule({
        provisionalPermission: true,
        onPermissionRequest: () => {
          permissionRequests += 1;
        },
      });
    },
    copy: {
      channelName: () => "Reminders",
      notificationTitle: () => "Reminder",
      notificationBody: (habitName) => habitName,
    },
  });
  assert.equal(await provisionalAdapter.hasPermission(), true);
  assert.equal(await provisionalAdapter.requestPermission(), true);
  assert.equal(
    provisionalAdapter.pendingReminderLimit,
    IOS_PENDING_REMINDER_LIMIT,
    "the iOS adapter must publish Apple's per-application pending reminder cap",
  );
  assert.equal(
    listenerAdapter.pendingReminderLimit,
    null,
    "the Android adapter must keep the established uncapped per-habit planner",
  );
  assert.equal(
    permissionRequests,
    0,
    "iOS provisional authorization must remain sufficient without a prompt",
  );
}

async function auditDeferredReminderCoordinator(): Promise<void> {
  {
    const ui = createManualUiScheduler();
    const calls: string[] = [];
    const coordinator = new DeferredReminderWorkCoordinator<number>({
      scheduleAfterUiSettles: ui.schedule,
      isAppActive: () => true,
      async runFullSync(snapshot) {
        calls.push(`full:${snapshot}`);
      },
      async runRecordSync(snapshot, habitIds) {
        calls.push(`record:${snapshot}:${habitIds.join(",")}`);
      },
      async runLocalizationRefresh() {
        calls.push("localization");
      },
      onError(_operation, error) {
        throw error;
      },
    });

    coordinator.scheduleFullSync(1);
    coordinator.scheduleFullSync(2);
    coordinator.scheduleRecordSync(10, 7);
    coordinator.scheduleRecordSync(11, 7);
    coordinator.scheduleRecordSync(12, 8);
    coordinator.scheduleLocalizationRefresh();
    coordinator.scheduleLocalizationRefresh();

    assert.equal(
      ui.scheduled.length,
      4,
      "full/record work coalesces into one callback while localization reschedules its callback",
    );
    await coordinator.flushAndWait();
    assert.deepEqual(calls, ["full:2", "record:12:7,8", "localization"]);
    assert.equal(
      ui.scheduled.every((entry) => entry.cancelled),
      true,
      "an import fence must cancel every still-deferred UI callback",
    );

    let releaseFirstRecordRun!: () => void;
    const firstRecordRunPending = new Promise<void>((resolve) => {
      releaseFirstRecordRun = resolve;
    });
    const inFlightUi = createManualUiScheduler();
    const inFlightCalls: string[] = [];
    let recordRunCount = 0;
    const inFlightCoordinator = new DeferredReminderWorkCoordinator<number>({
      scheduleAfterUiSettles: inFlightUi.schedule,
      isAppActive: () => true,
      async runFullSync() {},
      async runRecordSync(snapshot, habitIds) {
        recordRunCount += 1;
        inFlightCalls.push(`record:${snapshot}:${habitIds.join(",")}`);
        if (recordRunCount === 1) await firstRecordRunPending;
      },
      async runLocalizationRefresh() {},
      onError(_operation, error) {
        throw error;
      },
    });
    inFlightCoordinator.scheduleRecordSync(20, 1);
    inFlightCoordinator.startAcceptedWorkNow();
    await Promise.resolve();
    inFlightCoordinator.scheduleRecordSync(21, 1);
    inFlightCoordinator.scheduleRecordSync(22, 2);
    assert.equal(
      inFlightUi.scheduled.length,
      1,
      "record changes accepted in flight must not create parallel idle callbacks",
    );
    assert.deepEqual(
      inFlightCalls,
      ["record:20:1"],
      "record work accepted during an active native batch must not start concurrently",
    );
    releaseFirstRecordRun();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      inFlightUi.scheduled.length,
      2,
      "a pending user-driven record batch must receive a fresh UI-idle admission after the active batch",
    );
    await inFlightCoordinator.flushAndWait();
    assert.deepEqual(
      inFlightCalls,
      ["record:20:1", "record:22:1,2"],
      "record work accepted in flight must collapse to the latest snapshot and unique habit IDs",
    );

    const failedWriteRepairUi = createManualUiScheduler();
    const failedWriteRepairCalls: string[] = [];
    const failedWriteRepairCoordinator =
      new DeferredReminderWorkCoordinator<number>({
        scheduleAfterUiSettles: failedWriteRepairUi.schedule,
        isAppActive: () => true,
        async runFullSync() {},
        async runRecordSync(snapshot, habitIds) {
          failedWriteRepairCalls.push(
            `record:${snapshot}:${habitIds.join(",")}`,
          );
        },
        async runLocalizationRefresh() {},
        onError(_operation, error) {
          throw error;
        },
      });
    // Exact recovery race: an older mark/unmark reached SQLite but skipped its
    // reminder side effect after being superseded; each latest intent then
    // failed and reloaded authoritative records before requesting this repair.
    failedWriteRepairCoordinator.scheduleRecordSync(30, 7);
    failedWriteRepairCoordinator.scheduleRecordSync(31, 7);
    assert.equal(
      failedWriteRepairUi.scheduled.length,
      1,
      "failed latest mark/unmark recovery must share one deferred admission",
    );
    await failedWriteRepairCoordinator.flushAndWait();
    assert.deepEqual(
      failedWriteRepairCalls,
      ["record:31:7"],
      "authoritative failed-write repairs must coalesce to the latest habit snapshot",
    );
  }
}

async function auditBackgroundReminderAdmission(): Promise<void> {
  const ui = createManualUiScheduler();
  const calls: string[] = [];
  let appActive = true;
  const errors: unknown[] = [];
  const coordinator = new DeferredReminderWorkCoordinator<number>({
    scheduleAfterUiSettles: ui.schedule,
    isAppActive: () => appActive,
    async runFullSync(snapshot) {
      calls.push(`full:${snapshot}`);
    },
    async runRecordSync(snapshot, habitIds) {
      calls.push(`record:${snapshot}:${habitIds.join(",")}`);
    },
    async runLocalizationRefresh() {
      calls.push("localization");
    },
    onError(_operation, error) {
      errors.push(error);
    },
  });

  coordinator.scheduleFullSync(1);
  assert.equal(ui.scheduled.length, 1);
  appActive = false;
  coordinator.startAcceptedWorkNow();
  await coordinator.flushAndWait();
  assert.deepEqual(calls, ["full:1"]);
  assert.equal(
    ui.scheduled[0]?.cancelled,
    true,
    "background transition must cancel the frame-dependent callback",
  );

  coordinator.scheduleRecordSync(2, 9);
  coordinator.scheduleLocalizationRefresh();
  await coordinator.flushAndWait();
  assert.deepEqual(calls, ["full:1", "record:2:9", "localization"]);
  assert.equal(
    ui.scheduled.length,
    1,
    "work accepted after background must start without a RAF dependency",
  );

  const synchronousFailure = new DeferredReminderWorkCoordinator<number>({
    scheduleAfterUiSettles: ui.schedule,
    isAppActive: () => false,
    runFullSync() {
      throw new Error("registration failed");
    },
    async runRecordSync() {},
    async runLocalizationRefresh() {},
    onError(_operation, error) {
      errors.push(error);
    },
  });
  synchronousFailure.scheduleFullSync(3);
  await synchronousFailure.flushAndWait();
  assert.equal(
    errors.length,
    1,
    "synchronous native adapter failures must reach the owned error boundary",
  );
}

async function auditReminderReplacementGate(): Promise<void> {
  const errors: unknown[] = [];
  const gate = new ReminderReplacementGate((error) => errors.push(error));

  let finishRunning!: () => void;
  const runningDone = new Promise<void>((resolve) => {
    finishRunning = resolve;
  });
  const calls: string[] = [];
  const alreadyRunning = gate.run(async () => {
    calls.push("running:start");
    await runningDone;
    calls.push("running:end");
  });
  const boundary = gate.enter();
  const waited = gate.waitForRunning().then(() => calls.push("waited"));
  gate.schedule(async () => {
    calls.push("buffered:abort");
  });
  await Promise.resolve();
  assert.deepEqual(calls, ["running:start"]);
  finishRunning();
  await Promise.all([alreadyRunning, waited]);
  assert.deepEqual(calls, ["running:start", "running:end", "waited"]);
  await gate.release(boundary, "import-aborted");
  assert.deepEqual(calls, [
    "running:start",
    "running:end",
    "waited",
    "buffered:abort",
  ]);

  const committedBoundary = gate.enter();
  const discarded = gate.run(async () => {
    calls.push("buffered:committed");
  });
  await gate.release(committedBoundary, "import-committed");
  await discarded;
  assert.equal(
    calls.includes("buffered:committed"),
    false,
    "post-boundary old reminder work must be discarded after committed import",
  );
  assert.deepEqual(errors, []);

  const first = gate.enter();
  assert.throws(
    () => gate.enter(),
    /already active/,
    "overlapping imports must not create ambiguous reminder boundaries",
  );
  await gate.release(first, "import-committed");
}

async function auditQuiescentFreezeHasNoAdmissionGap(): Promise<void> {
  const ui = createManualUiScheduler();
  const calls: string[] = [];
  const gate = new ReminderReplacementGate((error) => {
    throw error;
  });
  const coordinator = new DeferredReminderWorkCoordinator<number>({
    scheduleAfterUiSettles: ui.schedule,
    isAppActive: () => true,
    async runFullSync(snapshot) {
      await gate.run(async () => {
        calls.push(`full:${snapshot}`);
      });
    },
    async runRecordSync() {},
    async runLocalizationRefresh() {},
    onError(_operation, error) {
      throw error;
    },
  });

  coordinator.scheduleFullSync(1);
  let boundary: ReturnType<ReminderReplacementGate["enter"]> | null = null;
  await coordinator.flushAndWait(() => {
    boundary = gate.enter();
    gate.schedule(async () => {
      calls.push("late");
    });
  });
  assert.deepEqual(calls, ["full:1"]);
  assert.ok(boundary);
  await gate.release(boundary, "import-committed");
  assert.deepEqual(
    calls,
    ["full:1"],
    "work accepted at the quiescent boundary must not slip into old native state",
  );
}

async function auditDeferredWorkAcceptedDuringDrain(): Promise<void> {
  const ui = createManualUiScheduler();
  let releaseFull!: () => void;
  const fullPending = new Promise<void>((resolve) => {
    releaseFull = resolve;
  });
  const calls: string[] = [];
  const coordinator = new DeferredReminderWorkCoordinator<number>({
    scheduleAfterUiSettles: ui.schedule,
    isAppActive: () => true,
    async runFullSync() {
      calls.push("full:start");
      await fullPending;
      calls.push("full:end");
    },
    async runRecordSync() {},
    async runLocalizationRefresh() {
      calls.push("localization");
    },
    onError(_operation, error) {
      throw error;
    },
  });

  coordinator.scheduleFullSync(1);
  const fence = coordinator.flushAndWait();
  await Promise.resolve();
  coordinator.scheduleLocalizationRefresh();
  releaseFull();
  await fence;
  assert.deepEqual(
    calls,
    ["full:start", "full:end", "localization"],
    "work accepted while the fence is draining must be included before import",
  );
}

const reminderServiceSource = readProjectFile(
  "src/application/reminders/reminder-service.ts",
);
const notificationAdapterSource = readProjectFile(
  "src/platform/notifications/reminder-notification-adapter-core.ts",
);
const notificationResponseOwnershipSection = sourceSection(
  notificationAdapterSource,
  "  interface ResponseSubscriber {",
  "  async function getModule(",
);
const notificationResponseSection = sourceSection(
  notificationAdapterSource,
  "  function subscribeToResponses(",
  "  return {\n    pendingReminderLimit:",
);
const expoNotificationAdapterSource = readProjectFile(
  "src/platform/notifications/expo-reminder-notification-adapter.ts",
);
const reminderCompositionSource = readProjectFile(
  "src/composition/reminders.ts",
);
const reminderRepositorySource = readProjectFile(
  "src/data/sqlite/reminder-day-record-repository.ts",
);
const reminderScheduleSource = readProjectFile(
  "src/domain/reminders/reminder-schedule.ts",
);
const rootLayoutSource = readProjectFile("app/_layout.tsx");
const settingsSource = readProjectFile("src/stores/settings-store.ts");
const settingsCompositionSource = readProjectFile(
  "src/composition/settings.ts",
);
const settingsCoordinatorSource = readProjectFile(
  "src/application/settings/settings-mutation-coordinator.ts",
);
const cancellationSection = sourceSection(
  reminderServiceSource,
  "  private async cancelScheduledReminderIds(",
  "  private async cancelAllScheduledHabitReminders(",
);
const schedulingSection = sourceSection(
  reminderServiceSource,
  "  private async reconcileDesiredSchedules(",
  "  private async replaceGloballyLimitedReminderSchedule(",
);
const drainSection = sourceSection(
  reminderServiceSource,
  "  private async drainFullReminderSyncRequests(",
  "  private ensureFullReminderSyncDrain(",
);
const recordSyncSection = sourceSection(
  reminderServiceSource,
  "  private async syncHabitRemindersAfterRecordChangesNow(",
  "  private syncHabitRemindersAfterRecordChanges(",
);
const foregroundRefreshSection = sourceSection(
  reminderServiceSource,
  "  private async refreshReminderNotificationTimezoneNow(",
  "  private async warmupHabitRemindersNow(",
);
const languageSetter = sourceSection(
  settingsSource,
  "async setLanguage(language)",
  "async setAskFailureReason(enabled)",
);
const reminderToggleSetter = sourceSection(
  settingsSource,
  "async setReminderNotificationsEnabled(enabled)",
  "async setShowArchivedHabitsInStatistics(enabled)",
);

assert.match(
  reminderServiceSource,
  /const REMINDER_WORK_UNITS_PER_UI_YIELD = [1-9]\d*;/,
  "full reminder rebuilds must yield after bounded sequential work",
);
assert.match(cancellationSection, /await control\.checkpoint\(\)/);
assert.match(schedulingSection, /await control\.checkpoint\(\)/);
assert.doesNotMatch(
  cancellationSection,
  /Promise\.all/,
  "native notification cancellation must remain sequential",
);
assert.doesNotMatch(
  schedulingSection,
  /Promise\.all/,
  "native notification scheduling must remain sequential",
);
assert.match(
  drainSection,
  /if \(!this\.isFullReminderSyncCurrent\(revision\)\) \{[\s\S]{0,260}continue;/,
  "a superseded rebuild must not publish or settle stale native state",
);
assert.match(
  drainSection,
  /this\.forcedFullSyncRevision > this\.appliedFullSyncRevision/,
  "forced invalidation must survive until a current rebuild is applied",
);
assert.match(
  drainSection,
  /this\.refreshAndroidChannelRevision > this\.appliedFullSyncRevision/,
  "channel localization invalidation must survive superseded rebuilds",
);
assert.match(
  recordSyncSection,
  /this\.settledFullSyncRevision < this\.requestedFullSyncRevision/,
  "a pending full rebuild must supersede redundant per-record repair",
);
assert.match(
  recordSyncSection,
  /this\.reconcileDesiredSchedules\([\s\S]{0,260}changedHabitIdSet/,
  "per-record native scheduling must reconcile only the changed habit set",
);
assert.match(
  recordSyncSection,
  /loadReminderRecordsByHabit\(\s*changedHabits,?\s*\)/,
  "one coalesced record batch must load all affected habit records together",
);
assert.equal(
  recordSyncSection.match(/listScheduledHabitReminders\(\)/g)?.length,
  1,
  "one coalesced record batch must inspect native reminders only once",
);
assert.match(
  languageSetter,
  /settingsMutationCoordinator\.submit\(\{[\s\S]{0,100}scope,[\s\S]{0,100}value: normalizedLanguage/,
  "language persistence must submit one typed value for durable and global-i18n reconciliation",
);
assert.doesNotMatch(
  languageSetter,
  /whenEffectsIdle|scheduleReminderNotificationLocalizationRefresh/,
  "the setter must not create reminder work after the settings-effects barrier has already settled",
);
assert.match(
  settingsCompositionSource,
  /function changeI18nLanguageInCurrentTurn[\s\S]{0,700}Promise\.resolve\(change\)\.then\(\s*\(\) => \{[\s\S]{0,500}scheduleReminderNotificationLocalizationRefresh\(\)/,
  "successful apply and rollback must register global reminder work before their settings effect settles",
);
assert.match(
  settingsCompositionSource,
  /registerLoadedSettingsPlatformEffects[\s\S]{0,220}scheduleReminderNotificationLocalizationRefresh\(\);[\s\S]{0,180}reconcileConfirmedSideEffect\([\s\S]{0,80}"reminderNotifications"/,
  "load-time reminder master reconciliation must enter the tracked settings effect owner",
);
assert.match(
  sourceSection(
    reminderServiceSource,
    "  scheduleReminderNotificationLocalizationRefresh(): void {",
    "  refreshReminderNotificationTimezone(): Promise<void> {",
  ),
  /this\.replacementGate\.schedule\(async \(\) => \{\s*this\.deferredWork\.scheduleLocalizationRefresh\(\)/,
  "localization admission must remain inside the existing replacement gate",
);
assert.match(
  reminderServiceSource,
  /startPendingReminderWorkBeforeBackground\(\): void[\s\S]{0,120}this\.deferredWork\.startAcceptedWorkNow\(\)/,
  "the platform facade must expose a synchronous background admission boundary",
);
assert.match(
  rootLayoutSource,
  /if \(state === "active"\)[\s\S]{0,700}else \{[\s\S]{0,100}startPendingReminderWorkBeforeBackground\(\)/,
  "AppState background must start reminder jobs before frame callbacks pause",
);
assert.match(
  rootLayoutSource,
  /if \(state === "active"\)[\s\S]{0,300}retryFailedSettingsPlatformEffects\(\)[\s\S]{0,300}refreshReminderNotificationTimezone\(\)\.catch/,
  "foreground resume must re-admit dormant settings and reminder native repairs",
);
assert.match(
  notificationResponseSection,
  /void getModule\(\)\.catch\(/,
  "notification response registration must have a terminal rejection boundary",
);
const notificationListenerRegistrationIndex =
  notificationResponseOwnershipSection.indexOf(
    "module.addNotificationResponseReceivedListener((response) =>",
  );
const lastNotificationResponseReadIndex =
  notificationResponseOwnershipSection.indexOf(
    "handleResponse(module, module.getLastNotificationResponse())",
  );
assert.ok(
  notificationListenerRegistrationIndex >= 0 &&
    lastNotificationResponseReadIndex > notificationListenerRegistrationIndex,
  "the native listener must be registered before the cold-start response is read",
);
assert.match(
  notificationResponseOwnershipSection,
  /subscriber\.handledResponseIdentifiers\.has\(request\.identifier\)[\s\S]{0,180}subscriber\.handledResponseIdentifiers\.add\(request\.identifier\)/,
  "live and cold-start delivery must retain exact subscription-local dedupe",
);
assert.match(
  notificationResponseOwnershipSection,
  /const responseSubscribers = new Map<number, ResponseSubscriber>\(\);[\s\S]{0,180}let nativeResponseSubscription:/,
  "the adapter must own subscriber fan-out and exactly one native subscription slot",
);
assert.match(
  notificationAdapterSource,
  /if \(moduleCache\) ensureResponseListenerForModule\(moduleCache\);[\s\S]{0,500}ensureResponseListenerForModule\(module\);/,
  "later cached and newly successful module access must repair a transient listener failure",
);
assert.doesNotMatch(
  notificationResponseOwnershipSection,
  /setTimeout|setInterval|queueMicrotask/,
  "listener repair must wait for an explicit adapter operation instead of creating a retry storm",
);
assert.match(
  notificationAdapterSource,
  /const HANDLED_REMINDER_RESPONSE_IDENTIFIER_LIMIT = 64;[\s\S]{0,160}const processHandledResponseIdentifiers = new Set<string>\(\);[\s\S]{0,600}while \([\s\S]{0,120}processHandledResponseIdentifiers\.size >[\s\S]{0,100}HANDLED_REMINDER_RESPONSE_IDENTIFIER_LIMIT/,
  "root remount dedupe must be process-owned and strictly bounded",
);
assert.match(
  notificationResponseOwnershipSection,
  /if \(!response \|\| responseSubscribers\.size === 0\) return;/,
  "queued native responses must not outlive their subscription owner",
);
assert.match(
  notificationResponseSection,
  /responseSubscribers\.delete\(subscriberId\)[\s\S]{0,260}responseSubscribers\.size > 0[\s\S]{0,500}subscription\.remove\(\)/,
  "only the last adapter subscriber may remove the shared native listener",
);
assert.match(
  reminderServiceSource,
  /async flushAndFreezePendingReminderWork[\s\S]{0,420}this\.deferredWork\.flushAndWait\(\(\) => \{[\s\S]{0,160}this\.replacementGate\.enter\(\)/,
  "import must freeze new reminder admission in the final quiescent-check turn",
);
assert.match(
  reminderServiceSource,
  /reconcileReminderNotificationsAfterImport\(\): Promise<void> \{[\s\S]{0,220}await this\.recoverReminderSnapshot\(\)[\s\S]{0,220}force: true/,
  "committed import must rebuild native reminders from the published generation",
);
assert.match(
  foregroundRefreshSection,
  /!this\.nativeReconciliationDirty[\s\S]{0,200}!this\.nativeChannelRefreshDirty[\s\S]{0,1800}force: true/,
  "failed native work must remain dormant until an explicit foreground repair",
);
assert.doesNotMatch(
  reminderServiceSource,
  /from "react-native"|expo-notifications|@\/i18n\/config|runtimeDb|\bSELECT\b|Intl\.DateTimeFormat|new Date\(/,
  "application reminder orchestration must depend only on explicit ports",
);
assert.match(
  reminderServiceSource,
  /const now = this\.dependencies\.clock\.now\(\)[\s\S]{0,800}buildUpcomingReminderDates\([\s\S]{0,180}\bnow\b/,
  "the application service must pass an injected instant to domain scheduling",
);
assert.doesNotMatch(
  reminderScheduleSource,
  /now\s*=/,
  "domain scheduling must not hide an environment clock default",
);
assert.match(
  reminderRepositorySource,
  /SELECT habit_id AS habitId, date, status[\s\S]{0,100}FROM day_records/,
  "the reminder day-record query must be owned by the SQLite adapter",
);
assert.match(
  expoNotificationAdapterSource,
  /import\("expo-notifications\/build\/scheduleNotificationAsync"\)/,
  "local notifications must retain the direct lazy Expo import path",
);
assert.doesNotMatch(
  expoNotificationAdapterSource,
  /await import\("expo-notifications"\)/,
  "runtime code must not load the Expo notification barrel",
);
assert.equal(
  reminderCompositionSource.match(/createReminderService\(/g)?.length,
  1,
  "composition must wire exactly one reminder application singleton",
);
assert.match(
  reminderToggleSetter,
  /settingsMutationCoordinator\.submit\(\{[\s\S]{0,100}scope,[\s\S]{0,100}value: enabled/,
  "the reminder toggle must submit one typed value for durable and native reconciliation",
);
const settingsCommandExecution = sourceSection(
  settingsCoordinatorSource,
  "  private async executeCommand<Scope extends SettingMutationScope>(",
  "  private requestSideEffect(",
);
const settingsPersistenceIndex = settingsCommandExecution.indexOf(
  'if (persistence.kind === "write")',
);
const durableConfirmationIndex = settingsCommandExecution.indexOf(
  "this.confirmCommittedValue(",
);
const nativeEffectRequestIndex = settingsCommandExecution.indexOf(
  'this.requestSideEffect(effect.scope, revision, effect.effect, "apply");',
);
assert.ok(
  settingsPersistenceIndex >= 0 &&
    durableConfirmationIndex > settingsPersistenceIndex &&
    nativeEffectRequestIndex > durableConfirmationIndex,
  "SQLite must confirm the durable baseline before slow native reconciliation is requested",
);
assert.match(
  settingsCoordinatorSource,
  /scope === "reminderNotifications"[\s\S]{0,180}kind: "reminder-master", enabled: value as boolean/,
  "the coordinator must derive reminder reconciliation from the same value it persists",
);
assert.match(
  settingsCoordinatorSource,
  /if \(!this\.isCurrent\(requested\.scope, requested\.revision\)\)\s*continue;/,
  "only the latest durable intent may reach the native side-effect owner",
);
assert.match(
  settingsCoordinatorSource,
  /const confirmedValue = this\.getConfirmedValue\(command\.scope\)[\s\S]{0,400}const effect = sideEffectForValue\(command\.scope, confirmedValue\)[\s\S]{0,320}"rollback"/,
  "a failed latest toggle must publish the confirmed rollback intent",
);
assert.match(
  settingsCompositionSource,
  /setReminderMasterEnabled: \(enabled, phase\)[\s\S]{0,180}requestPermission: enabled && phase === "apply"/,
  "only an explicit successful reminder-enable intent may present notification permission UI; load, repair and rollback remain passive",
);
assert.match(
  settingsCoordinatorSource,
  /reconcileConfirmedSideEffect\([\s\S]{0,420}requestSideEffect\(effect\.scope, revision, effect\.effect, "reconcile"\)/,
  "a loaded reminder value must carry a distinct passive reconciliation phase instead of impersonating a user apply",
);

auditReminderScheduleDates();

let auditDeadline: ReturnType<typeof setTimeout>;
const auditTimeout = new Promise<never>((_, reject) => {
  auditDeadline = setTimeout(() => reject(new Error("Reminder audit did not reach its terminal boundary")), 30000);
});
void Promise.race([
  (async () => {
    await auditDeferredReminderCoordinator();
    await auditBackgroundReminderAdmission();
    await auditDeferredWorkAcceptedDuringDrain();
    await auditReminderReplacementGate();
    await auditQuiescentFreezeHasNoAdmissionGap();
    await auditReminderServiceBehavior();
    await auditReminderSnapshotRecovery();
    await auditDeniedReminderCleanup();
    await auditReminderCivilDateRefill();
    await auditNotificationAdapterBehavior();
    console.log("Reminder sync audit passed.");
  })(),
  auditTimeout,
]).then(
  () => clearTimeout(auditDeadline),
  (error) => {
    clearTimeout(auditDeadline);
    console.error(error);
    process.exitCode = 1;
  },
);
