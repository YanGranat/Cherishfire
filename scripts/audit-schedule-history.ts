import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInstance } from "i18next";
import ru from "../src/i18n/locales/ru.json";
import en from "../src/i18n/locales/en.json";
import uk from "../src/i18n/locales/uk.json";
import es from "../src/i18n/locales/es.json";
import de from "../src/i18n/locales/de.json";
import fr from "../src/i18n/locales/fr.json";
import it from "../src/i18n/locales/it.json";
import nl from "../src/i18n/locales/nl.json";
import pl from "../src/i18n/locales/pl.json";
import {
  toRepeatSchedule,
  toScheduleHistory,
  updateScheduleHistory,
  type DayRecord,
  type Habit,
  type RepeatSchedule,
} from "../src/types/habit";
import {
  createScheduleDateFacts,
  createHabitScheduleMatcher,
  getEarliestScheduleStartDate,
  isCompletionLedIntervalScheduleForDate,
  isHabitScheduledForDate,
  partitionRecordsForScheduleVersion,
} from "../src/domain/habits/schedule";
import {
  getEveryNDaysLabel,
  getRepeatLabel,
  WEEKDAY_SHORT_KEYS,
} from "../src/features/habits/presentation/repeat-labels";
import { calculateStreakStats } from "../src/domain/habits/streak";
import { normalizeIntervalDraft } from "../src/features/habit-form/utils/repeat-interval";
import { planHabitScheduleEdit } from "../src/domain/habits/schedule-edit";
import {
  getStreakCacheSizeForAudit,
  MAX_STREAK_CACHE_ENTRIES,
  peekStreakStats,
  prepareStreakStats,
  resetStreakCacheForAudit,
} from "../src/application/statistics/streak-cache";

const daily: RepeatSchedule = { type: "daily" };
const mondays: RepeatSchedule = { type: "weekdays", days: [1] };

const matcherRecords = [
  { date: "2026-01-03", status: "done" as const },
  { date: "2026-01-08", status: "failure" as const },
  { date: "2026-01-12", status: "maximum" as const },
  { date: "2026-02-02", status: "minimum" as const },
];
const matcherSchedules: RepeatSchedule[] = [
  daily,
  { type: "weekdays", days: [1, 3, 7] },
  { type: "monthly", dates: [1, 15, 31] },
  { type: "interval", every: 3, fromCompletion: false },
  { type: "interval", every: 4, fromCompletion: true },
];
for (const schedule of matcherSchedules) {
  const matcher = createHabitScheduleMatcher(
    schedule,
    "2026-01-01",
    matcherRecords,
  );
  for (let day = 1; day <= 60; day += 1) {
    const date = new Date(2026, 0, day);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(date.getDate()).padStart(2, "0")}`;
    const legacyMatch = matcher(iso);
    assert.equal(
      matcher(iso, createScheduleDateFacts(iso)),
      legacyMatch,
      `shared calendar facts drifted for ${schedule.type} on ${iso}`,
    );
    assert.equal(
      legacyMatch,
      isHabitScheduledForDate(schedule, "2026-01-01", iso, matcherRecords),
      `prepared matcher drifted for ${schedule.type} on ${iso}`,
    );
  }
}

const civilBoundaryDates = [
  "2024-02-29",
  "2024-03-01",
  "2025-12-31",
  "2026-01-01",
  "2026-03-28",
  "2026-03-29",
  "2026-03-30",
  "2026-10-25",
  "2026-10-26",
] as const;
for (const schedule of matcherSchedules) {
  const matcher = createHabitScheduleMatcher(
    schedule,
    "2024-02-29",
    matcherRecords,
  );
  for (const iso of civilBoundaryDates) {
    assert.equal(
      matcher(iso, createScheduleDateFacts(iso)),
      isHabitScheduledForDate(schedule, "2024-02-29", iso, matcherRecords),
      `shared calendar facts drifted at a leap/DST/year boundary for ${schedule.type} on ${iso}`,
    );
  }
}
const mismatchedFactsMatcher = createHabitScheduleMatcher(
  { type: "weekdays", days: [1] },
  "2026-01-01",
);
assert.equal(
  mismatchedFactsMatcher("2026-01-05", createScheduleDateFacts("2026-01-06")),
  mismatchedFactsMatcher("2026-01-05"),
  "a stale date-facts object must be ignored instead of changing semantics",
);

const matcherHistory = [
  {
    effectiveFrom: "2026-01-01",
    startDate: "2026-01-01",
    repeatSchedule: daily,
  },
  {
    effectiveFrom: "2026-01-20",
    startDate: "2026-01-01",
    repeatSchedule: { type: "weekdays", days: [1, 4] } as RepeatSchedule,
  },
  {
    effectiveFrom: "2026-02-01",
    startDate: "2026-01-01",
    repeatSchedule: {
      type: "interval",
      every: 4,
      fromCompletion: true,
    } as RepeatSchedule,
  },
];
const currentHistoricalSchedule = matcherHistory.at(-1)!.repeatSchedule;
const historicalMatcher = createHabitScheduleMatcher(
  currentHistoricalSchedule,
  "2026-01-01",
  matcherRecords,
  matcherHistory,
);
for (let day = 1; day <= 75; day += 1) {
  const date = new Date(2026, 0, day);
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
  const legacyMatch = historicalMatcher(iso);
  assert.equal(
    historicalMatcher(iso, createScheduleDateFacts(iso)),
    legacyMatch,
    `shared calendar facts drifted across schedule history on ${iso}`,
  );
  assert.equal(
    legacyMatch,
    isHabitScheduledForDate(
      currentHistoricalSchedule,
      "2026-01-01",
      iso,
      matcherRecords,
      matcherHistory,
    ),
    `prepared matcher drifted across schedule history on ${iso}`,
  );
}

const historicalCompletionOnly = [
  {
    effectiveFrom: "2026-01-01",
    startDate: "2026-01-01",
    repeatSchedule: {
      type: "interval",
      every: 4,
      fromCompletion: true,
    } as RepeatSchedule,
  },
  {
    effectiveFrom: "2026-02-01",
    startDate: "2026-01-01",
    repeatSchedule: daily,
  },
];
const matcherWithHistoricalCompletion = createHabitScheduleMatcher(
  daily,
  "2026-01-01",
  matcherRecords,
  historicalCompletionOnly,
);
assert.equal(
  isCompletionLedIntervalScheduleForDate(
    daily,
    "2026-01-01",
    "2026-01-15",
    historicalCompletionOnly,
  ),
  true,
  "history readiness must follow the schedule version active on the selected date",
);
assert.equal(
  isCompletionLedIntervalScheduleForDate(
    daily,
    "2026-01-01",
    "2026-02-15",
    historicalCompletionOnly,
  ),
  false,
  "a fixed active schedule version must not require completion history",
);
for (let day = 1; day <= 45; day += 1) {
  const date = new Date(2026, 0, day);
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
  const legacyMatch = matcherWithHistoricalCompletion(iso);
  assert.equal(
    matcherWithHistoricalCompletion(iso, createScheduleDateFacts(iso)),
    legacyMatch,
    `shared calendar facts drifted for historical completion interval on ${iso}`,
  );
  assert.equal(
    legacyMatch,
    isHabitScheduledForDate(
      daily,
      "2026-01-01",
      iso,
      matcherRecords,
      historicalCompletionOnly,
    ),
    `prepared matcher must retain a historical completion-driven interval on ${iso}`,
  );
}

const legacyStringInterval = toRepeatSchedule("interval", {
  every: "3",
  fromCompletion: false,
});
assert.deepEqual(legacyStringInterval, {
  type: "interval",
  every: 3,
  fromCompletion: false,
});
const russianI18n = createInstance();
void russianI18n.init({
  initImmediate: false,
  lng: "ru",
  resources: { ru: { translation: ru } },
  compatibilityJSON: "v4",
  interpolation: { escapeValue: false },
});
assert.equal(
  getRepeatLabel(
    legacyStringInterval,
    russianI18n.t.bind(russianI18n),
    [...WEEKDAY_SHORT_KEYS],
    "ru",
  ),
  "Каждые 3 дня",
);
const pluralCases = {
  ru: {
    resource: ru,
    expected: [
      "Каждые 2 дня",
      "Каждые 3 дня",
      "Каждые 5 дней",
      "Каждые 22 дня",
      "Каждые 25 дней",
    ],
  },
  uk: {
    resource: uk,
    expected: [
      "Кожні 2 дні",
      "Кожні 3 дні",
      "Кожні 5 днів",
      "Кожні 22 дні",
      "Кожні 25 днів",
    ],
  },
  pl: {
    resource: pl,
    expected: ["Co 2 dni", "Co 3 dni", "Co 5 dni", "Co 22 dni", "Co 25 dni"],
  },
  en: {
    resource: en,
    expected: [
      "Every 2 days",
      "Every 3 days",
      "Every 5 days",
      "Every 22 days",
      "Every 25 days",
    ],
  },
  es: {
    resource: es,
    expected: [
      "Cada 2 días",
      "Cada 3 días",
      "Cada 5 días",
      "Cada 22 días",
      "Cada 25 días",
    ],
  },
  de: {
    resource: de,
    expected: [
      "Alle 2 Tage",
      "Alle 3 Tage",
      "Alle 5 Tage",
      "Alle 22 Tage",
      "Alle 25 Tage",
    ],
  },
  fr: {
    resource: fr,
    expected: [
      "Tous les 2 jours",
      "Tous les 3 jours",
      "Tous les 5 jours",
      "Tous les 22 jours",
      "Tous les 25 jours",
    ],
  },
  it: {
    resource: it,
    expected: [
      "Ogni 2 giorni",
      "Ogni 3 giorni",
      "Ogni 5 giorni",
      "Ogni 22 giorni",
      "Ogni 25 giorni",
    ],
  },
  nl: {
    resource: nl,
    expected: [
      "Elke 2 dagen",
      "Elke 3 dagen",
      "Elke 5 dagen",
      "Elke 22 dagen",
      "Elke 25 dagen",
    ],
  },
} as const;
for (const [language, pluralCase] of Object.entries(pluralCases)) {
  const instance = createInstance();
  void instance.init({
    initImmediate: false,
    lng: language,
    resources: { [language]: { translation: pluralCase.resource } },
    compatibilityJSON: "v4",
    interpolation: { escapeValue: false },
  });
  assert.deepEqual(
    [2, 3, 5, 22, 25].map((every) =>
      getRepeatLabel(
        { type: "interval", every },
        instance.t.bind(instance),
        [...WEEKDAY_SHORT_KEYS],
        language,
      ),
    ),
    [...pluralCase.expected],
    `${language} interval labels must use the language's real plural rules`,
  );

  for (let every = 2; every <= 365; every += 1) {
    const selected = new Intl.PluralRules(language).select(every);
    const expectedCategory =
      selected === "one" || selected === "few" || selected === "many"
        ? selected
        : "other";
    const actualKey = getEveryNDaysLabel(every, (key: string) => key, language);
    assert.equal(
      actualKey,
      `repeat.everyNDays_${expectedCategory}`,
      `${language} must use the correct plural category for ${every}`,
    );
  }
}
const ukrainianPluralInstance = createInstance();
void ukrainianPluralInstance.init({
  initImmediate: false,
  lng: "uk",
  resources: { uk: { translation: uk } },
  compatibilityJSON: "v4",
  interpolation: { escapeValue: false },
});
assert.equal(
  getRepeatLabel(
    { type: "interval", every: 21 },
    ukrainianPluralInstance.t.bind(ukrainianPluralInstance),
    [...WEEKDAY_SHORT_KEYS],
    "uk",
  ),
  "Кожен 21 день",
  "Ukrainian singular interval labels must agree with the singular noun",
);
assert.equal(normalizeIntervalDraft(""), 2);
assert.equal(normalizeIntervalDraft("3"), 3);
assert.equal(normalizeIntervalDraft("999"), 365);

const legacyHistory = toScheduleHistory({}, daily, "2026-07-01");
assert.deepEqual(legacyHistory, [
  {
    effectiveFrom: "2026-07-01",
    startDate: "2026-07-01",
    repeatSchedule: daily,
  },
]);

const normalizedCivilHistory = toScheduleHistory(
  {
    scheduleHistory: [
      {
        effectiveFrom: "9999-12-31",
        startDate: "9999-12-31",
        repeatSchedule: daily,
      },
      {
        effectiveFrom: "2026-02-30",
        startDate: "2026-02-01",
        repeatSchedule: daily,
      },
      {
        effectiveFrom: "2026-02-01",
        startDate: "2026-02-30",
        repeatSchedule: daily,
      },
      {
        effectiveFrom: "2026-13-01",
        startDate: "2026-01-01",
        repeatSchedule: daily,
      },
      {
        effectiveFrom: "2026-01-01",
        startDate: "2026-13-01",
        repeatSchedule: daily,
      },
      {
        effectiveFrom: "0000-01-01",
        startDate: "0001-01-01",
        repeatSchedule: daily,
      },
      {
        effectiveFrom: "2026-01-02",
        startDate: "0000-01-01",
        repeatSchedule: daily,
      },
      {
        effectiveFrom: "2023-02-29",
        startDate: "2023-02-01",
        repeatSchedule: daily,
      },
      {
        effectiveFrom: "2024-02-29",
        startDate: "2024-02-29",
        repeatSchedule: { type: "weekdays", days: [4] },
      },
      {
        effectiveFrom: "2011-12-30",
        startDate: "2011-12-30",
        repeatSchedule: { type: "monthly", dates: [30] },
      },
      {
        effectiveFrom: "0001-01-01",
        startDate: "0001-01-01",
        repeatSchedule: daily,
      },
    ],
  },
  daily,
  "2026-07-01",
);
assert.deepEqual(
  normalizedCivilHistory.map((entry) => entry.effectiveFrom),
  ["0001-01-01", "2011-12-30", "2024-02-29", "9999-12-31"],
  "schedule history must keep valid civil dates and sort them chronologically",
);
assert.deepEqual(normalizedCivilHistory[1], {
  effectiveFrom: "2011-12-30",
  startDate: "2011-12-30",
  repeatSchedule: { type: "monthly", dates: [30] },
});
assert.deepEqual(
  toScheduleHistory(
    {
      scheduleHistory: [
        {
          effectiveFrom: "2026-02-30",
          startDate: "2026-02-01",
          repeatSchedule: daily,
        },
        {
          effectiveFrom: "2026-01-01",
          startDate: "0000-01-01",
          repeatSchedule: daily,
        },
      ],
    },
    mondays,
    "2026-07-01",
  ),
  [
    {
      effectiveFrom: "2026-07-01",
      startDate: "2026-07-01",
      repeatSchedule: mondays,
    },
  ],
  "an entirely invalid stored history must fall back to the current schedule",
);

const changedHistory = updateScheduleHistory(
  legacyHistory,
  daily,
  "2026-07-01",
  "2026-07-10",
  mondays,
  "2026-07-01",
);

assert.equal(
  isHabitScheduledForDate(
    daily,
    "2026-07-01",
    "2026-07-09",
    [],
    changedHistory,
  ),
  true,
  "the old daily schedule must still apply before the change",
);
assert.equal(
  isHabitScheduledForDate(
    daily,
    "2026-07-01",
    "2026-07-10",
    [],
    changedHistory,
  ),
  false,
  "the new Monday-only schedule must apply from the change date",
);
assert.equal(
  isHabitScheduledForDate(
    daily,
    "2026-07-01",
    "2026-07-13",
    [],
    changedHistory,
  ),
  true,
  "the new schedule must recognize its next Monday",
);

const replacedSameDay = updateScheduleHistory(
  changedHistory,
  mondays,
  "2026-07-01",
  "2026-07-10",
  { type: "monthly", dates: [10] },
  "2026-07-01",
);
assert.equal(
  replacedSameDay.length,
  2,
  "same-day edits must replace one version",
);
assert.deepEqual(replacedSameDay[1].repeatSchedule, {
  type: "monthly",
  dates: [10],
});

const unsortedHistory = [
  {
    effectiveFrom: "2026-07-20",
    startDate: "2026-07-01",
    repeatSchedule: { type: "monthly", dates: [20] } as RepeatSchedule,
  },
  {
    effectiveFrom: "2026-07-01",
    startDate: "2026-07-01",
    repeatSchedule: daily,
  },
  {
    effectiveFrom: "2026-07-10",
    startDate: "2026-07-01",
    repeatSchedule: mondays,
  },
];
const sortedUpdate = updateScheduleHistory(
  unsortedHistory,
  daily,
  "2026-07-01",
  "2026-07-25",
  { type: "interval", every: 3 },
  "2026-07-01",
);
assert.deepEqual(
  sortedUpdate.map((entry) => entry.effectiveFrom),
  ["2026-07-01", "2026-07-10", "2026-07-20", "2026-07-25"],
  "schedule updates must normalize an unsorted history",
);
const replacedUnsortedDay = updateScheduleHistory(
  unsortedHistory,
  daily,
  "2026-07-01",
  "2026-07-10",
  { type: "monthly", dates: [10] },
  "2026-07-01",
);
assert.deepEqual(
  replacedUnsortedDay.map((entry) => entry.effectiveFrom),
  ["2026-07-01", "2026-07-10"],
  "a replacement must remove the old same-day entry and every superseded future version",
);
assert.deepEqual(replacedUnsortedDay[1].repeatSchedule, {
  type: "monthly",
  dates: [10],
});

const monthlyEditHistory = updateScheduleHistory(
  [
    {
      effectiveFrom: "2031-08-01",
      startDate: "2031-08-01",
      repeatSchedule: { type: "monthly", dates: [1, 6, 14] },
    },
  ],
  { type: "monthly", dates: [1, 6, 14] },
  "2031-08-01",
  "2031-08-23",
  { type: "monthly", dates: [1, 4, 6, 9, 14, 18, 29] },
  "2031-08-01",
);
assert.equal(
  isHabitScheduledForDate(
    { type: "monthly", dates: [1, 4, 6, 9, 14, 18, 29] },
    "2031-08-01",
    "2031-08-18",
    [],
    monthlyEditHistory,
  ),
  false,
  "a newly selected monthly date must not rewrite the period before the edit",
);
assert.equal(
  isHabitScheduledForDate(
    { type: "monthly", dates: [1, 4, 6, 9, 14, 18, 29] },
    "2031-08-01",
    "2031-08-29",
    [],
    monthlyEditHistory,
  ),
  true,
  "every selected monthly date after the edit boundary must be scheduled",
);

const futureStartHistory = updateScheduleHistory(
  [
    {
      effectiveFrom: "2026-08-01",
      startDate: "2026-08-01",
      repeatSchedule: daily,
    },
  ],
  daily,
  "2026-08-01",
  "2026-07-23",
  mondays,
  "2026-08-01",
);
assert.deepEqual(
  futureStartHistory.map((entry) => entry.effectiveFrom),
  ["2026-07-23"],
  "editing a future-start habit must not leave a stale future version",
);

assert.equal(
  getEarliestScheduleStartDate("2026-07-20", changedHistory),
  "2026-07-01",
);

const completionInterval: RepeatSchedule = {
  type: "interval",
  every: 3,
  fromCompletion: true,
};
const completionRecords = [
  {
    id: 1,
    habitId: 1,
    date: "2026-07-20",
    status: "done" as const,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 2,
    habitId: 1,
    date: "2026-07-23",
    status: "maximum" as const,
    createdAt: 2,
    updatedAt: 2,
  },
];
assert.equal(
  isHabitScheduledForDate(
    completionInterval,
    "2026-07-20",
    "2026-07-20",
    completionRecords,
  ),
  true,
  "recording completion must not make that same due day unscheduled",
);
assert.equal(
  isHabitScheduledForDate(
    completionInterval,
    "2026-07-20",
    "2026-07-21",
    completionRecords,
  ),
  false,
);
assert.equal(
  isHabitScheduledForDate(
    completionInterval,
    "2026-07-20",
    "2026-07-23",
    completionRecords,
  ),
  true,
  "the next due day must remain scheduled after it is completed",
);
assert.deepEqual(
  calculateStreakStats(
    completionRecords,
    completionInterval,
    "2026-07-20",
    [],
    undefined,
    "2026-07-23",
  ),
  { current: 2, best: 2, total: 2 },
);

const streakCacheHabit: Habit = {
  id: 71,
  name: "Cached",
  description: null,
  descriptionVisible: true,
  repeatSchedule: completionInterval,
  scheduleHistory: undefined,
  startDate: "2026-07-20",
  reminderEnabled: false,
  reminderTime: null,
  displayOrder: 0,
  isArchived: false,
  archivedAt: null,
  archiveHistory: [],
  createdAt: 1,
  updatedAt: 1,
};
const streakCacheRecords: DayRecord[] = completionRecords;
resetStreakCacheForAudit();
assert.equal(
  peekStreakStats(streakCacheHabit, streakCacheRecords, "2026-07-23"),
  null,
  "a render-safe streak lookup must not calculate a cold detail model",
);
const preparedDetailStreak = prepareStreakStats(
  streakCacheHabit,
  streakCacheRecords,
  "2026-07-23",
);
assert.equal(preparedDetailStreak.cacheHit, false);
assert.deepEqual(preparedDetailStreak.stats, { current: 2, best: 2, total: 2 });
assert.equal(
  peekStreakStats(
    { ...streakCacheHabit, name: "Metadata only", updatedAt: 2 },
    streakCacheRecords.map((record) => ({ ...record })),
    "2026-07-23",
  ),
  preparedDetailStreak.stats,
  "metadata changes and equivalent record arrays must reuse the exact streak domain result",
);
assert.equal(
  peekStreakStats(
    streakCacheHabit,
    streakCacheRecords.map((record, index) =>
      index === 1 ? { ...record, status: "failure" } : record,
    ),
    "2026-07-23",
  ),
  null,
  "a status change must invalidate a prepared detail streak",
);
assert.equal(
  peekStreakStats(
    {
      ...streakCacheHabit,
      archiveHistory: [{ archivedAt: 1, restoredAt: null }],
    },
    streakCacheRecords,
    "2026-07-23",
  ),
  null,
  "archive ownership must participate in exact streak invalidation",
);
assert.equal(
  peekStreakStats(
    { ...streakCacheHabit, repeatSchedule: { type: "daily" } },
    streakCacheRecords,
    "2026-07-23",
  ),
  null,
  "schedule changes must invalidate a prepared detail streak",
);
for (let index = 0; index < MAX_STREAK_CACHE_ENTRIES + 4; index += 1) {
  prepareStreakStats(
    { ...streakCacheHabit, id: 1_000 + index },
    [],
    "2026-07-23",
  );
}
assert.equal(
  getStreakCacheSizeForAudit(),
  MAX_STREAK_CACHE_ENTRIES,
  "habit-detail streak prewarm must remain strictly bounded",
);

const overdueAfterNonCompletion = [
  completionRecords[0],
  { ...completionRecords[1], status: "failure" as const },
  {
    ...completionRecords[1],
    id: 3,
    date: "2026-07-24",
    status: "skipped" as const,
  },
];
assert.equal(
  isHabitScheduledForDate(
    completionInterval,
    "2026-07-20",
    "2026-07-25",
    overdueAfterNonCompletion,
  ),
  true,
  "failure and skip must not restart a completion-driven interval",
);

const newCompletionVersion = [
  {
    effectiveFrom: "2026-07-20",
    startDate: "2026-07-20",
    repeatSchedule: completionInterval,
  },
  {
    effectiveFrom: "2026-07-24",
    startDate: "2026-07-20",
    repeatSchedule: {
      type: "interval",
      every: 5,
      fromCompletion: true,
    } as const,
  },
];
assert.equal(
  isHabitScheduledForDate(
    completionInterval,
    "2026-07-20",
    "2026-07-24",
    completionRecords,
    newCompletionVersion,
  ),
  true,
  "a completion from an older schedule version must not seed the new cycle",
);

const resetCandidates = [
  {
    id: 1,
    habitId: 1,
    date: "2031-08-01",
    status: "done" as const,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 2,
    habitId: 1,
    date: "2031-08-19",
    status: "done" as const,
    createdAt: 2,
    updatedAt: 2,
  },
  {
    id: 3,
    habitId: 1,
    date: "2031-08-20",
    status: "done" as const,
    createdAt: 3,
    updatedAt: 3,
  },
];
const movedStartPartition = partitionRecordsForScheduleVersion(
  resetCandidates,
  daily,
  "2031-08-20",
  "2031-08-20",
  false,
);
assert.deepEqual(
  movedStartPartition.kept.map((record) => record.date),
  ["2031-08-20"],
  "moving the start date forward must permanently remove every earlier mark",
);

const everyTwoDays: RepeatSchedule = {
  type: "interval",
  every: 2,
  fromCompletion: false,
};
const repeatOnlyPartition = partitionRecordsForScheduleVersion(
  resetCandidates,
  everyTwoDays,
  "2031-08-03",
  "2031-08-20",
  true,
);
assert.deepEqual(
  repeatOnlyPartition.kept.map((record) => record.date),
  ["2031-08-01", "2031-08-19"],
  "a repeat-only edit must keep historical records but remove an impossible current-day mark",
);
assert.deepEqual(
  repeatOnlyPartition.removed.map((record) => record.date),
  ["2031-08-20"],
);

const scheduleEditRecords = [
  {
    id: 10,
    habitId: 1,
    date: "2026-07-23",
    status: "done" as const,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 11,
    habitId: 1,
    date: "2026-07-24",
    status: "done" as const,
    createdAt: 2,
    updatedAt: 2,
  },
];
const preserveMarkedToday = planHabitScheduleEdit({
  previousSchedule: daily,
  previousStartDate: "2026-07-01",
  records: scheduleEditRecords,
  nextSchedule: { type: "weekdays", days: [5] },
  today: "2026-07-24",
});
assert.equal(
  preserveMarkedToday.effectiveFrom,
  "2026-07-25",
  "a mark that remains valid today must keep today's historical schedule",
);
assert.deepEqual(
  preserveMarkedToday.keptRecords.map((record) => record.date),
  ["2026-07-23", "2026-07-24"],
);

const apiaMarkedToday = planHabitScheduleEdit({
  previousSchedule: daily,
  previousStartDate: "2011-12-01",
  records: [
    {
      id: 12,
      habitId: 1,
      date: "2011-12-29",
      status: "done" as const,
      createdAt: 3,
      updatedAt: 3,
    },
  ],
  nextSchedule: { type: "weekdays", days: [4] },
  today: "2011-12-29",
});
assert.equal(
  apiaMarkedToday.effectiveFrom,
  "2011-12-30",
  "schedule edits must advance by one civil day even when the local timezone skipped that date",
);

const removeImpossibleToday = planHabitScheduleEdit({
  previousSchedule: daily,
  previousStartDate: "2026-07-01",
  records: scheduleEditRecords,
  nextSchedule: { type: "weekdays", days: [1] },
  today: "2026-07-24",
});
assert.equal(removeImpossibleToday.effectiveFrom, "2026-07-24");
assert.deepEqual(
  removeImpossibleToday.keptRecords.map((record) => record.date),
  ["2026-07-23"],
  "an impossible current-day mark must disappear in the same schedule snapshot",
);
assert.deepEqual(
  removeImpossibleToday.removedRecords.map((record) => record.date),
  ["2026-07-24"],
);

// Calendar matching uses the history from the same schedule-edit snapshot.
const narrowedWeekdaySchedule = planHabitScheduleEdit({
  previousSchedule: { type: "weekdays", days: [1, 2, 4, 5, 6, 7] },
  previousStartDate: "2031-08-01",
  records: [],
  nextSchedule: { type: "weekdays", days: [5] },
  today: "2031-08-19",
});
const narrowedWeekdayMatcher = createHabitScheduleMatcher(
  narrowedWeekdaySchedule.repeatSchedule,
  narrowedWeekdaySchedule.startDate,
  narrowedWeekdaySchedule.keptRecords,
  narrowedWeekdaySchedule.scheduleHistory,
);
assert.equal(narrowedWeekdaySchedule.effectiveFrom, "2031-08-19");
assert.equal(narrowedWeekdayMatcher("2031-08-12"), true);
assert.equal(narrowedWeekdayMatcher("2031-08-13"), false);
assert.equal(narrowedWeekdayMatcher("2031-08-19"), false);
assert.equal(
  narrowedWeekdayMatcher("2031-08-22"),
  true,
  "the edited weekday calendar projection must be visible immediately",
);

const moveStartDate = planHabitScheduleEdit({
  previousSchedule: daily,
  previousStartDate: "2026-07-01",
  previousHistory: changedHistory,
  records: scheduleEditRecords,
  nextStartDate: "2026-07-24",
  today: "2026-07-24",
});
assert.deepEqual(moveStartDate.scheduleHistory, [
  {
    effectiveFrom: "2026-07-24",
    startDate: "2026-07-24",
    repeatSchedule: daily,
  },
]);
assert.deepEqual(
  moveStartDate.keptRecords.map((record) => record.date),
  ["2026-07-24"],
  "changing the start date must remove every record outside the new timeline",
);

const noScheduleChange = planHabitScheduleEdit({
  previousSchedule: daily,
  previousStartDate: "2026-07-01",
  previousHistory: legacyHistory,
  records: scheduleEditRecords,
  nextSchedule: daily,
  nextStartDate: "2026-07-01",
  today: "2026-07-24",
});
assert.equal(noScheduleChange.changed, false);
assert.equal(noScheduleChange.keptRecords, scheduleEditRecords);

const root = resolve(import.meta.dirname, "..");
const repeatLabelsSource = readFileSync(
  resolve(root, "src/features/habits/presentation/repeat-labels.ts"),
  "utf8",
);
assert.doesNotMatch(
  repeatLabelsSource,
  /new Intl\.PluralRules/,
  "opening the interval tab must not depend on an Intl constructor that can be absent in Android Hermes",
);
assert.match(
  repeatLabelsSource,
  /baseLanguage === "ru" \|\| baseLanguage === "uk"/,
);
assert.match(repeatLabelsSource, /baseLanguage === "pl"/);
assert.match(
  repeatLabelsSource,
  /repeat\.everyNDays_\$\{category\}/,
  "interval labels must choose an explicit grammatical form",
);
const store = readFileSync(resolve(root, "src/stores/habit-store.ts"), "utf8");
const homeScreen = readFileSync(resolve(root, "app/index.tsx"), "utf8");
const habitPersistence = readFileSync(
  resolve(root, "src/application/habits/habit-persistence.ts"),
  "utf8",
);
const habitRepository = readFileSync(
  resolve(root, "src/data/sqlite/habit-repository.ts"),
  "utf8",
);
const scheduleEditSource = readFileSync(
  resolve(root, "src/domain/habits/schedule-edit.ts"),
  "utf8",
);
const habitDetailHook = readFileSync(
  resolve(root, "src/features/habit-detail/hooks/useHabitDetail.ts"),
  "utf8",
);
const habitDetailScreen = readFileSync(
  resolve(root, "app/habit/[id].tsx"),
  "utf8",
);
const repeatSheet = readFileSync(
  resolve(root, "src/features/habit-form/components/RepeatSheet.tsx"),
  "utf8",
);
assert.match(scheduleEditSource, /existingTodayRecord/);
assert.match(
  scheduleEditSource,
  /createScheduleDateFacts\(params\.today\)\.civilDayNumber \+ 1/,
  "schedule-version boundaries must use the shared civil-day successor",
);
assert.doesNotMatch(
  scheduleEditSource,
  /new Date\(`\$\{params\.today\}|\.setDate\(/,
  "schedule-version boundaries must not normalize a civil date through local time",
);
assert.match(
  scheduleEditSource,
  /const startDateChanged = startDate !== params\.previousStartDate/,
);
assert.match(scheduleEditSource, /partitionRecordsForScheduleVersion\(/);
assert.match(habitPersistence, /const plan = planHabitScheduleEdit\(/);
assert.match(store, /const plan = planHabitScheduleEdit\(/);
assert.doesNotMatch(habitDetailHook, /LocalSchedulePreview|patchDayStatus/);
assert.match(
  habitDetailHook,
  /peekStreakStats\([\s\S]{0,260}if \(prepared\)\s*return prepared;[\s\S]{0,220}calculateStreakStats\(/,
  "habit detail must reuse the exact prepared streak before taking its pure cold fallback",
);
assert.match(
  habitDetailScreen,
  /await updateHabit\(habitId, \{[\s\S]{0,100}repeatSchedule: schedule,[\s\S]{0,100}startDate: previousStartDate/,
  "a rapid schedule edit must publish one atomic preview and persist its complete visible pair",
);
assert.match(
  habitDetailScreen,
  /await updateHabit\(habitId, \{[\s\S]{0,100}startDate: nextStartDate,[\s\S]{0,100}repeatSchedule: previousSchedule/,
  "a rapid start-date edit must publish one atomic preview and persist its complete visible pair",
);
assert.match(
  habitRepository,
  /removedReasonIds[\s\S]{0,260}deleteIdsInChunks\(executor, "notes", removedReasonIds\)/,
  "generated failure/skip reasons must be removed with invalid day records",
);
assert.match(
  store,
  /if \(scheduleWasUpdated\) \{[\s\S]*?const nextHabit = persistedHabit[\s\S]*?const applyScheduleOwnedFields[\s\S]*?allDayRecords: nextAllDayRecords/,
  "schedule edits must reconcile the in-memory models without reloading the complete database",
);
assert.doesNotMatch(
  store,
  /if \(scheduleWasUpdated\)[\s\S]{0,500}loadAllDayRecords\(\)/,
  "schedule edits must not block completion on a full day-record reload",
);
assert.match(
  store,
  /if \(!state\.allDayRecordsLoaded\) \{[\s\S]{0,120}return HISTORY_PENDING_DAY_LIST_SNAPSHOT/,
  "Home list snapshots must not publish streaks or completion-led schedules from partial history",
);
assert.match(
  store,
  /!stateBefore\.allDayRecordsLoaded[\s\S]{0,180}isCompletionLedIntervalScheduleForDate/,
  "completion-led marks must be rejected until their authoritative history is loaded",
);
const unmarkDayStartIndex = store.indexOf("  async unmarkDay(");
const unmarkDaySource = store.slice(
  unmarkDayStartIndex,
  store.indexOf("  resetInMemoryCaches()", unmarkDayStartIndex),
);
assert.match(
  unmarkDaySource,
  /!stateBefore\.allDayRecordsLoaded[\s\S]{0,180}isCompletionLedIntervalScheduleForDate/,
  "completion-led unmarks must be rejected until their authoritative history is loaded",
);
assert.match(
  homeScreen,
  /!isInteractiveDayLoaded \|\|[\s\S]{0,40}!allDayRecordsLoaded \? \(/,
  "Home must keep one coherent loading presentation until history-dependent rows are trustworthy",
);
assert.match(repeatSheet, /intervalInputRef/);
assert.match(
  repeatSheet,
  /normalizeIntervalDraft\(intervalInputRef\.current\)/,
);
assert.match(
  repeatSheet,
  /behavior=\{Platform\.OS === "ios" \? "padding" : "height"\}/,
);

console.log("Schedule history audit passed.");
