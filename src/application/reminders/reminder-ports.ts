import type { Habit } from "@/types/habit";

export interface ReminderSnapshotReadPort {
  readSnapshot(): Promise<{
    readonly habits: Habit[];
    readonly notificationsEnabled: boolean;
  }>;
}

export interface ReminderDayRecordRow {
  readonly habitId: number;
  readonly date: string;
  readonly status: string;
}

export interface ReminderDayRecordReadPort {
  readByHabitIds(
    habitIds: readonly number[],
  ): Promise<readonly ReminderDayRecordRow[]>;
}

export interface ReminderNativeScheduleInput {
  readonly habitId: number;
  readonly habitName: string;
  readonly date: Date;
}

export interface ScheduledHabitReminder {
  readonly identifier: string;
  readonly habitId: number;
  /** `null` identifies a schedule created before exact reconciliation. */
  readonly scheduleKey: string | null;
}

export type ReminderPermissionStatus =
  | "granted"
  | "denied"
  | "undetermined"
  | "unavailable";

export interface ReminderNotificationPort {
  /**
   * Platform-specific application budget for pending local reminders. `null`
   * leaves scheduling bounded only by the per-habit planner.
   */
  readonly pendingReminderLimit: number | null;
  /**
   * Returns `false` only when notifications are intentionally unsupported by
   * the runtime. Native load/configuration failures reject so reconciliation
   * remains pending for a later explicit retry.
   */
  configure(options?: { refreshAndroidChannel?: boolean }): Promise<boolean>;
  /** Reads the current native permission without presenting system UI. */
  hasPermission(): Promise<boolean>;
  readPermissionStatus(): Promise<ReminderPermissionStatus>;
  /** Requests permission only from an explicit user-owned reminder action. */
  requestPermission(): Promise<boolean>;
  getHabitReminderScheduleKey(input: ReminderNativeScheduleInput): string;
  listScheduledHabitReminders(): Promise<Map<number, ScheduledHabitReminder[]>>;
  cancelScheduledReminder(identifier: string): Promise<void>;
  scheduleHabitReminder(input: ReminderNativeScheduleInput): Promise<void>;
  subscribeToResponses(onOpenMainScreen: () => void): () => void;
}

export interface ReminderDeferredWorkHandle {
  cancel(): void;
}

export interface ReminderWorkSchedulingPort {
  scheduleAfterUiSettles(task: () => void): ReminderDeferredWorkHandle;
  isAppActive(): boolean;
  yieldToUi(): Promise<void>;
}

export interface ReminderClockPort {
  now(): Date;
  timezoneSignature(): string;
}
