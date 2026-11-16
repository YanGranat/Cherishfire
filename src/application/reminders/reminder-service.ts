import { format } from "date-fns/format";
import { DeferredReminderWorkCoordinator } from "@/application/reminders/deferred-reminder-work-coordinator";
import type {
  ReminderDayRecordReadPort,
  ReminderClockPort,
  ReminderNativeScheduleInput,
  ReminderNotificationPort,
  ScheduledHabitReminder,
  ReminderWorkSchedulingPort,
  ReminderSnapshotReadPort,
} from "@/application/reminders/reminder-ports";
import {
  ReminderReplacementGate,
  type ReminderReplacementBoundary,
  type ReminderReplacementOutcome,
} from "@/application/reminders/reminder-replacement-gate";
import {
  buildUpcomingReminderDates,
  canScheduleHabitReminders,
  isReminderRecordedStatus,
  REMINDER_MAX_PER_HABIT,
  type ReminderScheduleRecord,
} from "@/domain/reminders/reminder-schedule";
import { buildReminderSyncSignature } from "@/domain/reminders/reminder-sync-signature";
import type { Habit } from "@/types/habit";

// Notification bridges can enqueue native work on the same Android UI thread
// that must commit the next app frame. Yield after every native unit: reminder
// reconciliation is background maintenance and must never consume a visible
// interaction burst merely to finish sooner.
const REMINDER_WORK_UNITS_PER_UI_YIELD = 1;

interface ReminderSyncOptions {
  readonly force?: boolean;
  readonly refreshAndroidChannel?: boolean;
  readonly requestPermission?: boolean;
  readonly refillPending?: boolean;
}

export interface ReminderSyncIntent {
  /**
   * System permission UI is allowed only when this sync was caused by the
   * user explicitly enabling/saving a reminder. Background reconciliation
   * must leave this false.
   */
  readonly requestPermission?: boolean;
}

interface ReminderWorkControl {
  isCurrent(): boolean;
  checkpoint(workUnits?: number): Promise<boolean>;
}

interface DesiredReminderSchedule {
  readonly input: ReminderNativeScheduleInput;
  readonly scheduleKey: string;
}

interface FullReminderSyncRequest {
  readonly revision: number;
  readonly habitsSnapshot: Habit[];
  readonly signature: string;
  readonly now: Date;
  readonly planningDate: string;
  readonly force: boolean;
  readonly refreshAndroidChannel: boolean;
  readonly requestPermission: boolean;
  readonly permissionRequestRevision: number;
  readonly refillPending: boolean;
}

export interface PendingReminderReplacementBoundary {
  readonly token: ReminderReplacementBoundary;
  release(outcome: ReminderReplacementOutcome): Promise<void>;
}

export interface ReminderServiceDependencies {
  readonly snapshot: ReminderSnapshotReadPort;
  readonly dayRecords: ReminderDayRecordReadPort;
  readonly notifications: ReminderNotificationPort;
  readonly workScheduling: ReminderWorkSchedulingPort;
  readonly clock: ReminderClockPort;
}

export interface ReminderService {
  setReminderNotificationsEnabled(
    enabled: boolean,
    intent?: ReminderSyncIntent,
  ): Promise<void>;
  scheduleReminderNotificationLocalizationRefresh(): void;
  refreshReminderNotificationTimezone(): Promise<void>;
  subscribeToReminderNotificationResponses(
    onOpenMainScreen: () => void,
  ): () => void;
  warmupHabitReminders(): Promise<void>;
  scheduleHabitRemindersSync(
    habitsList: Habit[],
    intent?: ReminderSyncIntent,
  ): void;
  scheduleHabitReminderAfterRecordChange(
    habitsList: Habit[],
    habitId: number,
  ): void;
  startPendingReminderWorkBeforeBackground(): void;
  flushAndFreezePendingReminderWork(): Promise<PendingReminderReplacementBoundary>;
  reconcileReminderNotificationsAfterImport(): Promise<void>;
}

class ReminderApplicationService implements ReminderService {
  private syncQueue: Promise<void> = Promise.resolve();
  private queuedReminderSyncCount = 0;
  private lastSyncSignature: string | null = null;
  private requestedFullSyncRevision = 0;
  private settledFullSyncRevision = 0;
  private appliedFullSyncRevision = 0;
  private forcedFullSyncRevision = 0;
  private refreshAndroidChannelRevision = 0;
  private permissionRequestRevision = 0;
  private settledPermissionRequestRevision = 0;
  private pendingExplicitPermissionRequest = false;
  private lastObservedNotificationPermission: boolean | null = null;
  private latestFullSyncSnapshot: Habit[] = [];
  private fullSyncDrainPromise: Promise<void> | null = null;
  private fullSyncWaiters: {
    revision: number;
    resolve: (succeeded: boolean) => void;
  }[] = [];
  private reminderNotificationsEnabled = true;
  // Updated by accepted habit commands or authoritative import recovery only.
  private latestHabitsSnapshot: Habit[] = [];
  private lastDeviceTimezoneSignature: string;
  private nativeReconciliationDirty = false;
  private nativeChannelRefreshDirty = false;
  private lastPlanningDate: string | null = null;
  private snapshotGeneration = 0;
  private masterSettingRevision = 0;
  private snapshotRecoveryRequired = false;
  private snapshotRecoveryPromise: Promise<void> | null = null;
  private foregroundRefreshPromise: Promise<void> | null = null;
  // A failed capacity-only attempt may retry the same plan, but a later
  // authoritative revision must not inherit its overdue-retention policy.
  private capacityRefreshRevision = 0;
  // Scheduling inputs are only a trigger-time hint. Native pending requests
  // remain authoritative for delivery and available capacity.
  private readonly admittedSchedules = new Map<string, DesiredReminderSchedule>();

  private readonly replacementGate: ReminderReplacementGate;
  private readonly deferredWork: DeferredReminderWorkCoordinator;

  constructor(private readonly dependencies: ReminderServiceDependencies) {
    this.lastDeviceTimezoneSignature =
      this.dependencies.clock.timezoneSignature();
    this.replacementGate = new ReminderReplacementGate(
      () => undefined,
      () => {
        // Invalidate before admission opens. A failed read cannot let later
        // native work reuse a pre-import snapshot or permission intent.
        this.snapshotGeneration += 1;
        this.snapshotRecoveryRequired = true;
        this.lastSyncSignature = null;
        this.nativeReconciliationDirty = true;
        this.pendingExplicitPermissionRequest = false;
        this.capacityRefreshRevision = 0;
        this.admittedSchedules.clear();
      },
    );
    this.deferredWork = new DeferredReminderWorkCoordinator({
      scheduleAfterUiSettles: (task) =>
        this.dependencies.workScheduling.scheduleAfterUiSettles(task),
      isAppActive: () => this.dependencies.workScheduling.isAppActive(),
      runFullSync: (includesRecordChanges) => {
        const requestPermission = this.pendingExplicitPermissionRequest;
        this.pendingExplicitPermissionRequest = false;
        return this.syncHabitReminders(this.latestHabitsSnapshot, {
          force: includesRecordChanges,
          requestPermission,
        });
      },
      runRecordSync: (habitIds) =>
        this.syncHabitRemindersAfterRecordChanges(
          this.latestHabitsSnapshot,
          habitIds,
        ),
      runLocalizationRefresh: () =>
        this.refreshReminderNotificationLocalization(),
      onError: () => undefined,
    });
  }

  setReminderNotificationsEnabled(
    enabled: boolean,
    intent?: ReminderSyncIntent,
  ): Promise<void> {
    return this.replacementGate.run(async () => {
      const revision = ++this.masterSettingRevision;
      this.snapshotGeneration += 1;
      if (this.snapshotRecoveryRequired) await this.recoverReminderSnapshot();
      if (revision !== this.masterSettingRevision) return;
      await this.setReminderNotificationsEnabledNow(enabled, intent);
    });
  }

  scheduleReminderNotificationLocalizationRefresh(): void {
    this.replacementGate.schedule(async () => {
      this.deferredWork.scheduleLocalizationRefresh();
    });
  }

  refreshReminderNotificationTimezone(): Promise<void> {
    if (this.foregroundRefreshPromise) return this.foregroundRefreshPromise;
    const refresh = this.replacementGate.run(() =>
      this.refreshReminderNotificationTimezoneNow(),
    );
    const tracked = refresh.finally(() => {
      if (this.foregroundRefreshPromise === tracked) {
        this.foregroundRefreshPromise = null;
      }
    });
    this.foregroundRefreshPromise = tracked;
    return tracked;
  }

  subscribeToReminderNotificationResponses(
    onOpenMainScreen: () => void,
  ): () => void {
    return this.dependencies.notifications.subscribeToResponses(
      onOpenMainScreen,
    );
  }

  warmupHabitReminders(): Promise<void> {
    return this.replacementGate.run(() => this.warmupHabitRemindersNow());
  }

  scheduleHabitRemindersSync(
    habitsList: Habit[],
    intent?: ReminderSyncIntent,
  ): void {
    const habitsSnapshot = [...habitsList];
    this.replacementGate.schedule(async () => {
      this.snapshotGeneration += 1;
      this.latestHabitsSnapshot = habitsSnapshot;
      if (intent?.requestPermission) {
        this.pendingExplicitPermissionRequest = true;
      }
      this.deferredWork.scheduleFullSync();
    });
  }

  scheduleHabitReminderAfterRecordChange(
    habitsList: Habit[],
    habitId: number,
  ): void {
    const habitsSnapshot = [...habitsList];
    this.replacementGate.schedule(async () => {
      this.snapshotGeneration += 1;
      this.latestHabitsSnapshot = habitsSnapshot;
      this.capacityRefreshRevision = 0;
      this.deferredWork.scheduleRecordSync(habitId);
    });
  }

  startPendingReminderWorkBeforeBackground(): void {
    this.deferredWork.startAcceptedWorkNow();
  }

  async flushAndFreezePendingReminderWork(): Promise<PendingReminderReplacementBoundary> {
    let token: ReminderReplacementBoundary | null = null;
    await this.deferredWork.flushAndWait(() => {
      token = this.replacementGate.enter();
    });
    if (!token) {
      throw new Error("Reminder replacement boundary was not captured");
    }
    await this.replacementGate.waitForRunning();
    const capturedToken = token;
    return {
      token: capturedToken,
      release: (outcome) => this.replacementGate.release(capturedToken, outcome),
    };
  }

  reconcileReminderNotificationsAfterImport(): Promise<void> {
    return this.replacementGate.run(async () => {
      await this.recoverReminderSnapshot();
      const succeeded = await this.syncHabitRemindersNow(
        this.latestHabitsSnapshot,
        { force: true },
      );
      if (!succeeded) {
        throw new Error("Reminder import reconciliation failed");
      }
    });
  }

  private recoverReminderSnapshot(): Promise<void> {
    if (this.snapshotRecoveryPromise) return this.snapshotRecoveryPromise;
    const recovery = (async () => {
      while (this.snapshotRecoveryRequired) {
        const generation = this.snapshotGeneration;
        let snapshot: Awaited<
          ReturnType<ReminderSnapshotReadPort["readSnapshot"]>
        >;
        try {
          snapshot = await this.dependencies.snapshot.readSnapshot();
        } catch (error) {
          if (generation !== this.snapshotGeneration) continue;
          throw error;
        }
        // A newer durable habit/master command invalidates both halves of
        // this read. Check and publish in the same turn, without another await.
        if (generation !== this.snapshotGeneration) continue;
        this.latestHabitsSnapshot = [...snapshot.habits];
        this.reminderNotificationsEnabled = snapshot.notificationsEnabled;
        this.snapshotRecoveryRequired = false;
      }
    })();
    const tracked = recovery.finally(() => {
      if (this.snapshotRecoveryPromise === tracked) {
        this.snapshotRecoveryPromise = null;
      }
    });
    this.snapshotRecoveryPromise = tracked;
    return tracked;
  }

  private createWorkControl(isCurrent: () => boolean): ReminderWorkControl {
    let workUnitsSinceYield = 0;
    return {
      isCurrent,
      checkpoint: async (workUnits = 1) => {
        if (!isCurrent()) return false;
        workUnitsSinceYield += workUnits;
        if (workUnitsSinceYield < REMINDER_WORK_UNITS_PER_UI_YIELD) {
          return true;
        }
        workUnitsSinceYield = 0;
        // Keep native mutations sequential while yielding a macrotask after a
        // bounded amount of work so pending navigation/render work can run.
        await this.dependencies.workScheduling.yieldToUi();
        return isCurrent();
      },
    };
  }

  private async loadReminderRecordsByHabit(
    habitsList: readonly Habit[],
  ): Promise<Map<number, ReminderScheduleRecord[]>> {
    const trackedHabitIds = habitsList.map((habit) => habit.id);
    if (trackedHabitIds.length === 0) return new Map();

    const rows =
      await this.dependencies.dayRecords.readByHabitIds(trackedHabitIds);
    const recordsByHabit = new Map<number, ReminderScheduleRecord[]>();
    for (const row of rows) {
      if (!isReminderRecordedStatus(row.status)) continue;
      const record = { date: row.date, status: row.status };
      const records = recordsByHabit.get(row.habitId);
      if (records) records.push(record);
      else recordsByHabit.set(row.habitId, [record]);
    }
    return recordsByHabit;
  }

  private async cancelScheduledReminderIds(
    identifiers: readonly string[],
    control?: ReminderWorkControl,
  ): Promise<boolean> {
    for (const identifier of identifiers) {
      if (control && !control.isCurrent()) return false;
      await this.dependencies.notifications.cancelScheduledReminder(identifier);
      if (control && !(await control.checkpoint())) return false;
    }
    return true;
  }

  private async cancelAllScheduledHabitReminders(
    control?: ReminderWorkControl,
  ): Promise<{ canceledCount: number; completed: boolean }> {
    const existingByHabit =
      await this.dependencies.notifications.listScheduledHabitReminders();
    if (control && !(await control.checkpoint())) {
      return { canceledCount: 0, completed: false };
    }
    const identifiers: string[] = [];
    for (const habitReminders of existingByHabit.values()) {
      identifiers.push(
        ...habitReminders.map((reminder) => reminder.identifier),
      );
    }
    if (identifiers.length > 0) {
      const completed = await this.cancelScheduledReminderIds(
        identifiers,
        control,
      );
      if (!completed) {
        return { canceledCount: identifiers.length, completed: false };
      }
    }
    this.admittedSchedules.clear();
    return { canceledCount: identifiers.length, completed: true };
  }

  private buildDesiredSchedules(
    habit: Habit,
    dates: readonly Date[],
  ): DesiredReminderSchedule[] {
    return dates.map((date) => {
      const input = {
        habitId: habit.id,
        habitName: habit.name,
        date,
      };
      return {
        input,
        scheduleKey:
          this.dependencies.notifications.getHabitReminderScheduleKey(input),
      };
    });
  }

  private async reconcileDesiredSchedules(
    desiredSchedules: readonly DesiredReminderSchedule[],
    existingByHabit: ReadonlyMap<number, readonly ScheduledHabitReminder[]>,
    control?: ReminderWorkControl,
    scopeHabitIds?: ReadonlySet<number>,
    allowScheduling = true,
  ): Promise<boolean> {
    const pendingKeys = new Set<string>();
    for (const reminders of existingByHabit.values()) {
      for (const reminder of reminders) {
        if (reminder.scheduleKey != null) pendingKeys.add(reminder.scheduleKey);
      }
    }
    for (const key of this.admittedSchedules.keys()) {
      if (!pendingKeys.has(key)) this.admittedSchedules.delete(key);
    }
    const desiredByKey = new Map<string, DesiredReminderSchedule>();
    const desiredHabitIds = new Set<number>();
    for (const desired of desiredSchedules) {
      desiredHabitIds.add(desired.input.habitId);
      if (!desiredByKey.has(desired.scheduleKey)) {
        desiredByKey.set(desired.scheduleKey, desired);
      }
    }

    const existing: ScheduledHabitReminder[] = [];
    for (const [habitId, reminders] of existingByHabit) {
      if (scopeHabitIds && !scopeHabitIds.has(habitId)) continue;
      existing.push(...reminders);
    }
    const availableByKey = new Map<string, ScheduledHabitReminder[]>();
    for (const reminder of existing) {
      if (reminder.scheduleKey == null) continue;
      const matches = availableByKey.get(reminder.scheduleKey);
      if (matches) matches.push(reminder);
      else availableByKey.set(reminder.scheduleKey, [reminder]);
    }

    const keptIdentifiers = new Set<string>();
    const missing: DesiredReminderSchedule[] = [];
    for (const desired of desiredByKey.values()) {
      const matches = availableByKey.get(desired.scheduleKey);
      const match = matches?.shift();
      if (match) {
        keptIdentifiers.add(match.identifier);
      } else {
        missing.push(desired);
      }
    }

    const stale = existing.filter(
      (reminder) => !keptIdentifiers.has(reminder.identifier),
    );
    // Release orphan/inactive slots first, then replace changed active
    // requests. Besides retaining deterministic behavior, this maximizes the
    // available native capacity before installing a new plan.
    stale.sort(
      (left, right) =>
        Number(desiredHabitIds.has(left.habitId)) -
        Number(desiredHabitIds.has(right.habitId)),
    );
    const staleIdentifiers = stale.map((reminder) => reminder.identifier);
    if (
      staleIdentifiers.length > 0 &&
      !(await this.cancelScheduledReminderIds(staleIdentifiers, control))
    ) {
      return false;
    }

    for (const desired of allowScheduling ? missing : []) {
      if (control && !control.isCurrent()) return false;
      await this.dependencies.notifications.scheduleHabitReminder(
        desired.input,
      );
      // A later unit can fail after this request has already been accepted.
      this.admittedSchedules.set(desired.scheduleKey, desired);
      if (control && !(await control.checkpoint())) return false;
    }

    if (control && !control.isCurrent()) return false;
    for (const [key, schedule] of this.admittedSchedules) {
      if (!scopeHabitIds || scopeHabitIds.has(schedule.input.habitId)) {
        this.admittedSchedules.delete(key);
      }
    }
    const missingKeys = new Set(missing.map((schedule) => schedule.scheduleKey));
    for (const desired of desiredByKey.values()) {
      if (allowScheduling || !missingKeys.has(desired.scheduleKey)) {
        this.admittedSchedules.set(desired.scheduleKey, desired);
      }
    }
    return true;
  }

  private pendingMatchesAdmittedSchedules(
    existingByHabit: ReadonlyMap<number, readonly ScheduledHabitReminder[]>,
  ): boolean {
    const keys = new Set<string>();
    for (const reminders of existingByHabit.values()) {
      for (const reminder of reminders) {
        if (
          reminder.scheduleKey == null ||
          keys.has(reminder.scheduleKey) ||
          !this.admittedSchedules.has(reminder.scheduleKey)
        ) {
          return false;
        }
        keys.add(reminder.scheduleKey);
      }
    }
    return keys.size === this.admittedSchedules.size;
  }

  private pendingOverdueSchedules(
    existingByHabit: ReadonlyMap<number, readonly ScheduledHabitReminder[]>,
    recordsByHabit: ReadonlyMap<number, readonly ReminderScheduleRecord[]>,
    now: Date,
  ): DesiredReminderSchedule[] {
    const retained = new Map<string, DesiredReminderSchedule>();
    for (const reminders of existingByHabit.values()) {
      for (const reminder of reminders) {
        const admitted =
          reminder.scheduleKey == null
            ? undefined
            : this.admittedSchedules.get(reminder.scheduleKey);
        if (!admitted || admitted.input.date.getTime() > now.getTime()) continue;
        const handled = recordsByHabit.get(admitted.input.habitId)?.some(
          (record) => record.date === format(admitted.input.date, "yyyy-MM-dd"),
        );
        if (!handled) retained.set(admitted.scheduleKey, admitted);
      }
    }
    return [...retained.values()];
  }

  private async replaceGloballyLimitedReminderSchedule(
    habits: readonly Habit[],
    existingByHabit: ReadonlyMap<number, readonly ScheduledHabitReminder[]>,
    recordsByHabit: ReadonlyMap<number, readonly ReminderScheduleRecord[]>,
    pendingReminderLimit: number,
    control: ReminderWorkControl,
    now: Date,
    allowScheduling: boolean,
    retainedOverdue: readonly DesiredReminderSchedule[] = [],
  ): Promise<boolean> {
    const candidates: {
      readonly habit: Habit;
      readonly date: Date;
      readonly habitOrder: number;
      readonly dateOrder: number;
    }[] = [];

    for (let habitOrder = 0; habitOrder < habits.length; habitOrder += 1) {
      if (!control.isCurrent()) return false;
      const habit = habits[habitOrder];
      if (!habit) continue;
      const dates = buildUpcomingReminderDates(
        habit,
        recordsByHabit.get(habit.id) ?? [],
        now,
      );
      for (let dateOrder = 0; dateOrder < dates.length; dateOrder += 1) {
        const date = dates[dateOrder];
        if (!date) continue;
        candidates.push({ habit, date, habitOrder, dateOrder });
      }
      if (!(await control.checkpoint())) return false;
    }

    candidates.sort(
      (left, right) =>
        left.date.getTime() - right.date.getTime() ||
        left.habitOrder - right.habitOrder ||
        left.dateOrder - right.dateOrder,
    );
    const selected = candidates.slice(
      0,
      Math.max(0, Math.floor(pendingReminderLimit) - retainedOverdue.length),
    );

    const desired = [
      ...retainedOverdue,
      ...selected.flatMap((candidate) =>
        this.buildDesiredSchedules(candidate.habit, [candidate.date]),
      ),
    ];
    if (
      !(await this.reconcileDesiredSchedules(
        desired,
        existingByHabit,
        control,
        undefined,
        allowScheduling,
      ))
    ) {
      return false;
    }

    return true;
  }

  private async setReminderNotificationsEnabledNow(
    enabled: boolean,
    intent?: ReminderSyncIntent,
  ): Promise<void> {
    const normalized = Boolean(enabled);
    if (
      this.reminderNotificationsEnabled === normalized &&
      !this.nativeReconciliationDirty
    ) {
      return;
    }
    this.reminderNotificationsEnabled = normalized;
    this.lastSyncSignature = null;
    const succeeded = await this.syncHabitRemindersNow(
      this.latestHabitsSnapshot,
      {
        force: true,
        requestPermission: normalized && intent?.requestPermission === true,
      },
    );
    if (!succeeded) {
      throw new Error("Reminder master-setting reconciliation failed");
    }
  }

  private async refreshReminderNotificationLocalizationNow(): Promise<void> {
    this.nativeChannelRefreshDirty = true;
    if (this.snapshotRecoveryRequired) await this.recoverReminderSnapshot();
    if (this.latestHabitsSnapshot.length === 0) {
      this.lastSyncSignature = null;
      try {
        await this.dependencies.notifications.configure({
          refreshAndroidChannel: true,
        });
        this.nativeChannelRefreshDirty = false;
      } catch (error) {
        throw error;
      }
      return;
    }
    const succeeded = await this.syncHabitRemindersNow(
      this.latestHabitsSnapshot,
      {
        force: true,
        refreshAndroidChannel: true,
      },
    );
    if (!succeeded) {
      throw new Error("Reminder localization reconciliation failed");
    }
  }

  private refreshReminderNotificationLocalization(): Promise<void> {
    return this.replacementGate.run(() =>
      this.refreshReminderNotificationLocalizationNow(),
    );
  }

  private async refreshReminderNotificationTimezoneNow(): Promise<void> {
    if (this.snapshotRecoveryRequired) await this.recoverReminderSnapshot();
    const nextSignature = this.dependencies.clock.timezoneSignature();
    const timezoneChanged = nextSignature !== this.lastDeviceTimezoneSignature;
    const planningDateChanged =
      format(this.dependencies.clock.now(), "yyyy-MM-dd") !==
      this.lastPlanningDate;
    const now = this.dependencies.clock.now();
    const hasConfiguredReminder =
      this.reminderNotificationsEnabled &&
      this.latestHabitsSnapshot.some((habit) =>
        canScheduleHabitReminders(habit),
      );
    if (
      hasConfiguredReminder &&
      this.lastObservedNotificationPermission != null
    ) {
      const currentPermission =
        await this.dependencies.notifications.hasPermission();
      if (currentPermission !== this.lastObservedNotificationPermission) {
        this.lastObservedNotificationPermission = currentPermission;
        this.lastSyncSignature = null;
        this.nativeReconciliationDirty = true;
      }
    }
    if (
      !timezoneChanged &&
      !planningDateChanged &&
      !this.nativeChannelRefreshDirty &&
      hasConfiguredReminder &&
      this.queuedReminderSyncCount === 0 &&
      this.settledFullSyncRevision === this.requestedFullSyncRevision &&
      (this.buildFullSyncSignature(
        this.latestHabitsSnapshot,
        format(now, "yyyy-MM-dd"),
      ) === this.lastSyncSignature ||
        this.capacityRefreshRevision === this.requestedFullSyncRevision) &&
      [...this.admittedSchedules.values()].some(
        (schedule) => schedule.input.date.getTime() <= now.getTime(),
      )
    ) {
      const succeeded = await this.syncHabitRemindersNow(
        this.latestHabitsSnapshot,
        { force: true, refillPending: true },
      );
      if (!succeeded) throw new Error("Reminder foreground reconciliation failed");
      return;
    }
    if (
      !timezoneChanged &&
      !planningDateChanged &&
      !this.nativeReconciliationDirty &&
      !this.nativeChannelRefreshDirty
    ) {
      return;
    }
    if (timezoneChanged || planningDateChanged) {
      this.lastDeviceTimezoneSignature = nextSignature;
      this.lastSyncSignature = null;
    }
    if (
      this.nativeChannelRefreshDirty &&
      !this.nativeReconciliationDirty &&
      this.latestHabitsSnapshot.length === 0
    ) {
      await this.dependencies.notifications.configure({
        refreshAndroidChannel: true,
      });
      this.nativeChannelRefreshDirty = false;
      return;
    }
    if (
      this.latestHabitsSnapshot.length === 0 &&
      !this.nativeReconciliationDirty
    ) {
      return;
    }
    const succeeded = await this.syncHabitRemindersNow(
      this.latestHabitsSnapshot,
      {
        force: true,
        refreshAndroidChannel: this.nativeChannelRefreshDirty,
      },
    );
    if (!succeeded) {
      throw new Error("Reminder foreground reconciliation failed");
    }
  }

  private async warmupHabitRemindersNow(): Promise<void> {
    try {
      await this.dependencies.notifications.configure();
    } catch {
      // Warmup is best-effort only.
    }
  }

  private enqueueReminderSync(task: () => Promise<void>): Promise<boolean> {
    this.queuedReminderSyncCount += 1;
    const queued = this.syncQueue.then(task);
    const outcome = queued.then(
      () => true,
      () => {
        this.lastSyncSignature = null;
        this.nativeReconciliationDirty = true;
        return false;
      },
    );
    const trackedOutcome = outcome.finally(() => {
      this.queuedReminderSyncCount = Math.max(
        0,
        this.queuedReminderSyncCount - 1,
      );
    });
    this.syncQueue = trackedOutcome.then(() => undefined);
    return trackedOutcome;
  }

  private isFullReminderSyncCurrent(revision: number): boolean {
    return revision === this.requestedFullSyncRevision;
  }

  private settleFullSyncWaiters(revision: number, succeeded: boolean): void {
    const remaining: typeof this.fullSyncWaiters = [];
    for (const waiter of this.fullSyncWaiters) {
      if (waiter.revision <= revision) waiter.resolve(succeeded);
      else remaining.push(waiter);
    }
    this.fullSyncWaiters = remaining;
  }

  private async performFullReminderSync(
    request: FullReminderSyncRequest,
  ): Promise<boolean> {
    const control = this.createWorkControl(() =>
      this.isFullReminderSyncCurrent(request.revision),
    );
    if (
      !request.force &&
      !request.requestPermission &&
      request.signature === this.lastSyncSignature
    ) {
      return true;
    }

    const configured = await this.dependencies.notifications.configure({
      refreshAndroidChannel: request.refreshAndroidChannel,
    });
    if (!configured || !control.isCurrent()) {
      if (control.isCurrent()) this.lastSyncSignature = null;
      return false;
    }
    if (!(await control.checkpoint())) return false;

    if (!this.reminderNotificationsEnabled) {
      // An explicit per-habit enable cannot own a future permission prompt
      // while the global reminder master is off. Consume that one-shot intent
      // now; a later explicit master enable will create its own fresh intent.
      if (request.requestPermission) {
        this.settledPermissionRequestRevision = Math.max(
          this.settledPermissionRequestRevision,
          request.permissionRequestRevision,
        );
      }
      const cancellation = await this.cancelAllScheduledHabitReminders(control);
      if (!cancellation.completed || !control.isCurrent()) return false;
      this.lastSyncSignature = request.signature;
      return true;
    }

    const toSchedule = request.habitsSnapshot.filter((habit) =>
      canScheduleHabitReminders(habit),
    );
    if (toSchedule.length === 0) {
      if (request.requestPermission) {
        this.settledPermissionRequestRevision = Math.max(
          this.settledPermissionRequestRevision,
          request.permissionRequestRevision,
        );
      }
      const existingByHabit =
        await this.dependencies.notifications.listScheduledHabitReminders();
      if (!(await control.checkpoint())) return false;
      if (
        !(await this.reconcileDesiredSchedules([], existingByHabit, control))
      ) {
        return false;
      }
      if (!control.isCurrent()) return false;
      this.lastSyncSignature = request.signature;
      return true;
    }

    let explicitPermissionGranted: boolean | null = null;
    if (request.requestPermission) {
      // Prompt authority is a one-shot consequence of the originating user
      // action. Consume it before crossing the native boundary so a thrown or
      // interrupted request can never be replayed by unrelated background
      // reconciliation. A later explicit user action creates a new revision.
      this.settledPermissionRequestRevision = Math.max(
        this.settledPermissionRequestRevision,
        request.permissionRequestRevision,
      );
      explicitPermissionGranted =
        await this.dependencies.notifications.requestPermission();
      this.lastObservedNotificationPermission = explicitPermissionGranted;
      if (!(await control.checkpoint())) return false;
    }

    const granted =
      explicitPermissionGranted ??
      (await this.dependencies.notifications.hasPermission());
    this.lastObservedNotificationPermission = granted;
    if (!control.isCurrent()) return false;
    if (!(await control.checkpoint())) return false;

    // Delivery permission gates creation, not cleanup. Revocation does not
    // remove pending native requests, which could fire after an external grant.
    const existingByHabit =
      await this.dependencies.notifications.listScheduledHabitReminders();
    if (!(await control.checkpoint())) return false;

    if (
      request.refillPending &&
      granted &&
      !this.nativeReconciliationDirty &&
      this.pendingMatchesAdmittedSchedules(existingByHabit)
    ) {
      this.lastSyncSignature = request.signature;
      return true;
    }

    const completionRecordsByHabit =
      await this.loadReminderRecordsByHabit(toSchedule);
    if (!(await control.checkpoint())) return false;

    // An elapsed trigger is not proof of delivery: Android may still hold an
    // inexact request. Only a same-plan capacity refill retains those requests.
    const retainedOverdue =
      request.refillPending && granted
        ? this.pendingOverdueSchedules(
            existingByHabit,
            completionRecordsByHabit,
            request.now,
          )
        : [];

    const pendingReminderLimit =
      this.dependencies.notifications.pendingReminderLimit;
    if (pendingReminderLimit != null) {
      if (
        !(await this.replaceGloballyLimitedReminderSchedule(
          toSchedule,
          existingByHabit,
          completionRecordsByHabit,
          pendingReminderLimit,
          control,
          request.now,
          granted,
          retainedOverdue,
        ))
      ) {
        return false;
      }
    } else {
      const desired: DesiredReminderSchedule[] = [...retainedOverdue];
      const now = request.now;
      for (const habit of toSchedule) {
        if (!control.isCurrent()) return false;
        const dates = buildUpcomingReminderDates(
          habit,
          completionRecordsByHabit.get(habit.id) ?? [],
          now,
        );
        const retainedCount = retainedOverdue.filter(
          (schedule) => schedule.input.habitId === habit.id,
        ).length;
        desired.push(
          ...this.buildDesiredSchedules(
            habit,
            dates.slice(0, Math.max(0, REMINDER_MAX_PER_HABIT - retainedCount)),
          ),
        );
        if (!(await control.checkpoint())) return false;
      }
      if (
        !(await this.reconcileDesiredSchedules(
          desired,
          existingByHabit,
          control,
          undefined,
          granted,
        ))
      ) {
        return false;
      }
    }

    if (!control.isCurrent()) return false;
    this.lastSyncSignature = request.signature;
    return true;
  }

  private async drainFullReminderSyncRequests(): Promise<void> {
    while (this.settledFullSyncRevision < this.requestedFullSyncRevision) {
      const revision = this.requestedFullSyncRevision;
      const habitsSnapshot = [...this.latestFullSyncSnapshot];
      const now = this.dependencies.clock.now();
      const planningDate = format(now, "yyyy-MM-dd");
      const request: FullReminderSyncRequest = {
        revision,
        habitsSnapshot,
        now,
        planningDate,
        signature: this.buildFullSyncSignature(habitsSnapshot, planningDate),
        force: this.forcedFullSyncRevision > this.appliedFullSyncRevision,
        refreshAndroidChannel:
          this.refreshAndroidChannelRevision > this.appliedFullSyncRevision,
        requestPermission:
          this.permissionRequestRevision >
          this.settledPermissionRequestRevision,
        permissionRequestRevision: this.permissionRequestRevision,
        refillPending: revision === this.capacityRefreshRevision,
      };
      let applied = false;
      const queueSettledWithoutError = await this.enqueueReminderSync(
        async () => {
          if (!this.isFullReminderSyncCurrent(revision)) return;
          applied = await this.performFullReminderSync(request);
        },
      );

      // A newer intent owns the final native state. Loop directly into it.
      if (!this.isFullReminderSyncCurrent(revision)) {
        continue;
      }

      this.settledFullSyncRevision = revision;
      if (queueSettledWithoutError) this.lastPlanningDate = request.planningDate;
      if (queueSettledWithoutError && applied) {
        this.appliedFullSyncRevision = revision;
      }
      // This terminal value distinguishes transient operational failures from
      // completed attempts. A denied permission is a stable reconciled state:
      // no native schedule is created and unrelated background changes must
      // not reopen the system sheet. Adapter/configuration failures reject,
      // keep the value false, and preserve the dirty retry.
      this.settleFullSyncWaiters(revision, queueSettledWithoutError);
    }
  }

  private ensureFullReminderSyncDrain(): void {
    if (this.fullSyncDrainPromise) return;
    this.fullSyncDrainPromise = this.drainFullReminderSyncRequests().finally(
      () => {
        this.fullSyncDrainPromise = null;
        if (this.settledFullSyncRevision < this.requestedFullSyncRevision) {
          this.ensureFullReminderSyncDrain();
        }
      },
    );
  }

  private requestFullReminderSync(
    habitsSnapshot: Habit[],
    options?: ReminderSyncOptions,
  ): Promise<boolean> {
    this.latestFullSyncSnapshot = [...habitsSnapshot];
    const revision = ++this.requestedFullSyncRevision;
    this.capacityRefreshRevision = options?.refillPending ? revision : 0;
    if (options?.force) this.forcedFullSyncRevision = revision;
    if (options?.refreshAndroidChannel) {
      this.refreshAndroidChannelRevision = revision;
    }
    if (options?.requestPermission) {
      this.permissionRequestRevision = revision;
    }

    const result = new Promise<boolean>((resolve) => {
      this.fullSyncWaiters.push({ revision, resolve });
    });
    this.ensureFullReminderSyncDrain();
    return result;
  }

  private async syncHabitRemindersNow(
    habitsList: Habit[],
    options?: ReminderSyncOptions,
  ): Promise<boolean> {
    const habitsSnapshot = [...habitsList];
    const signature = this.buildFullSyncSignature(
      habitsSnapshot,
      format(this.dependencies.clock.now(), "yyyy-MM-dd"),
    );

    if (
      !options?.force &&
      !options?.refreshAndroidChannel &&
      !options?.requestPermission &&
      this.queuedReminderSyncCount === 0 &&
      this.settledFullSyncRevision === this.requestedFullSyncRevision &&
      !this.nativeReconciliationDirty &&
      !this.nativeChannelRefreshDirty &&
      signature === this.lastSyncSignature
    ) {
      return true;
    }

    const attemptCompleted = await this.requestFullReminderSync(
      habitsSnapshot,
      options,
    );
    if (attemptCompleted) {
      this.nativeReconciliationDirty = false;
      if (options?.refreshAndroidChannel) {
        this.nativeChannelRefreshDirty = false;
      }
    } else {
      this.nativeReconciliationDirty = true;
    }
    return attemptCompleted;
  }

  private syncHabitReminders(
    habitsList: Habit[],
    options?: ReminderSyncOptions,
  ): Promise<void> {
    const habitsSnapshot = [...habitsList];
    return this.replacementGate.run(async () => {
      if (this.snapshotRecoveryRequired) {
        await this.recoverReminderSnapshot();
        await this.syncHabitRemindersNow(this.latestHabitsSnapshot, {
          ...options,
          force: true,
        });
        return;
      }
      await this.syncHabitRemindersNow(habitsSnapshot, options);
    });
  }

  private buildFullSyncSignature(habits: Habit[], planningDate: string): string {
    return JSON.stringify([
      planningDate,
      buildReminderSyncSignature(habits, this.reminderNotificationsEnabled),
    ]);
  }

  private async syncHabitRemindersAfterRecordChangesNow(
    habitsList: Habit[],
    habitIds: readonly number[],
  ): Promise<void> {
    const habitsSnapshot = [...habitsList];
    const changedHabitIds = [...new Set(habitIds)];

    const changedHabitIdSet = new Set(changedHabitIds);
    const changedHabits = this.reminderNotificationsEnabled
      ? habitsSnapshot.filter(
          (habit) =>
            changedHabitIdSet.has(habit.id) && canScheduleHabitReminders(habit),
        )
      : [];
    if (changedHabits.length === 0) {
      return;
    }

    if (this.dependencies.notifications.pendingReminderLimit != null) {
      // On iOS one completed/skipped/failed day changes the global 64-slot
      // competition. Rebuild all habits so the newly freed slot is filled by
      // the next chronological candidate, not just by the touched habit.
      await this.syncHabitRemindersNow(habitsSnapshot, {
        force: true,
      });
      return;
    }

    const fullSyncRevisionAtRequest = this.requestedFullSyncRevision;
    await this.enqueueReminderSync(async () => {
      // A pending/newer full rebuild owns the exact final result.
      if (
        this.settledFullSyncRevision < this.requestedFullSyncRevision ||
        fullSyncRevisionAtRequest !== this.requestedFullSyncRevision
      ) {
        return;
      }
      const control = this.createWorkControl(
        () =>
          this.reminderNotificationsEnabled &&
          fullSyncRevisionAtRequest === this.requestedFullSyncRevision,
      );
      const configured = await this.dependencies.notifications.configure();
      if (!configured) {
        return;
      }
      if (!(await control.checkpoint())) {
        return;
      }
      const granted = await this.dependencies.notifications.hasPermission();
      this.lastObservedNotificationPermission = granted;
      if (!(await control.checkpoint())) {
        return;
      }
      const existingByHabit =
        await this.dependencies.notifications.listScheduledHabitReminders();
      if (!(await control.checkpoint())) {
        return;
      }
      const recordsByHabit =
        await this.loadReminderRecordsByHabit(changedHabits);
      if (!(await control.checkpoint())) {
        return;
      }

      const now = this.dependencies.clock.now();
      const desired: DesiredReminderSchedule[] = [];
      for (const habit of changedHabits) {
        if (!control.isCurrent()) {
          return;
        }
        const dates = buildUpcomingReminderDates(
          habit,
          recordsByHabit.get(habit.id) ?? [],
          now,
        );
        desired.push(...this.buildDesiredSchedules(habit, dates));
        if (!(await control.checkpoint())) {
          return;
        }
      }
      if (
        !(await this.reconcileDesiredSchedules(
          desired,
          existingByHabit,
          control,
          changedHabitIdSet,
          granted,
        ))
      ) {
        return;
      }
    });
  }

  private syncHabitRemindersAfterRecordChanges(
    habitsList: Habit[],
    habitIds: readonly number[],
  ): Promise<void> {
    const habitsSnapshot = [...habitsList];
    return this.replacementGate.run(async () => {
      if (this.snapshotRecoveryRequired) {
        await this.recoverReminderSnapshot();
        await this.syncHabitRemindersNow(this.latestHabitsSnapshot, {
          force: true,
        });
        return;
      }
      await this.syncHabitRemindersAfterRecordChangesNow(
        habitsSnapshot,
        habitIds,
      );
    });
  }
}

export function createReminderService(
  dependencies: ReminderServiceDependencies,
): ReminderService {
  return new ReminderApplicationService(dependencies);
}
