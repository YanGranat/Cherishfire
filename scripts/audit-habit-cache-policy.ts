import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  HABIT_VIEW_MODEL_CACHE_DOMAINS,
  HabitDeletionTombstoneRegistry,
  getHabitViewModelCacheDomainsForChange,
  transitionCacheSource,
  type HabitViewModelCacheDomain,
  type HabitViewModelChange,
} from "../src/stores/habit-cache-policy";
import {
  createHomeSnapshotController,
  type HomeSnapshotComparable,
} from "../src/features/habits/presentation/home-snapshot";
import { projectHabitDayRecordsForDate } from "../src/domain/habits/day-record-projection";
import {
  projectDayListSnapshotHabitMutation,
  type DayListSnapshot,
} from "../src/application/habits/home-day-list-projection";
import type { DayRecord, Habit } from "../src/types/habit";
import { loadHabitStoreForAudit } from "./fixtures/load-habit-store-for-audit";
import { createHabitFixture } from "./fixtures/habit-persistence-equivalence-fixtures";
import {
  capturePendingHabitWriteFence,
  releasePendingHabitWriteFence,
  DiscardedHabitWriteError,
} from "../src/application/habits/habit-write-fence";

const firstRecord: DayRecord = {
  id: 1,
  habitId: 7,
  date: "2026-08-29",
  status: "done",
  createdAt: 1,
  updatedAt: 1,
};
const secondRecord: DayRecord = {
  id: 2,
  habitId: 7,
  date: "2026-08-30",
  status: "minimum",
  createdAt: 2,
  updatedAt: 2,
};
const updatedSecondRecord: DayRecord = {
  ...secondRecord,
  status: "maximum",
  updatedAt: 3,
};
assert.deepEqual(
  projectHabitDayRecordsForDate(
    [firstRecord, secondRecord],
    secondRecord.date,
    updatedSecondRecord,
  ),
  [firstRecord, updatedSecondRecord],
  "one day mutation must replace its scoped record without reordering history",
);
assert.deepEqual(
  projectHabitDayRecordsForDate(
    [firstRecord, secondRecord],
    firstRecord.date,
    null,
  ),
  [secondRecord],
  "unmark must remove only the selected scoped day",
);
assert.deepEqual(
  projectHabitDayRecordsForDate([firstRecord], secondRecord.date, secondRecord),
  [firstRecord, secondRecord],
  "a new day must append exactly once",
);

const homeBase: HomeSnapshotComparable = {
  habits: [],
  allHabitsLoaded: true,
  allDayRecords: [],
  allDayRecordsLoaded: true,
  dayRecords: [],
  currentDayRecordsDate: "2026-08-30",
  dayRecordsByDate: { "2026-08-30": [] },
  isLoading: false,
  error: null,
  errorRevision: 0,
};
const homeController = createHomeSnapshotController(homeBase);
const neighbourPrewarm = {
  ...homeBase,
  dayRecordsByDate: {
    ...homeBase.dayRecordsByDate,
    "2026-08-29": [],
  },
};
assert.equal(
  homeController.reconcile(neighbourPrewarm, true),
  false,
  "neighbour prewarm must not wake the heavy visible Home tree",
);
assert.equal(
  homeController.getSnapshot(true),
  homeBase,
  "neighbour prewarm must not publish the replaced full date map",
);
assert.equal(
  homeController.getDayRecordsWitness("2026-08-29"),
  neighbourPrewarm.dayRecordsByDate["2026-08-29"],
  "the next explicit date intent must still see an authoritative warm-cache witness",
);
const neighbourEvicted = {
  ...homeBase,
  dayRecordsByDate: { "2026-08-30": homeBase.dayRecordsByDate["2026-08-30"] },
};
assert.equal(homeController.reconcile(neighbourEvicted, true), false);
assert.equal(
  homeController.getDayRecordsWitness("2026-08-29"),
  undefined,
  "the non-reactive witness must also expose authoritative cache eviction",
);
const hiddenRelevantUpdate = {
  ...neighbourPrewarm,
  habits: [{ id: 1 }],
};
assert.equal(
  homeController.reconcile(hiddenRelevantUpdate, false),
  false,
  "covered Home must retain facts without rebuilding its invisible native tree",
);
assert.equal(
  homeController.getSnapshot(false),
  homeBase,
  "a covered render must remain at the last actually published snapshot",
);
assert.equal(
  homeController.getSnapshot(true),
  hiddenRelevantUpdate,
  "the focus render must read the latest coherent facts before reveal",
);
assert.equal(
  homeController.reconcile(hiddenRelevantUpdate, true),
  true,
  "focus publication must advance the retained public snapshot exactly once",
);
assert.equal(
  homeController.reconcile(hiddenRelevantUpdate, true),
  false,
  "reconciliation must not duplicate an already published snapshot",
);
const hiddenSecondUpdate = {
  ...hiddenRelevantUpdate,
  habits: [{ id: 2 }],
};
assert.equal(homeController.reconcile(hiddenSecondUpdate, false), false);
assert.equal(homeController.reconcile(hiddenRelevantUpdate, false), false);
assert.equal(
  homeController.getSnapshot(true),
  hiddenRelevantUpdate,
  "a covered A -> B -> A sequence must expose only the latest coherent facts on focus",
);
assert.equal(
  homeController.reconcile(hiddenRelevantUpdate, true),
  false,
  "returning to the already published semantic state must not fabricate a notification",
);

const projectionHabit: Habit = {
  id: 7,
  name: "Read",
  description: null,
  descriptionVisible: true,
  repeatSchedule: { type: "daily" },
  startDate: "2026-08-01",
  reminderEnabled: false,
  reminderTime: null,
  displayOrder: 0,
  isArchived: false,
  archivedAt: null,
  archiveHistory: [],
  createdAt: 1,
  updatedAt: 1,
};
const projectionBase: DayListSnapshot = {
  activeItems: [
    {
      habit: projectionHabit,
      section: "active",
      stableKey: "active:7",
      checkboxState: "unmarked",
      currentStreak: 0,
      completedAt: null,
    },
  ],
  completedItems: [],
  statusByHabitId: new Map(),
};
const neighbouringHabit: Habit = {
  ...projectionHabit,
  id: 8,
  name: "Walk",
  displayOrder: 1,
};
const neighbouringItem = {
  habit: neighbouringHabit,
  section: "active" as const,
  stableKey: "active:8",
  checkboxState: "unmarked" as const,
  currentStreak: 4,
  completedAt: null,
};
projectionBase.activeItems.push(neighbouringItem);
const projectionDone = projectDayListSnapshotHabitMutation({
  snapshot: projectionBase,
  scheduledHabitIds: [7, 8],
  habit: projectionHabit,
  record: secondRecord,
  isPast: false,
  currentStreak: 1,
});
assert.equal(projectionDone.activeItems.length, 1);
assert.equal(
  projectionDone.activeItems[0],
  neighbouringItem,
  "a one-habit projection must preserve every unrelated row by identity",
);
assert.equal(projectionDone.completedItems[0]?.habit.id, 7);
assert.equal(projectionDone.completedItems[0]?.checkboxState, "minimum");
assert.equal(projectionDone.completedItems[0]?.currentStreak, 1);
assert.equal(projectionDone.statusByHabitId.get(7), "minimum");
const projectionUnscheduled = projectDayListSnapshotHabitMutation({
  snapshot: projectionDone,
  scheduledHabitIds: [8],
  habit: projectionHabit,
  record: secondRecord,
  isPast: false,
  currentStreak: 1,
});
assert.equal(projectionUnscheduled.activeItems.length, 1);
assert.equal(projectionUnscheduled.activeItems[0], neighbouringItem);
assert.equal(projectionUnscheduled.completedItems.length, 0);
assert.equal(projectionUnscheduled.statusByHabitId.has(7), false);

function auditDeletionTombstoneRetirement(): void {
  const registry = new HabitDeletionTombstoneRegistry();
  const releaseOlderHabitRead = registry.beginRead();
  const releaseOlderRecordRead = registry.beginRead();
  registry.add([41, 42]);
  registry.retireWhenReadersSettle([41]);
  assert.equal(registry.has(41), true);
  releaseOlderHabitRead();
  assert.equal(
    registry.has(41),
    true,
    "a second old SELECT must keep a committed tombstone alive",
  );
  releaseOlderRecordRead();
  releaseOlderRecordRead();
  assert.equal(
    registry.has(41),
    false,
    "the tombstone must retire exactly when all older reads settle",
  );

  registry.discard([42]);
  assert.equal(
    registry.has(42),
    false,
    "a rolled-back deletion must remove its tombstone immediately",
  );

  const releaseAcrossReset = registry.beginRead();
  registry.add([43]);
  registry.clear();
  registry.add([44]);
  releaseAcrossReset();
  assert.equal(
    registry.has(44),
    true,
    "an old-generation read release must not retire a new tombstone",
  );
  registry.discard([44]);
}

auditDeletionTombstoneRetirement();

function domains(change: HabitViewModelChange): Set<HabitViewModelCacheDomain> {
  return new Set(getHabitViewModelCacheDomainsForChange(change));
}

const metadata = domains("metadata");
assert.deepEqual(
  [...metadata],
  ["day-list", "habit-index", "archived-habits"],
  "metadata must invalidate only models that expose changed habit fields",
);
for (const preserved of [
  "scheduled-ids",
  "streaks",
  "records-by-habit",
] as const) {
  assert.equal(
    metadata.has(preserved),
    false,
    `metadata must preserve ${preserved}`,
  );
}

const ordering = domains("ordering");
assert.equal(ordering.has("scheduled-ids"), true);
assert.equal(ordering.has("day-list"), true);
assert.equal(ordering.has("streaks"), false);
assert.equal(ordering.has("records-by-habit"), false);

const records = domains("records");
for (const required of [
  "day-list",
  "scheduled-ids",
  "streaks",
  "records-by-habit",
] as const) {
  assert.equal(
    records.has(required),
    true,
    `records must invalidate ${required}`,
  );
}
assert.equal(records.has("habit-index"), false);
assert.equal(records.has("archived-habits"), false);

const lifecycle = domains("lifecycle");
for (const required of [
  "day-list",
  "scheduled-ids",
  "habit-index",
  "streaks",
  "archived-habits",
] as const) {
  assert.equal(
    lifecycle.has(required),
    true,
    `lifecycle must invalidate ${required}`,
  );
}
assert.equal(
  lifecycle.has("records-by-habit"),
  false,
  "archiving/restoring does not mutate day records",
);

for (const change of ["schedule", "existence", "reset"] as const) {
  assert.deepEqual(
    new Set(getHabitViewModelCacheDomainsForChange(change)),
    new Set(HABIT_VIEW_MODEL_CACHE_DOMAINS),
    `${change} must invalidate every affected cache domain`,
  );
}

const previousHabits = [{ id: 1 }];
const nextHabits = [{ id: 1 }];
const unrelatedHabits = [{ id: 2 }];
assert.equal(
  transitionCacheSource({
    cachedSource: previousHabits,
    previousSource: previousHabits,
    nextSource: nextHabits,
    invalidated: metadata.has("scheduled-ids"),
  }),
  nextHabits,
  "metadata must retarget a valid derived cache to the new immutable array",
);
assert.equal(
  transitionCacheSource({
    cachedSource: unrelatedHabits,
    previousSource: previousHabits,
    nextSource: nextHabits,
    invalidated: false,
  }),
  unrelatedHabits,
  "a cache based on another source must not be falsely claimed by a mutation",
);
assert.equal(
  transitionCacheSource({
    cachedSource: previousHabits,
    previousSource: previousHabits,
    nextSource: nextHabits,
    invalidated: true,
  }),
  null,
  "a changed semantic domain must rebuild lazily",
);

const storeSource = readFileSync(
  resolve(process.cwd(), "src/stores/habit-store.ts"),
  "utf8",
);
const habitDetailSource = readFileSync(
  resolve(process.cwd(), "src/features/habit-detail/hooks/useHabitDetail.ts"),
  "utf8",
);
const habitRepositorySource = readFileSync(
  resolve(process.cwd(), "src/data/sqlite/habit-repository.ts"),
  "utf8",
);
const habitPersistenceSource = readFileSync(
  resolve(process.cwd(), "src/application/habits/habit-persistence.ts"),
  "utf8",
);
const homeSource = readFileSync(
  resolve(process.cwd(), "app/index.tsx"),
  "utf8",
);
const actionSlice = (start: string, end: string): string => {
  const startIndex = storeSource.indexOf(start);
  const endIndex = storeSource.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing ${start}`);
  return storeSource.slice(startIndex, endIndex);
};
const sourceSlice = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing ${start}`);
  return source.slice(startIndex, endIndex);
};
const assertOrdered = (
  source: string,
  markers: readonly string[],
  message: string,
) => {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1);
    assert.ok(current > previous, `${message}: missing/out-of-order ${marker}`);
    previous = current;
  }
};
assert.doesNotMatch(
  storeSource,
  /resetViewModelCaches/,
  "habit cache invalidation must remain scoped",
);
assert.doesNotMatch(
  storeSource,
  /const deletedHabitTombstones = new Set/,
  "deletion tombstones need reader-owned retirement instead of unbounded retention",
);
assert.match(
  storeSource,
  /function resolveDayRecordsForDate[\s\S]{0,520}allDayRecordsByDateCache\[date\] \?\? EMPTY_DAY_RECORDS/,
  "a newly selected prewarmed neighbour must remain resolvable when the focused Home snapshot intentionally suppressed that cache-only update",
);
assert.match(
  storeSource,
  /function stabilizeViewModels\([\s\S]{0,900}if \(prev && areViewModelsEqual\(prev, item\)\)[\s\S]{0,180}return prev/,
  "unchanged Home rows must retain their view-model identity across list snapshot rebuilds",
);
assert.match(
  storeSource,
  /const activeStabilized = stabilizeViewModels\([\s\S]{0,260}const completedStabilized = stabilizeViewModels\([\s\S]{0,380}activeItems: activeStabilized\.stableItems,[\s\S]{0,100}completedItems: completedStabilized\.stableItems/,
  "both Home sections must publish the stabilized row view models consumed by React.memo",
);
const homeDateSelectionSource = sourceSlice(
  homeSource,
  "const handleSelectDate = useCallback",
  "const handleSelectDateRef",
);
const homeDateAuthoritativeStateIndex = homeDateSelectionSource.indexOf(
  "const habitState = useHabitStore.getState();",
);
const homeDateRawReadinessIndex = homeDateSelectionSource.indexOf(
  "habitState.dayRecordsByDate[date]",
  homeDateAuthoritativeStateIndex,
);
const homeDateSnapshotReadyIndex = homeDateSelectionSource.indexOf(
  "const listSnapshotReady = hasDayListSnapshotForState(",
  homeDateRawReadinessIndex,
);
const homeDateRequestPublishIndex = homeDateSelectionSource.indexOf(
  "setRequestedDateForList(",
  homeDateSnapshotReadyIndex,
);
const homeDateReadyBranchIndex = homeDateSelectionSource.indexOf(
  "if (listSnapshotReady)",
  homeDateRequestPublishIndex,
);
const homeDateResolvedPublishIndex = homeDateSelectionSource.indexOf(
  "setResolvedDateForList(",
  homeDateReadyBranchIndex,
);
assert.ok(
  homeDateAuthoritativeStateIndex >= 0 &&
    homeDateRawReadinessIndex > homeDateAuthoritativeStateIndex &&
    homeDateSnapshotReadyIndex > homeDateRawReadinessIndex &&
    homeDateRequestPublishIndex > homeDateSnapshotReadyIndex &&
    homeDateReadyBranchIndex > homeDateRequestPublishIndex &&
    homeDateResolvedPublishIndex > homeDateReadyBranchIndex,
  "warm Home date selection must prove the complete current-store presentation ready before publishing one visible date",
);
assert.match(
  homeSource,
  /const dayListSnapshot = getDayListSnapshotForState\(\s*habitState,\s*interactiveDateForLists,\s*listIsPast/,
  "the committed Home date must resolve its complete list through the authoritative cache-aware projection",
);
assert.doesNotMatch(
  homeDateSelectionSource,
  /getDayListSnapshot\(/,
  "a warm Home date press must reuse the prepared list without an eager rebuild",
);
assert.match(
  homeSource,
  /const isSelectedDayLoaded =[\s\S]{0,180}hasSelectedDateCached \|\|[\s\S]{0,60}allDayRecordsLoaded/,
  "complete authoritative history must keep a selected prewarmed neighbour ready even when the parent snapshot omitted its cache-only update",
);
const refreshComputedDataSlice = actionSlice(
  "  refreshComputedData() {",
  "  clearError(expectedRevision)",
);
assert.match(
  refreshComputedDataSlice,
  /invalidateViewModelCaches\(\["day-list", "streaks"\]\)/,
  "a local-day rollover must invalidate the list and streak projections",
);
assert.doesNotMatch(
  refreshComputedDataSlice,
  /resetDerivedCaches\(\)/,
  "a local-day rollover must preserve loaded day rows, hot windows, in-flight reads, and optimistic overlays",
);
for (const [start, end] of [
  ["  async loadHabits(options)", "  async loadDayRecords(date"],
  ["  async preloadDayRecordsWindow(", "  async preloadDayRecords(date"],
  ["  async loadAllDayRecords(options)", "  async createHabit("],
] as const) {
  const readSection = actionSlice(start, end);
  assert.match(readSection, /deletedHabitTombstones\.beginRead\(\)/);
  assert.match(readSection, /finally \{[\s\S]{0,100}releaseTombstoneRead\(\)/);
}
assert.match(
  actionSlice("  async deleteHabits(ids)", "  async markDay("),
  /await habitPersistence\.deleteHabits\(deletedIdList\);[\s\S]{0,500}deletedHabitTombstones\.retireWhenReadersSettle\(deletedIds\)/,
  "a committed delete must retire tombstones only after older readers settle",
);
assert.match(
  storeSource,
  /transitionHabitViewModelCaches\([\s\S]*?invalidated\.has\("scheduled-ids"\)[\s\S]*?invalidated\.has\("streaks"\)/,
  "habit-array transitions must preserve unchanged schedule and streak sources",
);
assert.match(
  storeSource,
  /async renameHabit\([\s\S]*?transitionHabitViewModelCaches\([\s\S]*?"metadata"/,
  "rename must use the metadata cache transition",
);
assert.match(
  storeSource,
  /if \(!changesSchedule\)[\s\S]*?transitionHabitViewModelCaches\([\s\S]*?"metadata"/,
  "description/reminder changes must use the metadata cache transition",
);
assert.match(
  storeSource,
  /invalidateViewModelCachesForChange\("schedule"\)/,
  "schedule replacement must invalidate schedule-derived models",
);
assert.match(
  storeSource,
  /invalidateViewModelCachesForChange\("lifecycle"\)/,
  "archive lifecycle changes must invalidate lifecycle-derived models",
);
assert.match(
  storeSource,
  /transitionRecordViewModelCaches\(state\.allDayRecords, mapped\)/,
  "authoritative record replacement must explicitly invalidate record-derived models",
);
assert.match(
  storeSource,
  /advanceScheduledIdsCacheForHabit\([\s\S]*?advanceStreakCacheForHabit\(/,
  "single-record mutations must keep their existing incremental fast path",
);
assertOrdered(
  actionSlice("  async updateHabit", "  async renameHabit"),
  [
    "// Habit detail has already published the complete schedule preview.",
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    "await waitForHabitPersistenceTurn(ownership.writeSequence)",
    '!shouldPersistHabitMutation(ownership, "schedule")',
    "habitPersistence.persistScheduleEdit({",
  ],
  "a superseded schedule edit must not enter SQLite after its paint barrier",
);
assertOrdered(
  actionSlice("  async renameHabit", "  async reorderHabits"),
  [
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    "await waitForHabitPersistenceTurn(ownership.writeSequence)",
    '!shouldPersistHabitMutation(ownership, "name")',
    "habitPersistence.patchHabit(id",
  ],
  "an older rename must not persist over a newer rename",
);
assertOrdered(
  actionSlice("  async reorderHabits", "  async archiveHabit"),
  [
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    "await waitForHabitPersistenceTurn(writeSequence)",
    "token !== reorderWriteToken",
    "habitPersistence.persistReorder(orderedIds)",
  ],
  "an older reorder must not persist after a newer tuned reorder",
);
const reorderSource = actionSlice(
  "  async reorderHabits",
  "  async archiveHabit",
);
assertOrdered(
  reorderSource,
  [
    "assignDisplayOrdersAroundArchivedSlots(",
    "reconcileDisplayOrderRows(",
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    "habitPersistence.persistReorder(orderedIds)",
  ],
  "Home reorder must publish complete display-order metadata in its existing optimistic commit before persistence",
);
assert.match(
  reorderSource,
  /nextHabits === state\.habits[\s\S]{0,100}nextAllHabits === state\.allHabits[\s\S]{0,100}return state/,
  "an equal reorder persistence acknowledgement must not publish a second store render",
);
assert.match(
  habitPersistenceSource,
  /persistReorder\(orderedActiveIds\)[\s\S]{0,700}session\.patchHabitDisplayOrders\(persistedOrders\)/,
  "habit reorder persistence must use one semantic bulk port instead of one awaited UPDATE per habit",
);
assert.doesNotMatch(
  sourceSlice(
    habitPersistenceSource,
    "    persistReorder(orderedActiveIds)",
    "    archiveHabit(habitId, now)",
  ),
  /for \(const assignment[\s\S]{0,160}session\.patchHabit/,
  "habit reorder persistence must not restore the sequential per-row write loop",
);
assertOrdered(
  actionSlice("  async archiveHabit", "  async restoreHabit"),
  [
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    "await waitForHabitPersistenceTurn(ownership.writeSequence)",
    '!shouldPersistHabitMutation(ownership, "existence")',
    '!shouldPersistHabitMutation(ownership, "lifecycle")',
    "habitPersistence.archiveHabit(",
  ],
  "archive must yield to a newer restore/delete intent before persistence",
);
assertOrdered(
  actionSlice("  async restoreHabits", "  async deleteHabit"),
  [
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    "await waitForHabitPersistenceTurn(writeSequence)",
    "const targetsToPersist = targets.filter",
    'shouldPersistHabitMutation(ownership, "existence")',
    'shouldPersistHabitMutation(ownership, "lifecycle")',
    "habitPersistence.restoreHabits(",
  ],
  "bulk restore must persist only ids it still owns after the paint barrier",
);
const deleteSource = actionSlice("  async deleteHabits", "  async markDay");
assertOrdered(
  deleteSource,
  [
    "pendingHabitDeletionIds.add(id)",
    "set((state) =>",
    "await persistenceCommitScheduler.waitForCommitOpportunity();",
    "await waitForHabitPersistenceTurn(writeSequence)",
    "habitPersistence.deleteHabits(deletedIdList)",
  ],
  "delete must block competing mutations, publish once, then persist",
);
for (const guardedAction of [
  actionSlice("  async updateHabit", "  async renameHabit"),
  actionSlice("  async renameHabit", "  async reorderHabits"),
  actionSlice("  async archiveHabit", "  async restoreHabit"),
  actionSlice("  async restoreHabits", "  async deleteHabit"),
  actionSlice("  async markDay", "  async unmarkDay"),
  actionSlice("  async unmarkDay", "  resetInMemoryCaches"),
]) {
  assert.match(
    guardedAction,
    /pendingHabitDeletionIds\.has/,
    "a pending delete must prevent a later mutation from resurrecting its habit",
  );
}
for (const [source, operation] of [
  [actionSlice("  async markDay", "  async unmarkDay"), "mark"],
  [actionSlice("  async unmarkDay", "  resetInMemoryCaches"), "unmark"],
] as const) {
  assert.match(
    source,
    /const baseList = resolveDayRecordsForDate\(stateBefore, date\);/,
    `a rapid warm-history day ${operation} must preserve every cached record for the target date`,
  );
  assertOrdered(
    source,
    [
      "await persistenceCommitScheduler.waitForCommitOpportunity();",
      "await waitForHabitPersistenceTurn(writeSequence)",
      "!shouldPersistDayMutation(overlayKey, mutationId, writeSequence)",
      operation === "mark"
        ? "habitPersistence.markDay({"
        : "habitPersistence.unmarkDay(habitId, date)",
    ],
    `a superseded day ${operation} must not reach SQLite`,
  );
  assertOrdered(
    source,
    [
      "catch (e)",
      "await repairFailedDayMutation(",
      "habitId,",
      "date,",
      "overlayKey,",
      "mutationId,",
      "repaired && isLatestDayMutation(overlayKey, mutationId)",
      "scheduleHabitReminderAfterRecordChange(get().habits, habitId);",
      "finishDayMutation(overlayKey, mutationId);",
      "return !ownedFailure;",
    ],
    `a failed latest day ${operation} must reconcile its owned record before releasing the mutation and repairing reminders`,
  );
}
assert.match(
  storeSource,
  /createHabit: withPendingHabitWriteTracking[\s\S]*updateHabit: withPendingHabitWriteTracking[\s\S]*renameHabit: withPendingHabitWriteTracking[\s\S]*reorderHabits: withPendingHabitWriteTracking[\s\S]*archiveHabit: withPendingHabitWriteTracking[\s\S]*restoreHabits: withPendingHabitWriteTracking[\s\S]*deleteHabits: withPendingHabitWriteTracking[\s\S]*markDay: withPendingHabitWriteTracking[\s\S]*unmarkDay: withPendingHabitWriteTracking/,
  "every deferred mutation must remain visible to the export/import barrier",
);

for (const forbiddenDetailPersistence of [
  "runtimeDb",
  "@/db/rows",
  "HABIT_COLUMNS",
  "DAY_RECORD_COLUMNS",
  "RawHabitDatabaseRow",
  "RawDayRecordDatabaseRow",
  "SELECT ",
]) {
  assert.equal(
    habitDetailSource.includes(forbiddenDetailPersistence),
    false,
    `habit detail must not own SQLite or row mapping: ${forbiddenDetailPersistence}`,
  );
}
assert.match(
  habitDetailSource,
  /habitDetailQueries\.load\(\{[\s\S]{0,120}habitId/,
  "habit detail must use the application-facing query facade",
);

assert.doesNotMatch(
  habitRepositorySource,
  /from\s+["'](?:react|zustand|@\/stores\/|@\/features\/|expo-router)/,
  "the SQLite repository must not depend on presentation or application stores",
);
for (const mappingContract of [
  "mapHabitPersistenceRow",
  "toRepeatSchedule(row.repeatType, repeatConfig)",
  "toScheduleHistory(",
  "normalizeArchiveHistory(row.archiveHistory)",
  "row.archivedAt.getTime()",
  "row.createdAt.getTime()",
  "row.updatedAt.getTime()",
  "mapHabitDatabaseRow(row)",
  "function mapRawDayRecordRow(row: RawDayRecordDatabaseRow): DayRecord",
  "habitId: row.habit_id",
  "createdAt: row.created_at",
  "updatedAt: row.updated_at",
  'UPDATE habits SET ${assignments.join(", ")} WHERE id = ?',
  'key === "descriptionVisible"',
  'key === "reminderEnabled"',
  'key === "isArchived"',
  'key === "repeatConfig"',
  'key === "archiveHistory"',
]) {
  assert.equal(
    habitRepositorySource.includes(mappingContract),
    true,
    `habit repository must preserve mapping semantics: ${mappingContract}`,
  );
}

assert.match(
  habitRepositorySource,
  /FROM habits\s+ORDER BY display_order ASC, id ASC/,
  "all-habits repository read must preserve stable display/id ordering",
);
const unorderedHabitRecordsRead = sourceSlice(
  habitRepositorySource,
  "async readDayRecordsForHabit(habitId)",
  "async readAllDayRecords()",
);
assert.doesNotMatch(
  unorderedHabitRecordsRead,
  /ORDER BY/,
  "detail fallback must preserve its existing unordered day-record query",
);
const orderedHabitRecordsRead = sourceSlice(
  habitRepositorySource,
  "async function readDayRecordsForHabitOrderedByDate",
  "function createSqliteHabitSession",
);
assert.match(
  orderedHabitRecordsRead,
  /WHERE habit_id = \?\s+ORDER BY date ASC/,
  "store habit-history reads must preserve chronological ordering",
);
const rangedRecordsRead = sourceSlice(
  habitRepositorySource,
  "async readDayRecordsInDateRange(startDate, endDate)",
  "async readMaxDisplayOrder()",
);
assert.match(
  rangedRecordsRead,
  /WHERE date >= \? AND date <= \?/,
  "day-window reads must preserve their inclusive date bounds",
);
assert.doesNotMatch(
  habitPersistenceSource,
  /@\/(?:data|db)\/|runtimeDb|expo-sqlite|react-native|zustand/,
  "habit application persistence must remain independent of SQLite and UI",
);

assert.match(
  storeSource,
  /function queryAllHabitModels[\s\S]{0,300}habitsLoadInFlight\?\.epoch[\s\S]{0,300}readAllHabits\(\)/,
  "the store must preserve epoch-scoped sharing around repository habit reads",
);
assert.match(
  storeSource,
  /function queryAllDayRecordModels[\s\S]{0,400}allDayRecordsLoadInFlight\?\.epoch[\s\S]{0,300}readAllDayRecords\(\)/,
  "the store must preserve epoch-scoped sharing around repository record reads",
);
assert.match(
  storeSource,
  /dayRecordsWindowLoadInFlight\.get\(inFlightKey\)[\s\S]{0,250}readDayRecordsInDateRange\(startDate, endDate\)/,
  "the store must preserve shared in-flight date-window reads",
);
assert.doesNotMatch(
  storeSource,
  /function rowToHabit|function rowToRecord|const HABIT_PATCH_COLUMNS|function toDatabaseValue|async function persistHabitPatch/,
  "habit persistence mapping and generic patching must have one repository owner",
);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function advanceMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function finishPublicationWithin<T>(request: Promise<T>, operation: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    deadline = setTimeout(() => reject(new Error(`${operation} did not settle`)), 2000);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(deadline!);
  }
}

async function auditHabitReadPublication(): Promise<void> {
  for (const rejectOldRead of [false, true]) {
    let paint = Promise.resolve();
    const loaded = loadHabitStoreForAudit(
      { habits: [createHabitFixture({ name: "Initial" })], records: [] },
      { waitForCommitOpportunity: () => paint },
    );
    const store = loaded.storeModule.useHabitStore;
    await store.getState().loadHabits();
    const read = loaded.persistence.deferNextHabitRead();
    if (rejectOldRead) loaded.persistence.failNextHabitRead();
    let readSettled = false;
    const loading = store.getState().loadHabits().then((result) => {
      readSettled = true;
      return result;
    });
    await read.entered;
    const writePaint = deferred<void>();
    paint = writePaint.promise;
    const rename = store.getState().renameHabit(1, "Updated");
    assert.equal(store.getState().habits[0]?.name, "Updated");
    read.release();
    await advanceMicrotasks();
    assert.equal(readSettled, false, "a superseded habit read must wait for its newer admitted write");
    assert.equal(store.getState().habits[0]?.name, "Updated", "a superseded read or read error must not roll back optimistic habit fields");
    writePaint.resolve();
    await rename;
    assert.equal(await loading, true);
    assert.equal(store.getState().habits[0]?.name, "Updated");
    assert.equal(store.getState().allHabits[0]?.name, "Updated");
    assert.equal(store.getState().error, null);
  }

  for (let offset = 0; offset < 5; offset += 1) {
    let paint = Promise.resolve();
    const loaded = loadHabitStoreForAudit(
      { habits: [createHabitFixture({ name: "Initial" })], records: [] },
      { waitForCommitOpportunity: () => paint },
    );
    const store = loaded.storeModule.useHabitStore;
    await store.getState().loadHabits();
    const writePaint = deferred<void>();
    paint = writePaint.promise;
    const first = store.getState().renameHabit(1, "First");
    const loading = store.getState().loadHabits();
    let newest!: Promise<void>;
    const nextAdmission = first.then(async () => {
      for (let index = 0; index < offset; index += 1) await Promise.resolve();
      newest = store.getState().renameHabit(1, "Newest");
    });
    writePaint.resolve();
    await Promise.all([first, nextAdmission]);
    assert.ok(newest, "the newer habit command must be delivered");
    await newest;
    assert.equal(await loading, true);
    assert.equal(store.getState().habits[0]?.name, "Newest", "a write admitted during barrier settlement or SELECT must own the final habit publication");
  }

  const reentrant = loadHabitStoreForAudit({ habits: [createHabitFixture({ name: "Initial" })], records: [] });
  const reentrantStore = reentrant.storeModule.useHabitStore;
  await reentrantStore.getState().loadHabits();
  let subscriberLoad: Promise<boolean> | null = null;
  let subscriberLoadAccepted = false;
  const unsubscribe = reentrantStore.subscribe((state) => {
    if (state.habits[0]?.name !== "Reentrant" || subscriberLoadAccepted) return;
    subscriberLoadAccepted = true;
    subscriberLoad = state.loadHabits();
  });
  try {
    await reentrantStore.getState().renameHabit(1, "Reentrant");
    assert.ok(subscriberLoad, "a synchronous subscriber must actually start the load");
    assert.equal(await finishPublicationWithin(subscriberLoad, "reentrant habit read"), true);
    assert.equal(reentrantStore.getState().habits[0]?.name, "Reentrant");
  } finally {
    unsubscribe();
  }
  const rapidWrites = Array.from({ length: 100 }, (_, index) =>
    reentrantStore.getState().renameHabit(1, `Revision ${index}`),
  );
  const rapidLoad = reentrantStore.getState().loadHabits();
  await Promise.all(rapidWrites);
  assert.equal(await finishPublicationWithin(rapidLoad, "finite rapid-write publication"), true);
  assert.equal(reentrantStore.getState().habits[0]?.name, "Revision 99", "a finite rapid-write burst must settle at its latest durable intent without starving the read");

  const held = loadHabitStoreForAudit({ habits: [createHabitFixture({ name: "Initial" })], records: [] });
  const heldStore = held.storeModule.useHabitStore;
  await heldStore.getState().loadHabits();
  const exportFence = capturePendingHabitWriteFence();
  try {
    const rename = heldStore.getState().renameHabit(1, "Held");
    let completed = false;
    const loading = heldStore.getState().loadHabits().then((result) => {
      completed = true;
      return result;
    });
    await advanceMicrotasks();
    assert.equal(completed, false);
    assert.equal(heldStore.getState().habits[0]?.name, "Held", "an export-held optimistic intent must remain visible until its write can commit");
    releasePendingHabitWriteFence(exportFence);
    await rename;
    assert.equal(await loading, true);
    assert.equal(heldStore.getState().habits[0]?.name, "Held");
  } finally {
    releasePendingHabitWriteFence(exportFence);
  }

  const creationPaint = deferred<void>();
  const initial = loadHabitStoreForAudit(
    { habits: [createHabitFixture({ name: "Existing" })], records: [] },
    { waitForCommitOpportunity: () => creationPaint.promise },
  );
  const initialStore = initial.storeModule.useHabitStore;
  const create = initialStore.getState().createHabit({
    name: "Created", repeatSchedule: { type: "daily" }, startDate: "2026-07-01", reminderEnabled: false,
  });
  const initialLoad = initialStore.getState().loadHabits();
  await advanceMicrotasks();
  assert.equal(initialStore.getState().allHabitsLoaded, false, "pending creation alone must not claim readiness for unknown existing rows");
  creationPaint.resolve();
  await create;
  assert.equal(await initialLoad, true);
  assert.equal(initialStore.getState().allHabitsLoaded, true);
  assert.deepEqual(initialStore.getState().allHabits.map((habit) => habit.name), ["Existing", "Created"]);
  assert.equal(new Set(initialStore.getState().allHabits.map((habit) => habit.id)).size, 2);

  let importPaint = Promise.resolve();
  const imported = loadHabitStoreForAudit(
    { habits: [createHabitFixture({ name: "Original" })], records: [] },
    { waitForCommitOpportunity: () => importPaint },
  );
  const importedStore = imported.storeModule.useHabitStore;
  await importedStore.getState().loadHabits();
  const importFence = capturePendingHabitWriteFence();
  const oldPaint = deferred<void>();
  importPaint = oldPaint.promise;
  const oldCreation = importedStore.getState().createHabit({
    name: "Discarded", repeatSchedule: { type: "daily" }, startDate: "2026-07-01", reminderEnabled: false,
  });
  const discardedCreation = assert.rejects(oldCreation, DiscardedHabitWriteError);
  importedStore.getState().resetInMemoryCaches();
  imported.persistence.replaceDataset({ habits: [createHabitFixture({ name: "Imported" })], records: [] });
  const lateCreation = importedStore.getState().createHabit({
    name: "Also discarded", repeatSchedule: { type: "daily" }, startDate: "2026-07-01", reminderEnabled: false,
  });
  const discardedLateCreation = assert.rejects(lateCreation, DiscardedHabitWriteError);
  const lateDeletion = importedStore.getState().deleteHabits([1]);
  try {
    assert.equal(await finishPublicationWithin(importedStore.getState().loadHabits({ mode: "committed-import" }), "committed import publication"), true, "committed import publication must not wait for buffered old-generation writes");
    assert.deepEqual(importedStore.getState().habits.map((habit) => habit.name), ["Imported"]);
    releasePendingHabitWriteFence(importFence, { discardPostFence: true });
    oldPaint.resolve();
    await Promise.all([discardedCreation, discardedLateCreation, lateDeletion]);
    assert.equal((await imported.persistence.application.readAllHabits()).length, 1, "a discarded old creation must never reach replacement persistence after delayed paint");
    await importedStore.getState().createHabit({
      name: "New", repeatSchedule: { type: "daily" }, startDate: "2026-07-01", reminderEnabled: false,
    });
    assert.deepEqual(importedStore.getState().habits.map((habit) => habit.name), ["Imported", "New"], "new commands after release must not inherit an old discard outcome");
  } finally {
    releasePendingHabitWriteFence(importFence, { discardPostFence: true });
    oldPaint.resolve();
  }

  const reset = loadHabitStoreForAudit({ habits: [createHabitFixture({ name: "Old" })], records: [] });
  const resetStore = reset.storeModule.useHabitStore;
  await resetStore.getState().loadHabits();
  const oldRead = reset.persistence.deferNextHabitRead();
  const oldLoad = resetStore.getState().loadHabits();
  await oldRead.entered;
  resetStore.getState().resetInMemoryCaches();
  reset.persistence.replaceDataset({ habits: [createHabitFixture({ name: "Replacement" })], records: [] });
  assert.equal(await resetStore.getState().loadHabits({ mode: "committed-import" }), true);
  oldRead.release();
  assert.equal(await oldLoad, false);
  assert.equal(resetStore.getState().habits[0]?.name, "Replacement");
  reset.persistence.failNextHabitRead();
  assert.equal(await resetStore.getState().loadHabits(), false, "a current read error must be reported, not treated as a stale generation");
  assert.match(resetStore.getState().error ?? "", /Injected habit read failure/);
}

let publicationDeadline: ReturnType<typeof setTimeout>;
const publicationTimeout = new Promise<never>((_, reject) => {
  publicationDeadline = setTimeout(() => reject(new Error("Habit publication audit deadline")), 15000);
});
void Promise.race([auditHabitReadPublication(), publicationTimeout]).then(
  () => {
    clearTimeout(publicationDeadline);
    console.log("Habit cache policy and read publication audit passed.");
  },
  (error) => {
    clearTimeout(publicationDeadline);
    console.error(error);
    process.exitCode = 1;
  },
);
