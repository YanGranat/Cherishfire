import type {
  DayRecord,
  DayStatus,
  Habit,
  RepeatSchedule,
} from "../../src/types/habit";

export const FIXED_NOW_MS = new Date(
  "2026-07-24T12:00:00.000Z",
).getTime();
export const FIXED_TODAY = "2026-07-24";

export function createHabitFixture(
  overrides: Partial<Habit> = {},
): Habit {
  const repeatSchedule: RepeatSchedule = { type: "daily" };
  return {
    id: 1,
    name: "Hydrate",
    description: "Two litres",
    descriptionVisible: true,
    repeatSchedule,
    scheduleHistory: [
      {
        effectiveFrom: "2026-07-01",
        startDate: "2026-07-01",
        repeatSchedule,
      },
    ],
    startDate: "2026-07-01",
    reminderEnabled: false,
    reminderTime: null,
    displayOrder: 0,
    isArchived: false,
    archivedAt: null,
    archiveHistory: [],
    createdAt: FIXED_NOW_MS - 86_400_000,
    updatedAt: FIXED_NOW_MS - 86_400_000,
    ...overrides,
  };
}

export function createDayRecordFixture(
  id: number,
  date: string,
  status: DayStatus = "done",
): DayRecord {
  return {
    id,
    habitId: 1,
    date,
    status,
    createdAt: FIXED_NOW_MS - 1_000,
    updatedAt: FIXED_NOW_MS - 1_000,
  };
}

/**
 * Schedule, archive-slot, reorder, and reason-note fixtures for
 * repository-boundary equivalence checks.
 */
export const HABIT_PERSISTENCE_EQUIVALENCE_FIXTURES = {
  schedule: {
    noChange: {
      habit: createHabitFixture(),
      records: [
        createDayRecordFixture(10, "2026-07-23"),
        createDayRecordFixture(11, "2026-07-24"),
      ],
      nextSchedule: { type: "daily" } as RepeatSchedule,
      expectedRemovedDates: [] as string[],
      expectedEffectiveSchedule: { type: "daily" } as RepeatSchedule,
    },
    preserveValidToday: {
      habit: createHabitFixture(),
      records: [
        createDayRecordFixture(10, "2026-07-23"),
        createDayRecordFixture(11, "2026-07-24"),
      ],
      nextSchedule: {
        type: "weekdays",
        days: [5],
      } as RepeatSchedule,
      expectedRemovedDates: [] as string[],
      expectedEffectiveFrom: "2026-07-25",
    },
    removeImpossibleToday: {
      habit: createHabitFixture(),
      records: [
        createDayRecordFixture(10, "2026-07-23"),
        createDayRecordFixture(11, "2026-07-24"),
      ],
      nextSchedule: {
        type: "weekdays",
        days: [1],
      } as RepeatSchedule,
      expectedRemovedDates: ["2026-07-24"],
      expectedRemovedIds: [11],
      expectedEffectiveFrom: "2026-07-24",
    },
    moveStartDate: {
      habit: createHabitFixture(),
      records: [
        createDayRecordFixture(10, "2026-07-23"),
        createDayRecordFixture(11, "2026-07-24"),
      ],
      nextStartDate: "2026-07-24",
      expectedRemovedDates: ["2026-07-23"],
      expectedRemovedIds: [10],
      expectedHistory: [
        {
          effectiveFrom: "2026-07-24",
          startDate: "2026-07-24",
          repeatSchedule: { type: "daily" } as RepeatSchedule,
        },
      ],
    },
  },
  reorder: {
    activeIds: [4, 1, 3],
    archived: [{ id: 2, displayOrder: 1 }],
    expected: [
      { id: 2, displayOrder: 1 },
      { id: 4, displayOrder: 0 },
      { id: 1, displayOrder: 2 },
      { id: 3, displayOrder: 3 },
    ],
  },
  duplicateArchivedSlots: {
    activeIds: [1, 2],
    archived: [
      { id: 8, displayOrder: 1 },
      { id: 9, displayOrder: 1 },
    ],
    expected: [
      { id: 8, displayOrder: 1 },
      { id: 9, displayOrder: 2 },
      { id: 1, displayOrder: 0 },
      { id: 2, displayOrder: 3 },
    ],
  },
  reasonedMark: {
    habitId: 1,
    date: FIXED_TODAY,
    status: "failure" as const,
    reason: "  no scales  ",
    expectedReason: "no scales",
  },
  ordinaryMark: {
    habitId: 1,
    date: FIXED_TODAY,
    status: "done" as const,
  },
} as const;
