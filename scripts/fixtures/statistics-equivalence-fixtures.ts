import type { DayRecord, Habit } from "../../src/types/habit";
import type { StatisticsPeriod } from "../../src/types/settings";

export interface StatisticsEquivalenceSource {
  allHabits: Habit[];
  allRecords: DayRecord[];
  showArchivedHabitsInStatistics: boolean;
  todayStr: string;
}

export interface StatisticsEquivalenceFixture {
  name: string;
  source: StatisticsEquivalenceSource;
  targets: readonly {
    period: StatisticsPeriod;
    periodOffset: number;
  }[];
}

const targets = [
  { period: "week", periodOffset: 0 },
  { period: "week", periodOffset: -1 },
  { period: "month", periodOffset: 0 },
  { period: "month", periodOffset: -1 },
  { period: "year", periodOffset: 0 },
  { period: "year", periodOffset: -1 },
] as const;

function habit(id: number, overrides: Partial<Habit>): Habit {
  return {
    id,
    name: `Habit ${id}`,
    description: null,
    descriptionVisible: true,
    repeatSchedule: { type: "daily" },
    scheduleHistory: [
      {
        effectiveFrom: "2026-01-01",
        startDate: "2026-01-01",
        repeatSchedule: { type: "daily" },
      },
    ],
    startDate: "2026-01-01",
    reminderEnabled: false,
    reminderTime: null,
    displayOrder: id - 1,
    isArchived: false,
    archivedAt: null,
    archiveHistory: [],
    createdAt: id,
    updatedAt: id,
    ...overrides,
  };
}

function records(
  habitId: number,
  entries: readonly [date: string, status: DayRecord["status"]][],
): DayRecord[] {
  return entries.map(([date, status], index) => ({
    id: habitId * 100 + index,
    habitId,
    date,
    status,
    createdAt: habitId * 100 + index,
    updatedAt: habitId * 100 + index,
  }));
}

const mixedHabits: Habit[] = [
  habit(1, {
    name: "Daily",
    startDate: "2026-08-24",
    scheduleHistory: [
      {
        effectiveFrom: "2026-08-24",
        startDate: "2026-08-24",
        repeatSchedule: { type: "daily" },
      },
    ],
  }),
  habit(2, {
    name: "Weekdays with pause",
    startDate: "2026-08-01",
    repeatSchedule: { type: "weekdays", days: [1, 3, 5] },
    scheduleHistory: [
      {
        effectiveFrom: "2026-08-01",
        startDate: "2026-08-01",
        repeatSchedule: { type: "weekdays", days: [1, 3, 5] },
      },
    ],
    archiveHistory: [
      {
        archivedAt: 1,
        restoredAt: 2,
        archivedDate: "2026-08-26",
        restoredDate: "2026-08-28",
      },
    ],
  }),
  habit(3, {
    name: "Archived monthly",
    startDate: "2026-01-01",
    repeatSchedule: { type: "monthly", dates: [1, 15, 31] },
    scheduleHistory: [
      {
        effectiveFrom: "2026-01-01",
        startDate: "2026-01-01",
        repeatSchedule: { type: "monthly", dates: [1, 15, 31] },
      },
    ],
    isArchived: true,
    archivedAt: 3,
    archiveHistory: [
      {
        archivedAt: 3,
        restoredAt: null,
        archivedDate: "2026-08-20",
        restoredDate: null,
      },
    ],
  }),
  habit(4, {
    name: "Changed schedule",
    startDate: "2026-06-01",
    repeatSchedule: { type: "weekdays", days: [2, 4, 6] },
    scheduleHistory: [
      {
        effectiveFrom: "2026-06-01",
        startDate: "2026-06-01",
        repeatSchedule: { type: "interval", every: 2 },
      },
      {
        effectiveFrom: "2026-08-20",
        startDate: "2026-06-01",
        repeatSchedule: { type: "weekdays", days: [2, 4, 6] },
      },
    ],
  }),
  habit(5, {
    name: "Future",
    startDate: "2026-09-01",
    scheduleHistory: [
      {
        effectiveFrom: "2026-09-01",
        startDate: "2026-09-01",
        repeatSchedule: { type: "daily" },
      },
    ],
  }),
  habit(6, {
    name: "From completion",
    startDate: "2026-08-01",
    repeatSchedule: { type: "interval", every: 3, fromCompletion: true },
    scheduleHistory: [
      {
        effectiveFrom: "2026-08-01",
        startDate: "2026-08-01",
        repeatSchedule: { type: "interval", every: 3, fromCompletion: true },
      },
    ],
  }),
];

const mixedRecords = [
  ...records(1, [
    ["2026-08-24", "maximum"],
    ["2026-08-25", "failure"],
    ["2026-08-26", "done"],
    ["2026-08-27", "skipped"],
    ["2026-08-28", "minimum"],
    ["2026-08-29", "done"],
  ]),
  ...records(2, [
    ["2026-08-24", "failure"],
    ["2026-08-28", "maximum"],
  ]),
  ...records(3, [
    ["2026-01-01", "done"],
    ["2026-08-01", "minimum"],
    ["2026-08-15", "failure"],
  ]),
  ...records(4, [
    ["2026-08-18", "done"],
    ["2026-08-20", "failure"],
    ["2026-08-22", "maximum"],
    ["2026-08-25", "minimum"],
    ["2026-08-27", "done"],
    ["2026-08-29", "failure"],
  ]),
  ...records(6, [
    ["2026-08-01", "done"],
    ["2026-08-05", "maximum"],
    ["2026-08-10", "minimum"],
    ["2026-08-14", "skipped"],
    ["2026-08-15", "failure"],
  ]),
];

const boundaryHabits: Habit[] = [
  habit(11, {
    name: "DST history",
    startDate: "2024-02-29",
    repeatSchedule: { type: "interval", every: 2 },
    scheduleHistory: [
      {
        effectiveFrom: "2024-02-29",
        startDate: "2024-02-29",
        repeatSchedule: { type: "monthly", dates: [29, 31] },
      },
      {
        effectiveFrom: "2026-03-27",
        startDate: "2024-02-29",
        repeatSchedule: { type: "interval", every: 2 },
      },
    ],
    archiveHistory: [
      {
        archivedAt: 11,
        restoredAt: 12,
        archivedDate: "2026-03-28",
        restoredDate: "2026-03-29",
      },
    ],
  }),
  habit(12, {
    name: "Year boundary",
    startDate: "2025-12-31",
    repeatSchedule: { type: "weekdays", days: [1, 7] },
    scheduleHistory: [
      {
        effectiveFrom: "2025-12-31",
        startDate: "2025-12-31",
        repeatSchedule: { type: "weekdays", days: [1, 7] },
      },
    ],
  }),
];

const boundaryRecords = [
  ...records(11, [
    ["2024-02-29", "done"],
    ["2024-03-31", "maximum"],
    ["2026-03-27", "minimum"],
    ["2026-03-29", "done"],
  ]),
  ...records(12, [
    ["2025-12-31", "done"],
    ["2026-03-23", "failure"],
    ["2026-03-29", "maximum"],
  ]),
];

export const statisticsEquivalenceFixtures: readonly StatisticsEquivalenceFixture[] =
  [
    {
      name: "mixed-including-archived",
      source: {
        allHabits: mixedHabits,
        allRecords: mixedRecords,
        showArchivedHabitsInStatistics: true,
        todayStr: "2026-08-29",
      },
      targets,
    },
    {
      name: "mixed-excluding-archived",
      source: {
        allHabits: mixedHabits,
        allRecords: mixedRecords,
        showArchivedHabitsInStatistics: false,
        todayStr: "2026-08-29",
      },
      targets,
    },
    {
      name: "local-date-boundaries",
      source: {
        allHabits: boundaryHabits,
        allRecords: boundaryRecords,
        showArchivedHabitsInStatistics: true,
        todayStr: "2026-03-29",
      },
      targets,
    },
  ];

export const expectedStatisticsEquivalenceHashes = new Map<string, string>([
  ["mixed-including-archived:week:0", "47fd44cb1691143d059a1446393743dc16c7f2637709355b6d2a91004c31a7bf"],
  ["mixed-including-archived:week:-1", "17cc16a6a56f8b7412f038070055635204dedc2221017c24bbd3113e6edb9319"],
  ["mixed-including-archived:month:0", "15917d2d788161a1d895644b8e4514683892439a80ce06bcdf66ceb695224ca0"],
  ["mixed-including-archived:month:-1", "157cfb43197658e8a8ed654a22e45ba6fafd97061b9c27e0b9c65a06ca199877"],
  ["mixed-including-archived:year:0", "2366d991adaf1d00a57d32a13ebee956c482f54c6488dda1275a2c98aa009e06"],
  ["mixed-including-archived:year:-1", "a19e83f1840745edb3afcb9c67f6e1f908210f381f154ed86f021716a7252e75"],
  ["mixed-excluding-archived:week:0", "47fd44cb1691143d059a1446393743dc16c7f2637709355b6d2a91004c31a7bf"],
  ["mixed-excluding-archived:week:-1", "17cc16a6a56f8b7412f038070055635204dedc2221017c24bbd3113e6edb9319"],
  ["mixed-excluding-archived:month:0", "0177d9f53d04f01870e3be000e73796e64a28e106b15361e0b13fb9470e97cd1"],
  ["mixed-excluding-archived:month:-1", "00283cd1ed567307fb6a19f31d1ba687a02acbf6ac139cef5b412c565032112a"],
  ["mixed-excluding-archived:year:0", "ce1ef2386c0ce5951cf226c20fa5070c586866b64dbd543ae91b5f012968c6c9"],
  ["mixed-excluding-archived:year:-1", "a19e83f1840745edb3afcb9c67f6e1f908210f381f154ed86f021716a7252e75"],
  ["local-date-boundaries:week:0", "8ad0b3b9ac80a719d49015a0ea8e1cb1003e678428f7b2597494ff3277fa9af6"],
  ["local-date-boundaries:week:-1", "03a871421c519937386985bf09f13d1192245e87d4ef02f91ca715afb82656cd"],
  ["local-date-boundaries:month:0", "4b661154742364f5656e97454a668572bcdc2256622fac666dbe90b0b041f434"],
  ["local-date-boundaries:month:-1", "cda4ffcfd585cddff247c40af4e0348361fa6cfb2452fc26f638120a7fffd4b8"],
  ["local-date-boundaries:year:0", "712a2f625a780837757a6d27a68c922dcadc13333e0c18a75a4ff255081d4dea"],
  ["local-date-boundaries:year:-1", "4d86dda8949a37478d81ea899c7fff999eeae64bfd64d13ea55b1df47e169b11"],
]);
