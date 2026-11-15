import type {
  DayRecord,
  DayStatus,
  Habit,
  RepeatSchedule,
  ScheduleHistoryEntry,
} from "@/types/habit";
import {
  closeArchivePeriod,
  startArchivePeriod,
} from "@/domain/habits/archive-periods";
import { planHabitScheduleEdit } from "@/domain/habits/schedule-edit";
import { getDescriptionLinesSettingKey } from "@/application/settings/habit-description-lines-setting";
import {
  assignDisplayOrdersAroundArchivedSlots,
  assertValidDisplayOrder,
  type DisplayOrderRow,
} from "@/domain/habits/display-order";

export interface HabitSchedulePatch {
  repeatSchedule: RepeatSchedule;
  scheduleHistory: ScheduleHistoryEntry[];
  startDate: string;
}

/** Domain-shaped patch. SQLite column names and Date wrappers stay in data. */
export type HabitPatch = Partial<
  Pick<
    Habit,
    | "name"
    | "description"
    | "descriptionVisible"
    | "reminderEnabled"
    | "reminderTime"
    | "displayOrder"
    | "isArchived"
    | "archivedAt"
    | "archiveHistory"
    | "updatedAt"
  >
> & {
  schedule?: HabitSchedulePatch;
};

export type NewPersistedHabit = Omit<Habit, "id">;

export interface PersistedReasonNote {
  habitId: number;
  date: string;
  text: string;
  isFailureReason: boolean;
  reasonType: "failure" | "skipped";
  createdAt: number;
  updatedAt: number;
}

/**
 * Transaction-scoped semantic port. It deliberately exposes no SQL, executor,
 * SQLite row, or transaction object to application/state code.
 */
export interface HabitPersistenceSession {
  readMaxDisplayOrder(): Promise<number | null>;
  insertHabit(habit: NewPersistedHabit): Promise<Habit>;
  readHabit(habitId: number): Promise<Habit | null>;
  readDayRecordsForHabitOrderedByDate(
    habitId: number,
  ): Promise<DayRecord[]>;
  readArchivedDisplayOrders(): Promise<DisplayOrderRow[]>;
  patchHabit(habitId: number, patch: HabitPatch): Promise<void>;
  patchHabitDisplayOrders(
    assignments: readonly DisplayOrderRow[],
  ): Promise<void>;
  deleteDayRecordsByIds(recordIds: readonly number[]): Promise<void>;
  deleteReasonNotesForDates(
    habitId: number,
    dates: ReadonlySet<string>,
  ): Promise<void>;
  deleteSettingsByKeys(keys: readonly string[]): Promise<void>;
  deleteHabitsByIds(habitIds: readonly number[]): Promise<void>;
  upsertDayRecord(input: {
    habitId: number;
    date: string;
    status: DayStatus;
    createdAt: number;
    updatedAt: number;
  }): Promise<DayRecord>;
  insertReasonNote(note: PersistedReasonNote): Promise<void>;
}

export interface HabitPersistenceRepository
  extends HabitPersistenceSession {
  transaction<T>(
    task: (session: HabitPersistenceSession) => Promise<T>,
  ): Promise<T>;
  readAllHabits(): Promise<Habit[]>;
  /** Preserve the detail fallback's existing unordered read. */
  readDayRecordsForHabit(habitId: number): Promise<DayRecord[]>;
  readAllDayRecords(): Promise<DayRecord[]>;
  readDayRecordsInDateRange(
    startDate: string,
    endDate: string,
  ): Promise<DayRecord[]>;
  deleteDayRecord(habitId: number, date: string): Promise<void>;
}

export class StaleHabitScheduleMutationError extends Error {
  constructor() {
    super("Schedule mutation was superseded before commit");
    this.name = "StaleHabitScheduleMutationError";
  }
}

export type HabitSchedulePersistenceResult =
  | { kind: "missing" }
  | { kind: "unchanged" }
  | {
      kind: "updated";
      habit: Habit;
      removedRecordIds: readonly number[];
      removedRecordDates: readonly string[];
    };

export interface HabitPersistenceApplication {
  readAllHabits(): Promise<Habit[]>;
  readHabit(habitId: number): Promise<Habit | null>;
  readDayRecordsForHabitOrderedByDate(habitId: number): Promise<DayRecord[]>;
  readAllDayRecords(): Promise<DayRecord[]>;
  readDayRecordsInDateRange(
    startDate: string,
    endDate: string,
  ): Promise<DayRecord[]>;
  createHabit(input: {
    habit: NewPersistedHabit;
    resolveDisplayOrderFromStorage: boolean;
  }): Promise<Habit>;
  patchHabit(habitId: number, patch: HabitPatch): Promise<void>;
  persistScheduleEdit(input: {
    habitId: number;
    patch: HabitPatch;
    nextRepeatSchedule?: RepeatSchedule;
    nextStartDate?: string;
    today: string;
    isCurrent: () => boolean;
  }): Promise<HabitSchedulePersistenceResult>;
  persistReorder(orderedActiveIds: readonly number[]): Promise<DisplayOrderRow[]>;
  archiveHabit(habitId: number, now: number): Promise<Habit | null>;
  restoreHabits(
    habitIds: readonly number[],
    now: number,
  ): Promise<ReadonlyMap<number, Habit>>;
  deleteHabits(habitIds: readonly number[]): Promise<void>;
  markDay(input: {
    habitId: number;
    date: string;
    status: DayStatus;
    reason?: string;
    now: number;
  }): Promise<DayRecord>;
  unmarkDay(habitId: number, date: string): Promise<void>;
}

export function normalizePersistedDayReason(
  status: DayStatus,
  reason?: string,
): string | null {
  const normalized = reason?.trim();
  return normalized && (status === "failure" || status === "skipped")
    ? normalized
    : null;
}

function applyHabitPatch(habit: Habit, patch: HabitPatch): Habit {
  const { schedule, ...fields } = patch;
  return {
    ...habit,
    ...fields,
    ...(schedule
      ? {
          repeatSchedule: schedule.repeatSchedule,
          scheduleHistory: schedule.scheduleHistory,
          startDate: schedule.startDate,
        }
      : null),
  };
}

function assertScheduleMutationCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw new StaleHabitScheduleMutationError();
  }
}

/**
 * Application owner for habit persistence protocols. Zustand still owns the
 * optimistic visible state and per-field revision tokens; this service owns
 * authoritative reads plus the exact atomic transaction steps.
 */
export function createHabitPersistenceApplication(
  repository: HabitPersistenceRepository,
): HabitPersistenceApplication {
  return {
    readAllHabits: () => repository.readAllHabits(),
    readHabit: (habitId) => repository.readHabit(habitId),
    readDayRecordsForHabitOrderedByDate: (habitId) =>
      repository.readDayRecordsForHabitOrderedByDate(habitId),
    readAllDayRecords: () => repository.readAllDayRecords(),
    readDayRecordsInDateRange: (startDate, endDate) =>
      repository.readDayRecordsInDateRange(startDate, endDate),

    async createHabit({ habit, resolveDisplayOrderFromStorage }) {
      if (resolveDisplayOrderFromStorage) {
        return repository.transaction(async (session) => {
          const displayOrder = ((await session.readMaxDisplayOrder()) ?? -1) + 1;
          assertValidDisplayOrder(displayOrder);
          return session.insertHabit({ ...habit, displayOrder });
        });
      }
      assertValidDisplayOrder(habit.displayOrder);
      return repository.insertHabit(habit);
    },

    patchHabit: (habitId, patch) => repository.patchHabit(habitId, patch),

    persistScheduleEdit(input) {
      return repository.transaction(async (session) => {
        const authoritativeHabit = await session.readHabit(input.habitId);
        if (!authoritativeHabit) return { kind: "missing" };

        const records = await session.readDayRecordsForHabitOrderedByDate(
          input.habitId,
        );
        const plan = planHabitScheduleEdit({
          previousSchedule: authoritativeHabit.repeatSchedule,
          previousStartDate: authoritativeHabit.startDate,
          previousHistory: authoritativeHabit.scheduleHistory,
          records,
          nextSchedule: input.nextRepeatSchedule,
          nextStartDate: input.nextStartDate,
          today: input.today,
        });

        if (!plan.changed) {
          assertScheduleMutationCurrent(input.isCurrent);
          await session.patchHabit(input.habitId, input.patch);
          assertScheduleMutationCurrent(input.isCurrent);
          return { kind: "unchanged" };
        }

        const removedRecordIds = plan.removedRecords.map(
          (record) => record.id,
        );
        const removedRecordDates = new Set(
          plan.removedRecords.map((record) => record.date),
        );

        // Preserve the original three cancellation boundaries. Throwing from
        // inside the transaction rolls back record, reason, and row changes.
        assertScheduleMutationCurrent(input.isCurrent);
        await session.deleteDayRecordsByIds(removedRecordIds);
        if (removedRecordDates.size > 0) {
          await session.deleteReasonNotesForDates(
            input.habitId,
            removedRecordDates,
          );
        }

        const persistedPatch: HabitPatch = {
          ...input.patch,
          schedule: {
            repeatSchedule: plan.repeatSchedule,
            scheduleHistory: plan.scheduleHistory,
            startDate: plan.startDate,
          },
        };
        const persistedHabit = applyHabitPatch(
          authoritativeHabit,
          persistedPatch,
        );

        assertScheduleMutationCurrent(input.isCurrent);
        await session.patchHabit(input.habitId, persistedPatch);
        assertScheduleMutationCurrent(input.isCurrent);

        return {
          kind: "updated",
          habit: persistedHabit,
          removedRecordIds,
          removedRecordDates: [...removedRecordDates],
        };
      });
    },

    persistReorder(orderedActiveIds) {
      return repository.transaction(async (session) => {
        const archivedRows = await session.readArchivedDisplayOrders();
        const assignments = assignDisplayOrdersAroundArchivedSlots(
          orderedActiveIds,
          archivedRows,
        );
        const persistedOrders = [
          ...assignments.archived,
          ...assignments.active,
        ];
        await session.patchHabitDisplayOrders(persistedOrders);
        return persistedOrders;
      });
    },

    archiveHabit(habitId, now) {
      return repository.transaction(async (session) => {
        const authoritative = await session.readHabit(habitId);
        if (!authoritative || authoritative.isArchived) return authoritative;

        const persisted: Habit = {
          ...authoritative,
          isArchived: true,
          archivedAt: now,
          archiveHistory: startArchivePeriod(authoritative.archiveHistory, now),
          updatedAt: now,
        };
        await session.patchHabit(habitId, {
          isArchived: true,
          archivedAt: now,
          archiveHistory: persisted.archiveHistory,
          updatedAt: now,
        });
        return persisted;
      });
    },

    restoreHabits(habitIds, now) {
      return repository.transaction(async (session) => {
        const persistedById = new Map<number, Habit>();
        for (const habitId of habitIds) {
          const authoritative = await session.readHabit(habitId);
          if (!authoritative) continue;
          if (!authoritative.isArchived) {
            persistedById.set(habitId, authoritative);
            continue;
          }

          const restored: Habit = {
            ...authoritative,
            isArchived: false,
            archivedAt: null,
            archiveHistory: closeArchivePeriod(
              authoritative.archiveHistory,
              now,
              authoritative.archivedAt,
            ),
            updatedAt: now,
          };
          await session.patchHabit(habitId, {
            isArchived: false,
            archivedAt: null,
            archiveHistory: restored.archiveHistory,
            updatedAt: now,
          });
          persistedById.set(habitId, restored);
        }
        return persistedById;
      });
    },

    deleteHabits(habitIds) {
      const settingKeys = habitIds.map(getDescriptionLinesSettingKey);
      return repository.transaction(async (session) => {
        if (settingKeys.length > 0) {
          await session.deleteSettingsByKeys(settingKeys);
        }
        await session.deleteHabitsByIds(habitIds);
      });
    },

    async markDay(input) {
      const reason = normalizePersistedDayReason(input.status, input.reason);
      const persistRecord = (session: HabitPersistenceSession) =>
        session.upsertDayRecord({
          habitId: input.habitId,
          date: input.date,
          status: input.status,
          createdAt: input.now,
          updatedAt: input.now,
        });

      if (reason != null) {
        return repository.transaction(async (session) => {
          const record = await persistRecord(session);
          await session.insertReasonNote({
            habitId: input.habitId,
            date: input.date,
            text: reason,
            isFailureReason: input.status === "failure",
            reasonType: input.status as "failure" | "skipped",
            createdAt: input.now,
            updatedAt: input.now,
          });
          return record;
        });
      }

      // One UPSERT is atomic; avoid a transaction on the common checkbox path.
      return persistRecord(repository);
    },

    unmarkDay: (habitId, date) =>
      repository.deleteDayRecord(habitId, date),
  };
}
