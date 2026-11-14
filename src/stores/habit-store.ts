import { create } from "zustand";
import {
  normalizePersistedDayReason,
  StaleHabitScheduleMutationError,
  type HabitPatch,
} from "@/application/habits/habit-persistence";
import {
  partitionMixedHabitUpdateInput,
  selectPersistableHabitUpdatePatch,
} from "@/application/habits/habit-update-patch";
import { habitPersistence } from "@/composition/habits";
import { persistenceCommitScheduler } from "@/composition/persistence";
import { addDays } from "date-fns/addDays";
import { format } from "date-fns/format";
import { parseISO } from "date-fns/parseISO";
import type {
  Habit,
  DayRecord,
  DayStatus,
  CreateHabitInput,
  UpdateHabitInput,
} from "@/types/habit";
import { areRepeatSchedulesEqual } from "@/types/habit";
import { calculateCurrentStreak } from "@/domain/habits/streak";
import { projectHabitDayRecordsForDate } from "@/domain/habits/day-record-projection";
import {
  scheduleHabitReminderAfterRecordChange,
  scheduleHabitRemindersSync,
} from "@/composition/reminders";
import {
  isCompletionLedIntervalScheduleForDate,
  isHabitScheduledForDate,
} from "@/domain/habits/schedule";
import {
  projectDayListSnapshotHabitMutation,
  type DayListSnapshot,
  type HabitListItemViewModel,
} from "@/application/habits/home-day-list-projection";
import {
  closeArchivePeriod,
  isHabitTrackingActiveOnDate,
  startArchivePeriod,
} from "@/domain/habits/archive-periods";
import {
  assignDisplayOrdersAroundArchivedSlots,
  reconcileDisplayOrderRows,
} from "@/domain/habits/display-order";
import {
  clearHabitDescriptionLinesCache,
  publishDeletedHabitDescriptionLines,
} from "@/composition/settings";
import {
  invalidateAllNotesProjections,
  invalidateNotesProjection,
} from "@/composition/notes";
import {
  HabitDeletionTombstoneRegistry,
  getHabitViewModelCacheDomainsForChange,
  transitionCacheSource,
  type HabitViewModelCacheDomain,
  type HabitViewModelChange,
} from "@/stores/habit-cache-policy";
import {
  shouldPublishHabitLoadError,
  type HabitLoadOptions,
} from "@/stores/habit-load-options";
import { canConsumeHabitStoreError } from "@/stores/habit-error-consumption";
import {
  DiscardedHabitWriteError,
  captureHabitReadBarrier,
  getCurrentHabitWriteSequence,
  isHabitWriteProtectedByFence,
  isHabitReadBarrierCurrent,
  waitForHabitPersistenceTurn,
  withPendingHabitWriteTracking,
} from "@/application/habits/habit-write-fence";
let reorderWriteToken = 0;
let latestReorderWriteSequence = 0;
let nextOptimisticHabitId = -1;
let nextHabitErrorRevision = 0;
const pendingOptimisticHabitIds = new Set<number>();
function createHabitErrorUpdate(message: string): {
  error: string;
  errorRevision: number;
} {
  nextHabitErrorRevision += 1;
  return { error: message, errorRevision: nextHabitErrorRevision };
}
const pendingHabitDeletionIds = new Set<number>();
const deletedHabitTombstones = new HabitDeletionTombstoneRegistry();
let nextHabitMutationId = 0;
type MutationRevision = {
  mutationId: number;
  writeSequence: number;
};
const latestHabitMutationIds = new Map<string, MutationRevision>();
let nextDayMutationId = 0;
const latestDayMutationIds = new Map<string, MutationRevision>();
type EpochRequest<T> = {
  epoch: number;
  promise: Promise<T>;
};
let dataCacheEpoch = 0;
let habitsLoadInFlight: EpochRequest<Habit[]> | null = null;
let allDayRecordsLoadInFlight: EpochRequest<DayRecord[]> | null = null;
const dayRecordsWindowLoadInFlight = new Map<
  string,
  Promise<Record<string, DayRecord[]>>
>();
let dayRecordsRequestToken = 0;
let dayRecordReadGeneration = 0;
let hasBootstrappedInitialDayWindow = false;
let allDayRecordsByDateCache: Record<string, DayRecord[]> = {};
const dayRecordOverlays = new Map<string, DayRecord | null>();
const DAY_RECORDS_WINDOW_RADIUS = 1;
const INITIAL_DAY_RECORDS_WINDOW_RADIUS = 7;
const EMPTY_DAY_RECORDS: DayRecord[] = [];
// Keep UI day cache bounded; unbounded object spreads become expensive after many date switches.
const DAY_RECORDS_HOT_CACHE_MAX_DATES = 96;
let dayRecordsHotCacheOrder: string[] = [];
// Keep list snapshots bounded as well; day switch should read prepared models, not rebuild.
const DAY_LIST_SNAPSHOT_CACHE_MAX_DATES = 180;
const SCHEDULED_IDS_CACHE_MAX_DATES = 180;
const HISTORY_PENDING_DAY_LIST_SNAPSHOT: DayListSnapshot = {
  activeItems: [],
  completedItems: [],
  statusByHabitId: new Map<number, DayStatus>(),
};
type DayListSnapshotCacheEntry = {
  snapshot: DayListSnapshot;
  habitsRef: Habit[];
  dayRecordsRef: DayRecord[];
  allDayRecordsRef: DayRecord[];
};
type DayListStabilityCacheEntry = {
  activeCache: Map<number, HabitListItemViewModel>;
  completedCache: Map<number, HabitListItemViewModel>;
};
const dayListSnapshotCache = new Map<string, DayListSnapshotCacheEntry>();
const dayListSnapshotCacheOrder: string[] = [];
const dayListStabilityCache = new Map<string, DayListStabilityCacheEntry>();
let scheduledIdsCacheHabitsRef: Habit[] | null = null;
let scheduledIdsCacheAllDayRecordsRef: DayRecord[] | null = null;
const scheduledIdsByDateCache = new Map<string, number[]>();
const scheduledIdsCacheOrder: string[] = [];
let habitByIdCacheHabitsRef: Habit[] | null = null;
let habitByIdCache = new Map<number, Habit>();
let streakCacheHabitsRef: Habit[] | null = null;
let streakCacheAllRecordsRef: DayRecord[] | null = null;
let streakCacheEvaluationDate: string | null = null;
let streakMapCache = new Map<number, number>();
let recordsByHabitCacheRecordsRef: DayRecord[] | null = null;
let recordsByHabitCache = new Map<number, DayRecord[]>();
let archivedHabitsCacheAllRef: Habit[] | null = null;
let archivedHabitsCache: Habit[] = [];
function invalidatePendingDayRecordReads(): void {
  dayRecordReadGeneration += 1;
  allDayRecordsLoadInFlight = null;
  dayRecordsWindowLoadInFlight.clear();
}
function resetDerivedCaches(): void {
  invalidatePendingDayRecordReads();
  dayRecordsRequestToken += 1;
  hasBootstrappedInitialDayWindow = false;
  allDayRecordsByDateCache = {};
  dayRecordOverlays.clear();
  dayRecordsHotCacheOrder = [];
  invalidateViewModelCachesForChange("reset");
}
function dayRecordOverlayKey(habitId: number, date: string): string {
  return `${habitId}|${date}`;
}
function applyDayRecordOverlays(records: DayRecord[]): DayRecord[] {
  if (dayRecordOverlays.size === 0) return records;
  const byKey = new Map(
    records.map((record) => [
      dayRecordOverlayKey(record.habitId, record.date),
      record,
    ]),
  );
  for (const [key, record] of dayRecordOverlays) {
    if (record == null) {
      byKey.delete(key);
    } else {
      byKey.set(key, record);
    }
  }
  return [...byKey.values()];
}
function applyDayRecordOverlaysForDate(
  records: DayRecord[],
  date: string,
): DayRecord[] {
  if (dayRecordOverlays.size === 0) return records;
  const byHabitId = new Map(records.map((record) => [record.habitId, record]));
  for (const [key, record] of dayRecordOverlays) {
    const separatorIndex = key.indexOf("|");
    if (separatorIndex < 0 || key.slice(separatorIndex + 1) !== date) continue;
    const habitId = Number(key.slice(0, separatorIndex));
    if (!Number.isInteger(habitId)) continue;
    if (record == null) byHabitId.delete(habitId);
    else byHabitId.set(habitId, record);
  }
  return [...byHabitId.values()];
}
function clearDayRecordOverlaysForHabits(habitIds: ReadonlySet<number>): void {
  for (const [key, record] of dayRecordOverlays) {
    const separatorIndex = key.indexOf("|");
    if (separatorIndex < 0) continue;
    const habitId = record?.habitId ?? Number(key.slice(0, separatorIndex));
    if (habitIds.has(habitId)) dayRecordOverlays.delete(key);
  }
}
function invalidateViewModelCaches(
  domains: readonly HabitViewModelCacheDomain[],
): void {
  const invalidated = new Set(domains);
  if (invalidated.has("day-list")) {
    dayListSnapshotCache.clear();
    dayListSnapshotCacheOrder.length = 0;
    dayListStabilityCache.clear();
  }
  if (invalidated.has("scheduled-ids")) {
    scheduledIdsCacheHabitsRef = null;
    scheduledIdsCacheAllDayRecordsRef = null;
    scheduledIdsByDateCache.clear();
    scheduledIdsCacheOrder.length = 0;
  }
  if (invalidated.has("habit-index")) {
    habitByIdCacheHabitsRef = null;
    habitByIdCache = new Map<number, Habit>();
  }
  if (invalidated.has("streaks")) {
    streakCacheHabitsRef = null;
    streakCacheAllRecordsRef = null;
    streakCacheEvaluationDate = null;
    streakMapCache = new Map<number, number>();
  }
  if (invalidated.has("records-by-habit")) {
    recordsByHabitCacheRecordsRef = null;
    recordsByHabitCache = new Map<number, DayRecord[]>();
  }
  if (invalidated.has("archived-habits")) {
    archivedHabitsCacheAllRef = null;
    archivedHabitsCache = [];
  }
}
function invalidateViewModelCachesForChange(
  change: HabitViewModelChange,
): void {
  invalidateViewModelCaches(getHabitViewModelCacheDomainsForChange(change));
}
function transitionHabitViewModelCaches(
  previousHabits: Habit[],
  nextHabits: Habit[],
  change: HabitViewModelChange,
): void {
  const domains = getHabitViewModelCacheDomainsForChange(change);
  const invalidated = new Set(domains);
  scheduledIdsCacheHabitsRef = transitionCacheSource({
    cachedSource: scheduledIdsCacheHabitsRef,
    previousSource: previousHabits,
    nextSource: nextHabits,
    invalidated: invalidated.has("scheduled-ids"),
  });
  streakCacheHabitsRef = transitionCacheSource({
    cachedSource: streakCacheHabitsRef,
    previousSource: previousHabits,
    nextSource: nextHabits,
    invalidated: invalidated.has("streaks"),
  });
  invalidateViewModelCaches(domains);
}
function transitionRecordViewModelCaches(
  previousRecords: DayRecord[],
  nextRecords: DayRecord[],
): void {
  const domains = getHabitViewModelCacheDomainsForChange("records");
  const invalidated = new Set(domains);
  scheduledIdsCacheAllDayRecordsRef = transitionCacheSource({
    cachedSource: scheduledIdsCacheAllDayRecordsRef,
    previousSource: previousRecords,
    nextSource: nextRecords,
    invalidated: invalidated.has("scheduled-ids"),
  });
  streakCacheAllRecordsRef = transitionCacheSource({
    cachedSource: streakCacheAllRecordsRef,
    previousSource: previousRecords,
    nextSource: nextRecords,
    invalidated: invalidated.has("streaks"),
  });
  recordsByHabitCacheRecordsRef = transitionCacheSource({
    cachedSource: recordsByHabitCacheRecordsRef,
    previousSource: previousRecords,
    nextSource: nextRecords,
    invalidated: invalidated.has("records-by-habit"),
  });
  invalidateViewModelCaches(domains);
}
export function getHabitDayRecordsForState(
  state: Pick<HabitStore, "allDayRecords">,
  habitId: number,
): DayRecord[] {
  if (recordsByHabitCacheRecordsRef !== state.allDayRecords) {
    (() => {
      recordsByHabitCacheRecordsRef = state.allDayRecords;
      recordsByHabitCache = new Map<number, DayRecord[]>();
      for (const record of state.allDayRecords) {
        const existing = recordsByHabitCache.get(record.habitId);
        if (existing) existing.push(record);
        else recordsByHabitCache.set(record.habitId, [record]);
      }
    })();
  }
  return recordsByHabitCache.get(habitId) ?? EMPTY_DAY_RECORDS;
}
function advanceRecordsByHabitCacheForDayMutation(
  previousRecords: DayRecord[],
  nextRecords: DayRecord[],
  habitId: number,
  date: string,
  nextRecord: DayRecord | null,
): void {
  if (recordsByHabitCacheRecordsRef !== previousRecords) return;
  const previousHabitRecords =
    recordsByHabitCache.get(habitId) ?? EMPTY_DAY_RECORDS;
  const nextHabitRecords = projectHabitDayRecordsForDate(
    previousHabitRecords,
    date,
    nextRecord,
  );
  const nextCache = new Map(recordsByHabitCache);
  if (nextHabitRecords.length === 0) nextCache.delete(habitId);
  else nextCache.set(habitId, nextHabitRecords);
  recordsByHabitCache = nextCache;
  recordsByHabitCacheRecordsRef = nextRecords;
}
export function getArchivedHabitsForState(
  state: Pick<HabitStore, "allHabits">,
): Habit[] {
  if (archivedHabitsCacheAllRef !== state.allHabits) {
    (() => {
      archivedHabitsCacheAllRef = state.allHabits;
      archivedHabitsCache = state.allHabits
        .filter((habit) => habit.isArchived)
        .sort(
          (left, right) =>
            (right.archivedAt ?? 0) - (left.archivedAt ?? 0) ||
            right.id - left.id,
        );
    })();
  }
  return archivedHabitsCache;
}
function buildDateWindow(centerDate: string, radius: number): string[] {
  const parsed = parseISO(centerDate);
  if (Number.isNaN(parsed.getTime())) return [];
  const safeRadius = Math.max(0, Math.trunc(radius));
  const dates: string[] = [];
  for (let offset = -safeRadius; offset <= safeRadius; offset += 1) {
    dates.push(format(addDays(parsed, offset), "yyyy-MM-dd"));
  }
  return dates;
}
function collectScheduledHabitIds(
  habitsList: Habit[],
  allRecords: DayRecord[],
  selectedDate: string,
): number[] {
  const scheduled: number[] = [];
  for (const habit of habitsList) {
    if (!isHabitTrackingActiveOnDate(habit, selectedDate)) continue;
    if (
      isHabitScheduledForDate(
        habit.repeatSchedule,
        habit.startDate,
        selectedDate,
        getHabitDayRecordsForState({ allDayRecords: allRecords }, habit.id),
        habit.scheduleHistory,
      )
    ) {
      scheduled.push(habit.id);
    }
  }
  return scheduled;
}
function ensureScheduledHabitIds(
  habitsList: Habit[],
  allRecords: DayRecord[],
  date: string,
): number[] {
  if (
    scheduledIdsCacheHabitsRef !== habitsList ||
    scheduledIdsCacheAllDayRecordsRef !== allRecords
  ) {
    scheduledIdsCacheHabitsRef = habitsList;
    scheduledIdsCacheAllDayRecordsRef = allRecords;
    scheduledIdsByDateCache.clear();
    scheduledIdsCacheOrder.length = 0;
  }
  const cached = scheduledIdsByDateCache.get(date);
  if (cached) {
    touchScheduledIdsDate(date);
    return cached;
  }
  const computed = (() =>
    collectScheduledHabitIds(habitsList, allRecords, date))();
  scheduledIdsByDateCache.set(date, computed);
  touchScheduledIdsDate(date);
  return computed;
}
function touchScheduledIdsDate(date: string): void {
  const existingIndex = scheduledIdsCacheOrder.indexOf(date);
  if (existingIndex >= 0) scheduledIdsCacheOrder.splice(existingIndex, 1);
  scheduledIdsCacheOrder.push(date);
  while (scheduledIdsCacheOrder.length > SCHEDULED_IDS_CACHE_MAX_DATES) {
    const evicted = scheduledIdsCacheOrder.shift();
    if (evicted == null) break;
    scheduledIdsByDateCache.delete(evicted);
  }
}
function advanceScheduledIdsCacheForHabit(
  habitsList: Habit[],
  previousRecords: DayRecord[],
  nextRecords: DayRecord[],
  habitId: number,
  nextHabitRecords: DayRecord[],
): void {
  if (
    scheduledIdsCacheHabitsRef !== habitsList ||
    scheduledIdsCacheAllDayRecordsRef !== previousRecords
  ) {
    return;
  }
  const habit = ensureHabitByIdMap(habitsList).get(habitId);
  if (!habit) return;
  const scheduleCanMoveAfterRecordChange = [
    habit.repeatSchedule,
    ...(habit.scheduleHistory ?? []).map((entry) => entry.repeatSchedule),
  ].some(
    (schedule) =>
      schedule.type === "interval" && schedule.fromCompletion === true,
  );
  if (!scheduleCanMoveAfterRecordChange) {
    // Fixed schedules do not depend on completion records. Preserve every
    // cached date and only advance the record-array identity used by the cache.
    scheduledIdsCacheHabitsRef = habitsList;
    scheduledIdsCacheAllDayRecordsRef = nextRecords;
    return;
  }
  for (const [date, cachedIds] of scheduledIdsByDateCache) {
    const wasScheduled = cachedIds.includes(habitId);
    const isScheduled =
      isHabitTrackingActiveOnDate(habit, date) &&
      isHabitScheduledForDate(
        habit.repeatSchedule,
        habit.startDate,
        date,
        nextHabitRecords,
        habit.scheduleHistory,
      );
    if (wasScheduled === isScheduled) continue;
    const nextIds = new Set(cachedIds);
    if (isScheduled) {
      nextIds.add(habitId);
    } else {
      nextIds.delete(habitId);
    }
    scheduledIdsByDateCache.set(
      date,
      habitsList
        .map((candidate) => candidate.id)
        .filter((id) => nextIds.has(id)),
    );
  }
  scheduledIdsCacheHabitsRef = habitsList;
  scheduledIdsCacheAllDayRecordsRef = nextRecords;
}
function ensureHabitByIdMap(habitsList: Habit[]): Map<number, Habit> {
  if (habitByIdCacheHabitsRef === habitsList) {
    return habitByIdCache;
  }
  (() => {
    habitByIdCacheHabitsRef = habitsList;
    habitByIdCache = new Map<number, Habit>();
    for (const habit of habitsList) {
      habitByIdCache.set(habit.id, habit);
    }
  })();
  return habitByIdCache;
}
function ensureStreakMap(
  habitsList: Habit[],
  allRecords: DayRecord[],
): Map<number, number> {
  const evaluationDate = format(new Date(), "yyyy-MM-dd");
  if (
    streakCacheHabitsRef === habitsList &&
    streakCacheAllRecordsRef === allRecords &&
    streakCacheEvaluationDate === evaluationDate
  ) {
    return streakMapCache;
  }
  streakCacheHabitsRef = habitsList;
  streakCacheAllRecordsRef = allRecords;
  streakCacheEvaluationDate = evaluationDate;
  const nextMap = (() => {
    const result = new Map<number, number>();
    for (const habit of habitsList) {
      const current = calculateCurrentStreak(
        getHabitDayRecordsForState({ allDayRecords: allRecords }, habit.id),
        habit.repeatSchedule,
        habit.startDate,
        habit.archiveHistory,
        habit.scheduleHistory,
        evaluationDate,
      );
      result.set(habit.id, current);
    }
    return result;
  })();
  streakMapCache = nextMap;
  return streakMapCache;
}
function advanceStreakCacheForHabit(
  habitsList: Habit[],
  previousRecords: DayRecord[],
  nextRecords: DayRecord[],
  habitId: number,
  nextHabitRecords: DayRecord[],
): void {
  // Only advance an already-valid cache. Building a missing cache inside a tap
  // would make the user's action slower than the existing lazy path.
  const evaluationDate = format(new Date(), "yyyy-MM-dd");
  if (
    streakCacheHabitsRef !== habitsList ||
    streakCacheAllRecordsRef !== previousRecords ||
    streakCacheEvaluationDate !== evaluationDate
  ) {
    return;
  }
  const habit = ensureHabitByIdMap(habitsList).get(habitId);
  if (!habit) return;
  const nextMap = new Map(streakMapCache);
  const current = calculateCurrentStreak(
    nextHabitRecords,
    habit.repeatSchedule,
    habit.startDate,
    habit.archiveHistory,
    habit.scheduleHistory,
    evaluationDate,
  );
  nextMap.set(habitId, current);
  streakCacheHabitsRef = habitsList;
  streakCacheAllRecordsRef = nextRecords;
  streakMapCache = nextMap;
}
function advanceDayListSnapshotCacheForDayMutation(params: {
  habits: Habit[];
  previousAllRecords: DayRecord[];
  nextAllRecords: DayRecord[];
  habitId: number;
  changedDate: string;
  changedDateRecords: DayRecord[];
}): void {
  const {
    habits,
    previousAllRecords,
    nextAllRecords,
    habitId,
    changedDate,
    changedDateRecords,
  } = params;
  const habit = ensureHabitByIdMap(habits).get(habitId);
  if (!habit) return;
  if (
    scheduledIdsCacheHabitsRef !== habits ||
    scheduledIdsCacheAllDayRecordsRef !== nextAllRecords ||
    streakCacheHabitsRef !== habits ||
    streakCacheAllRecordsRef !== nextAllRecords ||
    streakCacheEvaluationDate !== format(new Date(), "yyyy-MM-dd")
  ) {
    return;
  }
  const currentStreak = streakMapCache.get(habitId) ?? 0;
  for (const [cacheKey, entry] of dayListSnapshotCache) {
    if (
      entry.habitsRef !== habits ||
      entry.allDayRecordsRef !== previousAllRecords
    ) {
      continue;
    }
    const separator = cacheKey.lastIndexOf("|");
    if (separator < 0) continue;
    const date = cacheKey.slice(0, separator);
    const scheduledHabitIds = scheduledIdsByDateCache.get(date);
    if (!scheduledHabitIds) {
      dayListSnapshotCache.delete(cacheKey);
      dayListStabilityCache.delete(cacheKey);
      const orderIndex = dayListSnapshotCacheOrder.indexOf(cacheKey);
      if (orderIndex >= 0) dayListSnapshotCacheOrder.splice(orderIndex, 1);
      continue;
    }
    const dateRecords =
      date === changedDate ? changedDateRecords : entry.dayRecordsRef;
    const record =
      dateRecords.find((candidate) => candidate.habitId === habitId) ?? null;
    const snapshot = projectDayListSnapshotHabitMutation({
      snapshot: entry.snapshot,
      scheduledHabitIds,
      habit,
      record,
      isPast: cacheKey.slice(separator + 1) === "1",
      currentStreak,
    });
    dayListSnapshotCache.set(cacheKey, {
      snapshot,
      habitsRef: habits,
      dayRecordsRef: dateRecords,
      allDayRecordsRef: nextAllRecords,
    });
    const stabilityEntry = dayListStabilityCache.get(cacheKey);
    if (!stabilityEntry) continue;
    const activeCache = new Map(stabilityEntry.activeCache);
    const completedCache = new Map(stabilityEntry.completedCache);
    activeCache.delete(habitId);
    completedCache.delete(habitId);
    const activeItem = snapshot.activeItems.find(
      (item) => item.habit.id === habitId,
    );
    const completedItem = snapshot.completedItems.find(
      (item) => item.habit.id === habitId,
    );
    if (activeItem) activeCache.set(habitId, activeItem);
    if (completedItem) completedCache.set(habitId, completedItem);
    dayListStabilityCache.set(cacheKey, { activeCache, completedCache });
  }
}
function areViewModelsEqual(
  prev: HabitListItemViewModel,
  next: HabitListItemViewModel,
): boolean {
  return (
    prev.habit === next.habit &&
    prev.section === next.section &&
    prev.stableKey === next.stableKey &&
    prev.checkboxState === next.checkboxState &&
    prev.currentStreak === next.currentStreak &&
    prev.completedAt === next.completedAt
  );
}
function stabilizeViewModels(
  nextItems: HabitListItemViewModel[],
  prevCache: Map<number, HabitListItemViewModel>,
): {
  stableItems: HabitListItemViewModel[];
  nextCache: Map<number, HabitListItemViewModel>;
} {
  const nextCache = new Map<number, HabitListItemViewModel>();
  const stableItems = nextItems.map((item) => {
    const prev = prevCache.get(item.habit.id);
    if (prev && areViewModelsEqual(prev, item)) {
      nextCache.set(item.habit.id, prev);
      return prev;
    }
    nextCache.set(item.habit.id, item);
    return item;
  });
  return { stableItems, nextCache };
}
function touchDayListSnapshotKey(cacheKey: string): void {
  const existingIndex = dayListSnapshotCacheOrder.indexOf(cacheKey);
  if (existingIndex >= 0) {
    dayListSnapshotCacheOrder.splice(existingIndex, 1);
  }
  dayListSnapshotCacheOrder.push(cacheKey);
  while (dayListSnapshotCacheOrder.length > DAY_LIST_SNAPSHOT_CACHE_MAX_DATES) {
    const evicted = dayListSnapshotCacheOrder.shift();
    if (!evicted) break;
    dayListSnapshotCache.delete(evicted);
    dayListStabilityCache.delete(evicted);
  }
}
function mergeHotDayRecordsByDate(params: {
  prevMap: Record<string, DayRecord[]>;
  updates: Record<string, DayRecord[]>;
  pinnedDates?: (string | null | undefined)[];
}): Record<string, DayRecord[]> {
  const { prevMap, updates, pinnedDates = [] } = params;
  const nextMap: Record<string, DayRecord[]> = { ...prevMap, ...updates };
  const nextDates = Object.keys(nextMap);
  const nextDateSet = new Set(nextDates);
  if (dayRecordsHotCacheOrder.length === 0) {
    dayRecordsHotCacheOrder = [...nextDates];
  } else {
    dayRecordsHotCacheOrder = dayRecordsHotCacheOrder.filter((date) =>
      nextDateSet.has(date),
    );
    for (const date of nextDates) {
      if (!dayRecordsHotCacheOrder.includes(date)) {
        dayRecordsHotCacheOrder.push(date);
      }
    }
  }
  for (const date of Object.keys(updates)) {
    dayRecordsHotCacheOrder = dayRecordsHotCacheOrder.filter((d) => d !== date);
    dayRecordsHotCacheOrder.push(date);
  }
  const pinned = new Set(
    pinnedDates.filter((date): date is string => typeof date === "string"),
  );
  for (const date of pinned) {
    if (!Object.prototype.hasOwnProperty.call(nextMap, date)) continue;
    dayRecordsHotCacheOrder = dayRecordsHotCacheOrder.filter((d) => d !== date);
    dayRecordsHotCacheOrder.push(date);
  }
  while (dayRecordsHotCacheOrder.length > DAY_RECORDS_HOT_CACHE_MAX_DATES) {
    const evictIndex = dayRecordsHotCacheOrder.findIndex(
      (date) => !pinned.has(date),
    );
    if (evictIndex < 0) break;
    const [evicted] = dayRecordsHotCacheOrder.splice(evictIndex, 1);
    delete nextMap[evicted];
  }
  return nextMap;
}
function beginDayMutation(
  habitId: number,
  date: string,
  writeSequence = getCurrentHabitWriteSequence(),
): {
  key: string;
  mutationId: number;
  writeSequence: number;
} {
  const key = dayRecordOverlayKey(habitId, date);
  const mutationId = ++nextDayMutationId;
  latestDayMutationIds.set(key, { mutationId, writeSequence });
  return { key, mutationId, writeSequence };
}
function isLatestDayMutation(key: string, mutationId: number): boolean {
  return latestDayMutationIds.get(key)?.mutationId === mutationId;
}
function finishDayMutation(key: string, mutationId: number): void {
  if (isLatestDayMutation(key, mutationId)) {
    latestDayMutationIds.delete(key);
  }
}
function shouldPersistDayMutation(
  key: string,
  mutationId: number,
  writeSequence: number,
): boolean {
  return (
    isLatestDayMutation(key, mutationId) ||
    isHabitWriteProtectedByFence(
      writeSequence,
      latestDayMutationIds.get(key)?.writeSequence ?? null,
    )
  );
}
type HabitMutationScope =
  | "existence"
  | "name"
  | "description"
  | "description-visible"
  | "reminder-enabled"
  | "reminder-time"
  | "schedule"
  | "lifecycle"
  | "metadata";
const ALL_HABIT_MUTATION_SCOPES: HabitMutationScope[] = [
  "existence",
  "name",
  "description",
  "description-visible",
  "reminder-enabled",
  "reminder-time",
  "schedule",
  "lifecycle",
  "metadata",
];
type HabitMutationOwnership = {
  habitId: number;
  mutationId: number;
  scopes: HabitMutationScope[];
  writeSequence: number;
};
function habitMutationKey(habitId: number, scope: HabitMutationScope): string {
  return `${habitId}|${scope}`;
}
function beginHabitMutation(
  habitId: number,
  scopes: HabitMutationScope[],
): HabitMutationOwnership {
  const mutationId = ++nextHabitMutationId;
  const uniqueScopes = [...new Set(scopes)];
  const writeSequence = getCurrentHabitWriteSequence();
  for (const scope of uniqueScopes) {
    latestHabitMutationIds.set(habitMutationKey(habitId, scope), {
      mutationId,
      writeSequence,
    });
  }
  return {
    habitId,
    mutationId,
    scopes: uniqueScopes,
    writeSequence,
  };
}
function isLatestHabitMutation(
  ownership: HabitMutationOwnership,
  scope?: HabitMutationScope,
): boolean {
  const scopes = scope ? [scope] : ownership.scopes;
  return scopes.every(
    (candidate) =>
      latestHabitMutationIds.get(habitMutationKey(ownership.habitId, candidate))
        ?.mutationId === ownership.mutationId,
  );
}
function finishHabitMutation(ownership: HabitMutationOwnership): void {
  for (const scope of ownership.scopes) {
    const key = habitMutationKey(ownership.habitId, scope);
    if (latestHabitMutationIds.get(key)?.mutationId === ownership.mutationId) {
      latestHabitMutationIds.delete(key);
    }
  }
}
function shouldPersistHabitMutation(
  ownership: HabitMutationOwnership,
  scope?: HabitMutationScope,
): boolean {
  return (
    isLatestHabitMutation(ownership, scope) ||
    (scope != null
      ? isHabitWriteProtectedByFence(
          ownership.writeSequence,
          latestHabitMutationIds.get(habitMutationKey(ownership.habitId, scope))
            ?.writeSequence ?? null,
        )
      : ownership.scopes.every((candidate) =>
          isHabitWriteProtectedByFence(
            ownership.writeSequence,
            latestHabitMutationIds.get(
              habitMutationKey(ownership.habitId, candidate),
            )?.writeSequence ?? null,
          ),
        ))
  );
}
function hasHabitField<K extends keyof Habit>(
  values: Partial<Habit>,
  field: K,
): values is Partial<Habit> & Pick<Habit, K> {
  return Object.prototype.hasOwnProperty.call(values, field);
}
function applyOwnedHabitFields(
  habit: Habit,
  ownership: HabitMutationOwnership,
  values: Partial<Habit>,
): Habit {
  if (habit.id !== ownership.habitId) return habit;
  let next = habit;
  const ensureCopy = () => {
    if (next === habit) next = { ...habit };
  };
  if (
    hasHabitField(values, "name") &&
    isLatestHabitMutation(ownership, "name")
  ) {
    ensureCopy();
    next.name = values.name;
  }
  if (
    hasHabitField(values, "description") &&
    isLatestHabitMutation(ownership, "description")
  ) {
    ensureCopy();
    next.description = values.description;
  }
  if (
    hasHabitField(values, "descriptionVisible") &&
    isLatestHabitMutation(ownership, "description-visible")
  ) {
    ensureCopy();
    next.descriptionVisible = values.descriptionVisible;
  }
  if (
    hasHabitField(values, "reminderEnabled") &&
    isLatestHabitMutation(ownership, "reminder-enabled")
  ) {
    ensureCopy();
    next.reminderEnabled = values.reminderEnabled;
  }
  if (
    hasHabitField(values, "reminderTime") &&
    isLatestHabitMutation(ownership, "reminder-time")
  ) {
    ensureCopy();
    next.reminderTime = values.reminderTime;
  }
  if (isLatestHabitMutation(ownership, "schedule")) {
    if (hasHabitField(values, "repeatSchedule")) {
      ensureCopy();
      next.repeatSchedule = values.repeatSchedule;
    }
    if (hasHabitField(values, "scheduleHistory")) {
      ensureCopy();
      next.scheduleHistory = values.scheduleHistory;
    }
    if (hasHabitField(values, "startDate")) {
      ensureCopy();
      next.startDate = values.startDate;
    }
  }
  if (isLatestHabitMutation(ownership, "lifecycle")) {
    if (hasHabitField(values, "isArchived")) {
      ensureCopy();
      next.isArchived = values.isArchived;
    }
    if (hasHabitField(values, "archivedAt")) {
      ensureCopy();
      next.archivedAt = values.archivedAt;
    }
    if (hasHabitField(values, "archiveHistory")) {
      ensureCopy();
      next.archiveHistory = values.archiveHistory;
    }
  }
  if (
    hasHabitField(values, "updatedAt") &&
    isLatestHabitMutation(ownership, "metadata")
  ) {
    ensureCopy();
    next.updatedAt = values.updatedAt;
  }
  return next;
}
function areScheduleHistoriesEqual(
  left: Habit["scheduleHistory"],
  right: Habit["scheduleHistory"],
): boolean {
  if (left === right) return true;
  const leftEntries = left ?? [];
  const rightEntries = right ?? [];
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every((entry, index) => {
      const other = rightEntries[index];
      return (
        other != null &&
        entry.effectiveFrom === other.effectiveFrom &&
        entry.startDate === other.startDate &&
        areRepeatSchedulesEqual(entry.repeatSchedule, other.repeatSchedule)
      );
    })
  );
}
function areArchiveHistoriesEqual(
  left: Habit["archiveHistory"],
  right: Habit["archiveHistory"],
): boolean {
  if (left === right) return true;
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other != null &&
        entry.archivedAt === other.archivedAt &&
        entry.restoredAt === other.restoredAt &&
        entry.archivedDate === other.archivedDate &&
        entry.restoredDate === other.restoredDate
      );
    })
  );
}
function areHabitsSemanticallyEqual(left: Habit, right: Habit): boolean {
  return (
    left === right ||
    (left.id === right.id &&
      left.name === right.name &&
      left.description === right.description &&
      left.descriptionVisible === right.descriptionVisible &&
      areRepeatSchedulesEqual(left.repeatSchedule, right.repeatSchedule) &&
      areScheduleHistoriesEqual(left.scheduleHistory, right.scheduleHistory) &&
      left.startDate === right.startDate &&
      left.reminderEnabled === right.reminderEnabled &&
      left.reminderTime === right.reminderTime &&
      left.displayOrder === right.displayOrder &&
      left.isArchived === right.isArchived &&
      left.archivedAt === right.archivedAt &&
      areArchiveHistoriesEqual(left.archiveHistory, right.archiveHistory) &&
      left.createdAt === right.createdAt &&
      left.updatedAt === right.updatedAt)
  );
}
function upsertSortedHabit(collection: Habit[], habit: Habit): Habit[] {
  const index = collection.findIndex((candidate) => candidate.id === habit.id);
  if (index < 0) {
    return [...collection, habit].sort(
      (left, right) =>
        left.displayOrder - right.displayOrder || left.id - right.id,
    );
  }
  const current = collection[index];
  if (areHabitsSemanticallyEqual(current, habit)) return collection;
  const next = collection.slice();
  next[index] = habit;
  if (current.displayOrder !== habit.displayOrder) {
    next.sort(
      (left, right) =>
        left.displayOrder - right.displayOrder || left.id - right.id,
    );
  }
  return next;
}
function removeHabitFromCollection(collection: Habit[], id: number): Habit[] {
  const index = collection.findIndex((habit) => habit.id === id);
  if (index < 0) return collection;
  return [...collection.slice(0, index), ...collection.slice(index + 1)];
}
function upsertHabitInCollections(
  activeHabits: Habit[],
  allHabits: Habit[],
  habit: Habit,
): {
  habits: Habit[];
  allHabits: Habit[];
} {
  return {
    habits: habit.isArchived
      ? removeHabitFromCollection(activeHabits, habit.id)
      : upsertSortedHabit(activeHabits, habit),
    allHabits: upsertSortedHabit(allHabits, habit),
  };
}
function getUpdateHabitMutationScopes(
  input: Partial<UpdateHabitInput>,
  changesSchedule: boolean,
): HabitMutationScope[] {
  const scopes: HabitMutationScope[] = ["metadata"];
  if (input.description !== undefined) scopes.push("description");
  if (input.descriptionVisible !== undefined) {
    scopes.push("description-visible");
  }
  if (input.reminderEnabled !== undefined) scopes.push("reminder-enabled");
  if (input.reminderTime !== undefined) scopes.push("reminder-time");
  if (changesSchedule) scopes.push("schedule");
  return scopes;
}
function queryAllHabitModels(): Promise<Habit[]> {
  const epoch = dataCacheEpoch;
  if (habitsLoadInFlight?.epoch === epoch) return habitsLoadInFlight.promise;
  const promise = habitPersistence.readAllHabits();
  habitsLoadInFlight = { epoch, promise };
  void promise.then(
    () => {
      if (habitsLoadInFlight?.promise === promise) habitsLoadInFlight = null;
    },
    () => {
      if (habitsLoadInFlight?.promise === promise) habitsLoadInFlight = null;
    },
  );
  return promise;
}
async function queryHabitModelById(habitId: number): Promise<Habit | null> {
  return habitPersistence.readHabit(habitId);
}
async function queryHabitDayRecordModels(
  habitId: number,
): Promise<DayRecord[]> {
  return habitPersistence.readDayRecordsForHabitOrderedByDate(habitId);
}
function replaceHabitRecordsForDate(
  records: DayRecord[],
  habitId: number,
  date: string,
  authoritativeByDate: ReadonlyMap<string, DayRecord>,
): DayRecord[] {
  const next = records.filter((record) => record.habitId !== habitId);
  const authoritative = authoritativeByDate.get(date);
  if (authoritative) next.push(authoritative);
  return applyDayRecordOverlaysForDate(next, date);
}
function replaceAllHabitRecords(
  records: DayRecord[],
  habitId: number,
  authoritativeRecords: DayRecord[],
): DayRecord[] {
  return applyDayRecordOverlays([
    ...records.filter((record) => record.habitId !== habitId),
    ...authoritativeRecords,
  ]);
}
function queryAllDayRecordModels(): Promise<DayRecord[]> {
  const epoch = dataCacheEpoch;
  if (allDayRecordsLoadInFlight?.epoch === epoch) {
    return allDayRecordsLoadInFlight.promise;
  }
  const promise = habitPersistence.readAllDayRecords();
  allDayRecordsLoadInFlight = { epoch, promise };
  void promise.then(
    () => {
      if (allDayRecordsLoadInFlight?.promise === promise) {
        allDayRecordsLoadInFlight = null;
      }
    },
    () => {
      if (allDayRecordsLoadInFlight?.promise === promise) {
        allDayRecordsLoadInFlight = null;
      }
    },
  );
  return promise;
}
function resolveDayRecordsForDate(
  state: Pick<
    HabitStore,
    "dayRecordsByDate" | "currentDayRecordsDate" | "dayRecords"
  >,
  date: string,
): DayRecord[] {
  if (Object.prototype.hasOwnProperty.call(state.dayRecordsByDate, date)) {
    return state.dayRecordsByDate[date] ?? EMPTY_DAY_RECORDS;
  }
  if (state.currentDayRecordsDate === date) {
    return state.dayRecords;
  }
  return allDayRecordsByDateCache[date] ?? EMPTY_DAY_RECORDS;
}
export function getDayListSnapshotForState(
  state: Pick<
    HabitStore,
    | "habits"
    | "allDayRecords"
    | "allDayRecordsLoaded"
    | "dayRecordsByDate"
    | "currentDayRecordsDate"
    | "dayRecords"
  >,
  date: string,
  isPast: boolean,
): DayListSnapshot {
  const workDetails = {
    habitCount: state.habits.length,
    recordCount: state.allDayRecords.length,
    currentRecordCount: state.dayRecords.length,
    snapshotCount: dayListSnapshotCache.size,
    recordsLoaded: state.allDayRecordsLoaded,
    cacheHit: false,
  };
  return (() => {
    // Streaks and completion-led interval schedules both require authoritative
    // history. Never publish a plausible-looking partial list while the full
    // record set is still loading.
    if (!state.allDayRecordsLoaded) {
      return HISTORY_PENDING_DAY_LIST_SNAPSHOT;
    }
    const cacheKey = `${date}|${isPast ? 1 : 0}`;
    const dayRecordsForDate = resolveDayRecordsForDate(state, date);
    const cached = dayListSnapshotCache.get(cacheKey);
    if (
      cached &&
      cached.habitsRef === state.habits &&
      cached.dayRecordsRef === dayRecordsForDate &&
      cached.allDayRecordsRef === state.allDayRecords
    ) {
      workDetails.cacheHit = true;
      touchDayListSnapshotKey(cacheKey);
      return cached.snapshot;
    }
    const scheduledHabitIds = ensureScheduledHabitIds(
      state.habits,
      state.allDayRecords,
      date,
    );
    const scheduledHabitIdSet = new Set(scheduledHabitIds);
    const habitById = ensureHabitByIdMap(state.habits);
    const streakMap = ensureStreakMap(state.habits, state.allDayRecords);
    const recordByHabit = new Map<number, DayRecord>();
    for (const record of dayRecordsForDate) {
      if (!scheduledHabitIdSet.has(record.habitId)) continue;
      if (!habitById.has(record.habitId)) continue;
      recordByHabit.set(record.habitId, record);
    }
    const statusByHabitId = new Map<number, DayStatus>();
    for (const [habitId, record] of recordByHabit) {
      statusByHabitId.set(habitId, record.status);
    }
    const activeItemsRaw: HabitListItemViewModel[] = [];
    for (const habitId of scheduledHabitIds) {
      if (recordByHabit.has(habitId)) continue;
      const habit = habitById.get(habitId);
      if (!habit) continue;
      activeItemsRaw.push({
        habit,
        section: "active",
        stableKey: `active:${habit.id}`,
        checkboxState: isPast ? "unmarkedPast" : "unmarked",
        currentStreak: streakMap.get(habit.id) ?? 0,
        completedAt: null,
      });
    }
    const completedItemsRaw: HabitListItemViewModel[] = [];
    for (const [habitId, record] of recordByHabit) {
      if (!scheduledHabitIdSet.has(habitId)) continue;
      const habit = habitById.get(habitId);
      if (!habit) continue;
      completedItemsRaw.push({
        habit,
        section: "completed",
        stableKey: `completed:${habit.id}`,
        checkboxState: record.status,
        currentStreak: streakMap.get(habit.id) ?? 0,
        completedAt: record.createdAt,
      });
    }
    completedItemsRaw.sort((a, b) => {
      const aCompletedAt = a.completedAt ?? Number.MAX_SAFE_INTEGER;
      const bCompletedAt = b.completedAt ?? Number.MAX_SAFE_INTEGER;
      if (aCompletedAt !== bCompletedAt) {
        return aCompletedAt - bCompletedAt;
      }
      return a.habit.id - b.habit.id;
    });
    const stabilityEntry = dayListStabilityCache.get(cacheKey) ?? {
      activeCache: new Map<number, HabitListItemViewModel>(),
      completedCache: new Map<number, HabitListItemViewModel>(),
    };
    const activeStabilized = stabilizeViewModels(
      activeItemsRaw,
      stabilityEntry.activeCache,
    );
    const completedStabilized = stabilizeViewModels(
      completedItemsRaw,
      stabilityEntry.completedCache,
    );
    dayListStabilityCache.set(cacheKey, {
      activeCache: activeStabilized.nextCache,
      completedCache: completedStabilized.nextCache,
    });
    const snapshot: DayListSnapshot = {
      activeItems: activeStabilized.stableItems,
      completedItems: completedStabilized.stableItems,
      statusByHabitId,
    };
    dayListSnapshotCache.set(cacheKey, {
      snapshot,
      habitsRef: state.habits,
      dayRecordsRef: dayRecordsForDate,
      allDayRecordsRef: state.allDayRecords,
    });
    touchDayListSnapshotKey(cacheKey);
    return snapshot;
  })();
}
export function hasDayListSnapshotForState(
  state: Pick<
    HabitStore,
    | "habits"
    | "allDayRecords"
    | "allDayRecordsLoaded"
    | "dayRecordsByDate"
    | "currentDayRecordsDate"
    | "dayRecords"
  >,
  date: string,
  isPast: boolean,
): boolean {
  if (!state.allDayRecordsLoaded) return false;
  const cacheKey = `${date}|${isPast ? 1 : 0}`;
  const cached = dayListSnapshotCache.get(cacheKey);
  if (!cached) return false;
  const dayRecordsForDate = resolveDayRecordsForDate(state, date);
  return (
    cached.habitsRef === state.habits &&
    cached.dayRecordsRef === dayRecordsForDate &&
    cached.allDayRecordsRef === state.allDayRecords
  );
}
interface HabitStore {
  habits: Habit[];
  allHabits: Habit[];
  allHabitsLoaded: boolean;
  dayRecords: DayRecord[];
  currentDayRecordsDate: string | null;
  dayRecordsByDate: Record<string, DayRecord[]>;
  allDayRecords: DayRecord[];
  allDayRecordsLoaded: boolean;
  isLoading: boolean;
  error: string | null;
  errorRevision: number;
  loadHabits(options?: HabitLoadOptions): Promise<boolean>;
  loadDayRecords(date: string, options?: HabitLoadOptions): Promise<boolean>;
  preloadDayRecords(date: string): Promise<boolean>;
  preloadDayRecordsWindow(
    centerDate: string,
    radius?: number,
  ): Promise<boolean>;
  getDayListSnapshot(date: string, isPast: boolean): DayListSnapshot;
  preloadDayListSnapshotsWindow(centerDate: string, radius?: number): void;
  loadAllDayRecords(options?: HabitLoadOptions): Promise<boolean>;
  createHabit(input: CreateHabitInput): Promise<Habit>;
  updateHabit(id: number, input: Partial<UpdateHabitInput>): Promise<void>;
  renameHabit(id: number, name: string): Promise<void>;
  reorderHabits(orderedIds: number[]): Promise<void>;
  archiveHabit(id: number): Promise<void>;
  restoreHabit(id: number): Promise<void>;
  restoreHabits(ids: number[]): Promise<void>;
  deleteHabit(id: number): Promise<void>;
  deleteHabits(ids: number[]): Promise<void>;
  markDay(
    habitId: number,
    date: string,
    status: DayStatus,
    reason?: string,
  ): Promise<boolean>;
  unmarkDay(habitId: number, date: string): Promise<boolean>;
  resetInMemoryCaches(): void;
  refreshComputedData(): void;
  clearError(expectedRevision?: number): boolean;
}
async function repairFailedDayMutation(
  habitId: number,
  date: string,
  key: string,
  mutationId: number,
): Promise<boolean> {
  const epoch = dataCacheEpoch;
  const isCurrent = () =>
    epoch === dataCacheEpoch &&
    isLatestDayMutation(key, mutationId) &&
    !pendingHabitDeletionIds.has(habitId) &&
    !deletedHabitTombstones.has(habitId);
  if (!isCurrent()) {
    return false;
  }
  // Reads started before reconciliation must not join a newer request or
  // publish their snapshot after the failed mutation loses its overlay.
  invalidatePendingDayRecordReads();
  const releaseTombstoneRead = deletedHabitTombstones.beginRead();
  try {
    const persisted = await habitPersistence.readDayRecordsInDateRange(
      date,
      date,
    );
    if (!isCurrent()) {
      return false;
    }
    // Also fence reads started while the authoritative SELECT was pending.
    invalidatePendingDayRecordReads();
    const record = persisted.find(
      (entry) => entry.habitId === habitId && entry.date === date,
    );
    (() =>
      useHabitStore.setState((state) => {
        const currentDateRecords = resolveDayRecordsForDate(state, date);
        const nextDateRecords = replaceHabitRecordsForDate(
          currentDateRecords,
          habitId,
          date,
          new Map(record ? [[date, record]] : []),
        );
        const nextAll = state.allDayRecords.filter(
          (entry) => entry.habitId !== habitId || entry.date !== date,
        );
        if (record) nextAll.push(record);
        transitionRecordViewModelCaches(state.allDayRecords, nextAll);
        allDayRecordsByDateCache[date] = nextDateRecords;
        return {
          allDayRecords: nextAll,
          dayRecordsByDate: mergeHotDayRecordsByDate({
            prevMap: state.dayRecordsByDate,
            updates: { [date]: nextDateRecords },
            pinnedDates: [state.currentDayRecordsDate, date],
          }),
          dayRecords:
            state.currentDayRecordsDate === date
              ? nextDateRecords
              : state.dayRecords,
        };
      }))();
    return true;
  } catch {
    if (!isCurrent()) return false;
    invalidatePendingDayRecordReads();
    // A second storage failure leaves no authoritative row to display. Revoke
    // history readiness so existing loading/error owners can retry safely.
    (() =>
      useHabitStore.setState((state) => {
        const nextByDate = { ...state.dayRecordsByDate };
        delete nextByDate[date];
        delete allDayRecordsByDateCache[date];
        invalidateViewModelCachesForChange("records");
        return {
          allDayRecords: state.allDayRecords.filter(
            (entry) => entry.habitId !== habitId || entry.date !== date,
          ),
          allDayRecordsLoaded: false,
          dayRecordsByDate: nextByDate,
          dayRecords:
            state.currentDayRecordsDate === date
              ? state.dayRecords.filter((entry) => entry.habitId !== habitId)
              : state.dayRecords,
        };
      }))();
    return true;
  } finally {
    releaseTombstoneRead();
  }
}
async function readAndPublishCurrentDayRecords<T>(
  epoch: number,
  read: () => Promise<T>,
  publish: (result: T) => void,
): Promise<boolean> {
  for (;;) {
    if (epoch !== dataCacheEpoch) {
      return false;
    }
    const generation = dayRecordReadGeneration;
    let result: T;
    try {
      result = await read();
    } catch (error) {
      if (epoch !== dataCacheEpoch) {
        return false;
      }
      if (generation === dayRecordReadGeneration) {
        throw error;
      }
      continue;
    }
    if (epoch !== dataCacheEpoch) {
      return false;
    }
    // Snapshot invalidation is not an I/O failure. Retry with the current
    // coalescer without revoking a foreground date request's ownership.
    if (generation !== dayRecordReadGeneration) {
      continue;
    }
    // Guard and publication share one synchronous turn. Returning the data
    // across another await would reopen the stale-result race.
    publish(result);
    return true;
  }
}

async function readAndPublishCurrentHabits(
  epoch: number,
  committedImport: boolean,
  publish: (habits: Habit[]) => void,
): Promise<boolean> {
  for (;;) {
    if (epoch !== dataCacheEpoch) return false;
    const barrier =
      committedImport ? null : captureHabitReadBarrier();
    if (barrier) {
      await barrier.settled;
      if (epoch !== dataCacheEpoch) return false;
      if (!isHabitReadBarrierCurrent(barrier)) continue;
    }
    let habits: Habit[];
    try {
      habits = await queryAllHabitModels();
    } catch (error) {
      if (epoch !== dataCacheEpoch) return false;
      if (barrier && !isHabitReadBarrierCurrent(barrier)) continue;
      throw error;
    }
    if (epoch !== dataCacheEpoch) return false;
    if (barrier && !isHabitReadBarrierCurrent(barrier)) continue;
    // Admission check and publication share one turn. Import has already
    // settled pre-cutoff writes and owns the authoritative replacement here.
    publish(habits);
    return true;
  }
}
export const useHabitStore = create<HabitStore>((set, get) => ({
  habits: [],
  allHabits: [],
  allHabitsLoaded: false,
  dayRecords: [],
  currentDayRecordsDate: null,
  dayRecordsByDate: {},
  allDayRecords: [],
  allDayRecordsLoaded: false,
  isLoading: false,
  error: null,
  errorRevision: 0,
  async loadHabits(options) {
    const requestEpoch = dataCacheEpoch;
    const publishError = shouldPublishHabitLoadError(options);
    const committedImport = options?.mode === "committed-import";
    const releaseTombstoneRead = deletedHabitTombstones.beginRead();
    try {
      set(
        publishError ? { isLoading: true, error: null } : { isLoading: true },
      );
      return await readAndPublishCurrentHabits(
        requestEpoch,
        committedImport,
        (allHabits) => {
          const pendingHabits = committedImport
            ? []
            : get().habits.filter((habit) =>
                pendingOptimisticHabitIds.has(habit.id),
              );
          const publishableHabits = committedImport
            ? allHabits
            : allHabits.filter(
                (habit) =>
                  !pendingHabitDeletionIds.has(habit.id) &&
                  !deletedHabitTombstones.has(habit.id),
              );
          const loadedHabits = [
            ...publishableHabits.filter((habit) => !habit.isArchived),
            ...pendingHabits,
          ];
          set((state) => {
            transitionHabitViewModelCaches(
              state.habits,
              loadedHabits,
              "existence",
            );
            return {
              habits: loadedHabits,
              allHabits: [...publishableHabits, ...pendingHabits],
              allHabitsLoaded: true,
              isLoading: false,
            };
          });
          scheduleHabitRemindersSync(loadedHabits.filter((habit) => habit.id > 0));
        },
      );
    } catch (e) {
      if (requestEpoch !== dataCacheEpoch) return false;
      set(
        publishError
          ? {
              isLoading: false,
              ...createHabitErrorUpdate(
                e instanceof Error ? e.message : "Failed to load habits",
              ),
            }
          : { isLoading: false },
      );
      return false;
    } finally {
      releaseTombstoneRead();
    }
  },
  async loadDayRecords(date: string, options) {
    const publishError = shouldPublishHabitLoadError(options);
    const requestToken = ++dayRecordsRequestToken;
    try {
      const state = get();
      const shouldBootstrapInitialWindow = !hasBootstrappedInitialDayWindow;
      const preloadRadius = shouldBootstrapInitialWindow
        ? INITIAL_DAY_RECORDS_WINDOW_RADIUS
        : DAY_RECORDS_WINDOW_RADIUS;
      const hasCachedDate = Object.prototype.hasOwnProperty.call(
        state.dayRecordsByDate,
        date,
      );
      // Fast path: serve already known day data instantly.
      if (hasCachedDate) {
        const cached = state.dayRecordsByDate[date] ?? EMPTY_DAY_RECORDS;
        if (
          state.currentDayRecordsDate === date &&
          state.dayRecords === cached
        ) {
          return true;
        }
        set({
          dayRecords: cached,
          currentDayRecordsDate: date,
        });
        // One-time deep warm-up: keep the whole nearby calendar window hot.
        if (shouldBootstrapInitialWindow) {
          hasBootstrappedInitialDayWindow = true;
          void get().preloadDayRecordsWindow(
            date,
            INITIAL_DAY_RECORDS_WINDOW_RADIUS,
          );
        }
        return true;
      }
      // If full history is already in memory, derive day slice without DB call.
      if (state.allDayRecordsLoaded) {
        const derived = allDayRecordsByDateCache[date] ?? EMPTY_DAY_RECORDS;
        if (
          state.currentDayRecordsDate === date &&
          state.dayRecords === derived
        ) {
          return true;
        }
        set({
          dayRecords: derived,
          currentDayRecordsDate: date,
        });
        if (shouldBootstrapInitialWindow) {
          hasBootstrappedInitialDayWindow = true;
        }
        return true;
      }
      // Fundamental fast-path: hydrate a date window in one DB query,
      // so adjacent date switches hit warm cache instantly.
      const windowLoaded = await get().preloadDayRecordsWindow(
        date,
        preloadRadius,
      );
      if (!windowLoaded) {
        if (publishError && requestToken === dayRecordsRequestToken) {
          set(createHabitErrorUpdate("Failed to load day records"));
        }
        return false;
      }
      const stateAfterWindowWarm = get();
      const mapped =
        stateAfterWindowWarm.dayRecordsByDate[date] ?? EMPTY_DAY_RECORDS;
      if (requestToken !== dayRecordsRequestToken) {
        // A newer date request won the race; keep warmed cache only.
        return false;
      }
      set({
        dayRecords: mapped,
        currentDayRecordsDate: date,
      });
      if (shouldBootstrapInitialWindow) {
        hasBootstrappedInitialDayWindow = true;
      }
      return true;
    } catch (e) {
      if (requestToken !== dayRecordsRequestToken) return false;
      if (publishError) {
        set(
          createHabitErrorUpdate(
            e instanceof Error ? e.message : "Failed to load day records",
          ),
        );
      }
      return false;
    }
  },
  async preloadDayRecordsWindow(
    centerDate: string,
    radius = DAY_RECORDS_WINDOW_RADIUS,
  ) {
    const requestEpoch = dataCacheEpoch;
    const releaseTombstoneRead = deletedHabitTombstones.beginRead();
    try {
      const state = get();
      const windowDates = buildDateWindow(centerDate, radius);
      if (windowDates.length === 0) return false;
      const startDate = windowDates[0];
      const endDate = windowDates[windowDates.length - 1];
      const missingDates = windowDates.filter(
        (date) =>
          !Object.prototype.hasOwnProperty.call(state.dayRecordsByDate, date),
      );
      if (missingDates.length === 0) {
        return true;
      }
      if (state.allDayRecordsLoaded) {
        const derivedMissingDates = Object.fromEntries(
          missingDates.map((date) => [
            date,
            allDayRecordsByDateCache[date] ?? EMPTY_DAY_RECORDS,
          ]),
        );
        set((prev) => ({
          dayRecordsByDate: mergeHotDayRecordsByDate({
            prevMap: prev.dayRecordsByDate,
            updates: derivedMissingDates,
            pinnedDates: [prev.currentDayRecordsDate, centerDate],
          }),
        }));
        return true;
      }
      const inFlightKey = `${startDate}|${endDate}`;
      return await readAndPublishCurrentDayRecords(
        requestEpoch,
        () => {
          const current = get();
          if (
            current.allDayRecordsLoaded ||
            windowDates.every((date) =>
              Object.prototype.hasOwnProperty.call(
                current.dayRecordsByDate,
                date,
              ),
            )
          ) {
            return Promise.resolve(
              Object.fromEntries(
                windowDates.map((date) => [
                  date,
                  current.dayRecordsByDate[date] ??
                    allDayRecordsByDateCache[date] ??
                    EMPTY_DAY_RECORDS,
                ]),
              ),
            );
          }
          let pending = dayRecordsWindowLoadInFlight.get(inFlightKey);
          if (!pending) {
            pending = habitPersistence
              .readDayRecordsInDateRange(startDate, endDate)
              .then((rows) => {
                const grouped: Record<string, DayRecord[]> = {};
                for (const date of windowDates) grouped[date] = [];
                for (const row of rows) {
                  if (
                    !Object.prototype.hasOwnProperty.call(grouped, row.date)
                  ) {
                    grouped[row.date] = [];
                  }
                  grouped[row.date].push(row);
                }
                return grouped;
              });
            dayRecordsWindowLoadInFlight.set(inFlightKey, pending);
            const releasePending = () => {
              if (dayRecordsWindowLoadInFlight.get(inFlightKey) === pending) {
                dayRecordsWindowLoadInFlight.delete(inFlightKey);
              }
            };
            void pending.then(releasePending, releasePending);
          }
          return pending;
        },
        (groupedByDate) => {
          const missingDateEntries = Object.fromEntries(
            missingDates.map((date) => [
              date,
              applyDayRecordOverlaysForDate(
                (groupedByDate[date] ?? []).filter(
                  (record) =>
                    !pendingHabitDeletionIds.has(record.habitId) &&
                    !deletedHabitTombstones.has(record.habitId),
                ),
                date,
              ),
            ]),
          );
          set((prev) => ({
            dayRecordsByDate: mergeHotDayRecordsByDate({
              prevMap: prev.dayRecordsByDate,
              updates: missingDateEntries,
              pinnedDates: [prev.currentDayRecordsDate, centerDate],
            }),
          }));
        },
      );
    } catch {
      if (requestEpoch !== dataCacheEpoch) return false;
      return false;
    } finally {
      releaseTombstoneRead();
    }
  },
  async preloadDayRecords(date: string) {
    return get().preloadDayRecordsWindow(date, 0);
  },
  getDayListSnapshot(date: string, isPast: boolean) {
    return getDayListSnapshotForState(get(), date, isPast);
  },
  preloadDayListSnapshotsWindow(
    centerDate: string,
    radius = DAY_RECORDS_WINDOW_RADIUS + 1,
  ) {
    const windowDates = buildDateWindow(centerDate, radius);
    if (windowDates.length === 0) return;
    const todayIso = format(new Date(), "yyyy-MM-dd");
    const state = get();
    for (const date of windowDates) {
      const dateIsPast = date < todayIso;
      getDayListSnapshotForState(state, date, dateIsPast);
    }
  },
  async loadAllDayRecords(options) {
    const requestEpoch = dataCacheEpoch;
    const publishError = shouldPublishHabitLoadError(options);
    const releaseTombstoneRead = deletedHabitTombstones.beginRead();
    try {
      return await readAndPublishCurrentDayRecords(
        requestEpoch,
        queryAllDayRecordModels,
        (queried) => {
          (() => {
            // A full-history query can overlap an optimistic mark. Merge the
            // latest local intent before publishing the guarded snapshot.
            const mapped = applyDayRecordOverlays(
              queried.filter(
                (record) =>
                  !pendingHabitDeletionIds.has(record.habitId) &&
                  !deletedHabitTombstones.has(record.habitId),
              ),
            );
            const groupedByDate: Record<string, DayRecord[]> = {};
            for (const record of mapped) {
              if (!groupedByDate[record.date]) groupedByDate[record.date] = [];
              groupedByDate[record.date].push(record);
            }
            allDayRecordsByDateCache = groupedByDate;
            set((state) => {
              transitionRecordViewModelCaches(state.allDayRecords, mapped);
              return {
                allDayRecords: mapped,
                allDayRecordsLoaded: true,
                // Keep the hot window bounded instead of storing full history twice.
                dayRecords: state.currentDayRecordsDate
                  ? (state.dayRecordsByDate[state.currentDayRecordsDate] ??
                    groupedByDate[state.currentDayRecordsDate] ??
                    EMPTY_DAY_RECORDS)
                  : state.dayRecords,
              };
            });
          })();
        },
      );
    } catch (e) {
      if (requestEpoch !== dataCacheEpoch) return false;
      if (publishError) {
        set(
          createHabitErrorUpdate(
            e instanceof Error ? e.message : "Failed to load all day records",
          ),
        );
      }
      return false;
    } finally {
      releaseTombstoneRead();
    }
  },
  async createHabit(input) {
    const writeSequence = getCurrentHabitWriteSequence();
    const creationEpoch = dataCacheEpoch;
    const now = new Date();
    const optimisticId = nextOptimisticHabitId--;
    pendingOptimisticHabitIds.add(optimisticId);
    const currentState = get();
    const knownHabits = currentState.allHabitsLoaded
      ? currentState.allHabits
      : currentState.habits;
    const knownMaxOrder = knownHabits.reduce(
      (highest, habit) => Math.max(highest, habit.displayOrder),
      -1,
    );
    const scheduleHistory = [
      {
        effectiveFrom: input.startDate,
        startDate: input.startDate,
        repeatSchedule: input.repeatSchedule,
      },
    ];
    const optimisticHabit: Habit = {
      id: optimisticId,
      name: input.name,
      description: input.description ?? null,
      descriptionVisible: true,
      repeatSchedule: input.repeatSchedule,
      scheduleHistory,
      startDate: input.startDate,
      reminderEnabled: input.reminderEnabled,
      reminderTime: input.reminderTime ?? null,
      displayOrder: knownMaxOrder + 1,
      isArchived: false,
      archivedAt: null,
      archiveHistory: [],
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
    invalidateViewModelCachesForChange("existence");
    set((state) => ({
      habits: [...state.habits, optimisticHabit],
      allHabits: state.allHabitsLoaded
        ? [...state.allHabits, optimisticHabit]
        : state.allHabits,
    }));
    await persistenceCommitScheduler.waitForCommitOpportunity();
    if (!(await waitForHabitPersistenceTurn(writeSequence))) {
      pendingOptimisticHabitIds.delete(optimisticId);
      invalidateViewModelCachesForChange("existence");
      set((state) => ({
        habits: state.habits.filter((habit) => habit.id !== optimisticId),
        allHabits: state.allHabits.filter((habit) => habit.id !== optimisticId),
      }));
      throw new DiscardedHabitWriteError();
    }
    try {
      const { id: _optimisticId, ...habitToPersist } = optimisticHabit;
      const habit = await habitPersistence.createHabit({
        habit: habitToPersist,
        resolveDisplayOrderFromStorage: !currentState.allHabitsLoaded,
      });
      if (creationEpoch !== dataCacheEpoch) {
        pendingOptimisticHabitIds.delete(optimisticId);
        return habit;
      }
      let nextHabits: Habit[] = [];
      invalidateViewModelCachesForChange("existence");
      set((state) => {
        const replaceOrAppend = (current: Habit[]) =>
          current.some((candidate) => candidate.id === optimisticId)
            ? current.map((candidate) =>
                candidate.id === optimisticId ? habit : candidate,
              )
            : [...current, habit];
        nextHabits = replaceOrAppend(state.habits);
        return {
          habits: nextHabits,
          allHabits: state.allHabitsLoaded
            ? replaceOrAppend(state.allHabits)
            : state.allHabits,
        };
      });
      pendingOptimisticHabitIds.delete(optimisticId);
      scheduleHabitRemindersSync(nextHabits, {
        requestPermission: input.reminderEnabled === true,
      });
      return habit;
    } catch (error) {
      pendingOptimisticHabitIds.delete(optimisticId);
      if (creationEpoch !== dataCacheEpoch) throw error;
      invalidateViewModelCachesForChange("existence");
      set((state) => ({
        habits: state.habits.filter((habit) => habit.id !== optimisticId),
        allHabits: state.allHabits.filter((habit) => habit.id !== optimisticId),
        ...createHabitErrorUpdate(
          error instanceof Error ? error.message : "Failed to create habit",
        ),
      }));
      throw error;
    }
  },
  async updateHabit(id, input) {
    if (id <= 0 || pendingHabitDeletionIds.has(id)) return;
    const partitionedInput = partitionMixedHabitUpdateInput(input);
    if (partitionedInput) {
      // Schedule edits can delete records. Give the destructive transaction and
      // ordinary editable fields independent ownership so a newer schedule tap
      // can cancel only the stale schedule work without losing the other edit.
      await Promise.all([
        get().updateHabit(id, partitionedInput.schedule),
        get().updateHabit(id, partitionedInput.editable),
      ]);
      return;
    }
    const now = new Date();
    const updateData: HabitPatch = { updatedAt: now.getTime() };
    const changesSchedule =
      input.repeatSchedule !== undefined || input.startDate !== undefined;
    const changesReminder =
      input.reminderEnabled !== undefined || input.reminderTime !== undefined;
    const reminderEnabledBeforeUpdate =
      get().allHabits.find((habit) => habit.id === id)?.reminderEnabled ??
      get().habits.find((habit) => habit.id === id)?.reminderEnabled ??
      false;
    const requestsReminderPermission =
      input.reminderEnabled === true && !reminderEnabledBeforeUpdate;
    let scheduleWasUpdated = false;
    let habitWasFound = true;
    let persistedHabit: Habit | null = null;
    let removedRecordDates = new Set<string>();
    if (input.description !== undefined)
      updateData.description = input.description;
    if (input.descriptionVisible !== undefined)
      updateData.descriptionVisible = input.descriptionVisible;
    if (input.reminderEnabled !== undefined)
      updateData.reminderEnabled = input.reminderEnabled;
    if (input.reminderTime !== undefined)
      updateData.reminderTime = input.reminderTime;
    const ownership = beginHabitMutation(
      id,
      getUpdateHabitMutationScopes(input, changesSchedule),
    );
    // A schedule transaction may delete failure/skip reason notes. Invalidate
    // before the transaction is queued so an older in-flight notes SELECT
    // cannot republish a pre-edit snapshot after the deletion commits.
    if (changesSchedule) invalidateNotesProjection(id);
    // Description, visibility and reminder edits are single-row changes. Keep
    // them on a short path instead of reloading every habit and its reminders.
    if (!changesSchedule) {
      const stateBefore = get();
      const previousHabit =
        stateBefore.allHabits.find((habit) => habit.id === id) ??
        stateBefore.habits.find((habit) => habit.id === id) ??
        null;
      let nextHabits = get().habits;
      set((state) => {
        const updateModel = (habit: Habit): Habit =>
          habit.id === id
            ? {
                ...habit,
                ...(input.description !== undefined
                  ? { description: input.description }
                  : null),
                ...(input.descriptionVisible !== undefined
                  ? { descriptionVisible: input.descriptionVisible }
                  : null),
                ...(input.reminderEnabled !== undefined
                  ? { reminderEnabled: input.reminderEnabled }
                  : null),
                ...(input.reminderTime !== undefined
                  ? { reminderTime: input.reminderTime }
                  : null),
                updatedAt: now.getTime(),
              }
            : habit;
        nextHabits = state.habits.map(updateModel);
        transitionHabitViewModelCaches(state.habits, nextHabits, "metadata");
        return {
          habits: nextHabits,
          allHabits: state.allHabits.map(updateModel),
        };
      });
      await persistenceCommitScheduler.waitForCommitOpportunity();
      if (!(await waitForHabitPersistenceTurn(ownership.writeSequence))) {
        finishHabitMutation(ownership);
        return;
      }
      const persistablePatch = selectPersistableHabitUpdatePatch(
        updateData,
        (scope) => shouldPersistHabitMutation(ownership, scope),
      );
      if (persistablePatch == null) {
        finishHabitMutation(ownership);
        return;
      }
      try {
        await habitPersistence.patchHabit(id, persistablePatch);
        const shouldSyncReminder =
          changesReminder &&
          ((input.reminderEnabled !== undefined &&
            isLatestHabitMutation(ownership, "reminder-enabled")) ||
            (input.reminderTime !== undefined &&
              isLatestHabitMutation(ownership, "reminder-time")));
        finishHabitMutation(ownership);
        if (shouldSyncReminder) {
          scheduleHabitRemindersSync(get().habits, {
            requestPermission: requestsReminderPermission,
          });
        }
        return;
      } catch (error) {
        let rollbackHabit = previousHabit;
        if (
          ownership.scopes.some((scope) =>
            isLatestHabitMutation(ownership, scope),
          )
        ) {
          try {
            rollbackHabit = await queryHabitModelById(id);
          } catch {}
        }
        const stillOwnsAnyScope = ownership.scopes.some((scope) =>
          isLatestHabitMutation(ownership, scope),
        );
        const shouldSyncReminder =
          stillOwnsAnyScope &&
          changesReminder &&
          ((input.reminderEnabled !== undefined &&
            isLatestHabitMutation(ownership, "reminder-enabled")) ||
            (input.reminderTime !== undefined &&
              isLatestHabitMutation(ownership, "reminder-time")));
        let rolledBackHabits = get().habits;
        if (stillOwnsAnyScope && rollbackHabit) {
          const rollbackValues: Partial<Habit> = {
            ...(input.description !== undefined
              ? { description: rollbackHabit.description }
              : null),
            ...(input.descriptionVisible !== undefined
              ? { descriptionVisible: rollbackHabit.descriptionVisible }
              : null),
            ...(input.reminderEnabled !== undefined
              ? { reminderEnabled: rollbackHabit.reminderEnabled }
              : null),
            ...(input.reminderTime !== undefined
              ? { reminderTime: rollbackHabit.reminderTime }
              : null),
            updatedAt: rollbackHabit.updatedAt,
          };
          set((state) => {
            rolledBackHabits = state.habits.map((habit) =>
              applyOwnedHabitFields(habit, ownership, rollbackValues),
            );
            transitionHabitViewModelCaches(
              state.habits,
              rolledBackHabits,
              "metadata",
            );
            return {
              habits: rolledBackHabits,
              allHabits: state.allHabits.map((habit) =>
                applyOwnedHabitFields(habit, ownership, rollbackValues),
              ),
              ...createHabitErrorUpdate(
                error instanceof Error
                  ? error.message
                  : "Failed to update habit",
              ),
            };
          });
        } else if (stillOwnsAnyScope) {
          set(
            createHabitErrorUpdate(
              error instanceof Error ? error.message : "Failed to update habit",
            ),
          );
        }
        finishHabitMutation(ownership);
        if (shouldSyncReminder) {
          scheduleHabitRemindersSync(rolledBackHabits);
        }
        throw error;
      }
    }
    // Habit detail has already published the complete schedule preview. Keep
    // its first correct frame ahead of the synchronous SQLite transaction.
    await persistenceCommitScheduler.waitForCommitOpportunity();
    if (!(await waitForHabitPersistenceTurn(ownership.writeSequence))) {
      finishHabitMutation(ownership);
      return;
    }
    if (!shouldPersistHabitMutation(ownership, "schedule")) {
      finishHabitMutation(ownership);
      return;
    }
    try {
      const persistableScheduleRowPatch =
        selectPersistableHabitUpdatePatch(updateData, (scope) =>
          shouldPersistHabitMutation(ownership, scope),
        ) ?? {};
      const result = await habitPersistence.persistScheduleEdit({
        habitId: id,
        patch: persistableScheduleRowPatch,
        nextRepeatSchedule: input.repeatSchedule,
        nextStartDate: input.startDate,
        today: format(now, "yyyy-MM-dd"),
        isCurrent: () => shouldPersistHabitMutation(ownership, "schedule"),
      });
      habitWasFound = result.kind !== "missing";
      scheduleWasUpdated = result.kind === "updated";
      if (result.kind === "updated") {
        persistedHabit = result.habit;
        removedRecordDates = new Set(result.removedRecordDates);
      }
    } catch (error) {
      if (error instanceof StaleHabitScheduleMutationError) {
        finishHabitMutation(ownership);
        return;
      }
      // A previous schedule transaction can commit after a newer optimistic
      // schedule is already visible. If that newer transaction then fails,
      // restore the actual committed row *and* its records as one store update.
      // Re-check ownership after the reads so a newer intent wins.
      if (isLatestHabitMutation(ownership, "schedule")) {
        try {
          const [authoritativeHabit, authoritativeRecords] = await Promise.all([
            queryHabitModelById(id),
            queryHabitDayRecordModels(id),
          ]);
          if (
            authoritativeHabit &&
            isLatestHabitMutation(ownership, "schedule")
          ) {
            invalidatePendingDayRecordReads();
            const authoritativeByDate = new Map(
              authoritativeRecords.map((record) => [record.date, record]),
            );
            for (const [date, records] of Object.entries(
              allDayRecordsByDateCache,
            )) {
              allDayRecordsByDateCache[date] = replaceHabitRecordsForDate(
                records,
                id,
                date,
                authoritativeByDate,
              );
            }
            invalidateViewModelCachesForChange("schedule");
            let nextActiveHabits: Habit[] = [];
            set((state) => {
              const applyAuthoritativeFields = (habit: Habit): Habit =>
                applyOwnedHabitFields(habit, ownership, authoritativeHabit);
              nextActiveHabits = state.habits.map(applyAuthoritativeFields);
              const nextDayRecordsByDate: Record<string, DayRecord[]> = {};
              for (const [date, records] of Object.entries(
                state.dayRecordsByDate,
              )) {
                nextDayRecordsByDate[date] = replaceHabitRecordsForDate(
                  records,
                  id,
                  date,
                  authoritativeByDate,
                );
              }
              return {
                habits: nextActiveHabits,
                allHabits: state.allHabits.map(applyAuthoritativeFields),
                allDayRecords: replaceAllHabitRecords(
                  state.allDayRecords,
                  id,
                  authoritativeRecords,
                ),
                dayRecordsByDate: nextDayRecordsByDate,
                dayRecords: state.currentDayRecordsDate
                  ? replaceHabitRecordsForDate(
                      state.dayRecords,
                      id,
                      state.currentDayRecordsDate,
                      authoritativeByDate,
                    )
                  : state.dayRecords,
                ...createHabitErrorUpdate(
                  error instanceof Error
                    ? error.message
                    : "Failed to update habit",
                ),
              };
            });
            scheduleHabitRemindersSync(nextActiveHabits);
          }
        } catch {}
      }
      finishHabitMutation(ownership);
      throw error;
    }
    if (!habitWasFound) {
      finishHabitMutation(ownership);
      return;
    }
    if (scheduleWasUpdated) {
      // The transaction callback assigns this value before this branch runs.
      // TypeScript cannot follow assignments made inside the async callback,
      // so keep the runtime null guard while restoring the declared union.
      const nextHabit = persistedHabit as Habit | null;
      if (!nextHabit) {
        finishHabitMutation(ownership);
        return;
      }
      const persistedValues: Partial<Habit> = {
        repeatSchedule: nextHabit.repeatSchedule,
        scheduleHistory: nextHabit.scheduleHistory,
        startDate: nextHabit.startDate,
        ...(input.description !== undefined
          ? { description: nextHabit.description }
          : null),
        ...(input.descriptionVisible !== undefined
          ? { descriptionVisible: nextHabit.descriptionVisible }
          : null),
        ...(input.reminderEnabled !== undefined
          ? { reminderEnabled: nextHabit.reminderEnabled }
          : null),
        ...(input.reminderTime !== undefined
          ? { reminderTime: nextHabit.reminderTime }
          : null),
        updatedAt: nextHabit.updatedAt,
      };
      // A newer repeat/start-date intent can already be visible while this
      // transaction is finishing. Never publish the older schedule (or its
      // record removals) over that newer intent.
      if (!isLatestHabitMutation(ownership, "schedule")) {
        const hasOwnedRowField = ownership.scopes.some(
          (scope) =>
            scope !== "schedule" &&
            scope !== "metadata" &&
            isLatestHabitMutation(ownership, scope),
        );
        if (hasOwnedRowField) {
          set((state) => {
            const nextHabits = state.habits.map((habit) =>
              applyOwnedHabitFields(habit, ownership, persistedValues),
            );
            transitionHabitViewModelCaches(
              state.habits,
              nextHabits,
              "metadata",
            );
            return {
              habits: nextHabits,
              allHabits: state.allHabits.map((habit) =>
                applyOwnedHabitFields(habit, ownership, persistedValues),
              ),
            };
          });
        }
        const shouldSyncReminder =
          (input.reminderEnabled !== undefined &&
            isLatestHabitMutation(ownership, "reminder-enabled")) ||
          (input.reminderTime !== undefined &&
            isLatestHabitMutation(ownership, "reminder-time"));
        finishHabitMutation(ownership);
        if (shouldSyncReminder) {
          scheduleHabitRemindersSync(get().habits, {
            requestPermission: requestsReminderPermission,
          });
        }
        return;
      }
      const scheduleDayMutations = new Map<string, number>();
      for (const date of removedRecordDates) {
        const mutation = beginDayMutation(id, date, ownership.writeSequence);
        scheduleDayMutations.set(mutation.key, mutation.mutationId);
        dayRecordOverlays.set(mutation.key, null);
      }
      if (removedRecordDates.size > 0) invalidatePendingDayRecordReads();
      invalidateViewModelCachesForChange("schedule");
      let nextActiveHabits: Habit[] = [];
      set((state) => {
        const keepRecord = (record: DayRecord) =>
          !(record.habitId === id && removedRecordDates.has(record.date));
        const nextAllDayRecords = state.allDayRecords.filter(keepRecord);
        const nextDayRecordsByDate: Record<string, DayRecord[]> = {};
        for (const [date, records] of Object.entries(state.dayRecordsByDate)) {
          const filtered = records.filter(keepRecord);
          nextDayRecordsByDate[date] = filtered;
        }
        for (const [date, records] of Object.entries(
          allDayRecordsByDateCache,
        )) {
          allDayRecordsByDateCache[date] = records.filter(keepRecord);
        }
        const applyScheduleOwnedFields = (habit: Habit): Habit =>
          applyOwnedHabitFields(habit, ownership, persistedValues);
        nextActiveHabits = state.habits.map(applyScheduleOwnedFields);
        return {
          habits: nextActiveHabits,
          allHabits: state.allHabits.map(applyScheduleOwnedFields),
          allDayRecords: nextAllDayRecords,
          dayRecordsByDate: nextDayRecordsByDate,
          dayRecords: state.dayRecords.filter(keepRecord),
        };
      });
      for (const date of removedRecordDates) {
        const key = dayRecordOverlayKey(id, date);
        dayRecordOverlays.delete(key);
        const mutationId = scheduleDayMutations.get(key);
        if (mutationId != null) finishDayMutation(key, mutationId);
      }
      finishHabitMutation(ownership);
      scheduleHabitRemindersSync(nextActiveHabits);
      return;
    }
    // A schedule edit can be a semantic no-op while the same save also changes
    // a reminder or description. Reflect those row fields without reloading
    // the whole database.
    let nextActiveHabits = get().habits;
    const persistedValues: Partial<Habit> = {
      ...(input.description !== undefined
        ? { description: input.description }
        : null),
      ...(input.descriptionVisible !== undefined
        ? { descriptionVisible: input.descriptionVisible }
        : null),
      ...(input.reminderEnabled !== undefined
        ? { reminderEnabled: input.reminderEnabled }
        : null),
      ...(input.reminderTime !== undefined
        ? { reminderTime: input.reminderTime }
        : null),
      updatedAt: now.getTime(),
    };
    const applyRowFields = (habit: Habit): Habit =>
      applyOwnedHabitFields(habit, ownership, persistedValues);
    set((state) => {
      nextActiveHabits = state.habits.map(applyRowFields);
      transitionHabitViewModelCaches(
        state.habits,
        nextActiveHabits,
        "metadata",
      );
      return {
        habits: nextActiveHabits,
        allHabits: state.allHabits.map(applyRowFields),
      };
    });
    const shouldSyncReminder =
      changesReminder &&
      ((input.reminderEnabled !== undefined &&
        isLatestHabitMutation(ownership, "reminder-enabled")) ||
        (input.reminderTime !== undefined &&
          isLatestHabitMutation(ownership, "reminder-time")));
    finishHabitMutation(ownership);
    if (shouldSyncReminder) {
      scheduleHabitRemindersSync(nextActiveHabits, {
        requestPermission: requestsReminderPermission,
      });
    }
  },
  async renameHabit(id, name) {
    if (id <= 0 || pendingHabitDeletionIds.has(id)) return;
    const updatedAt = new Date();
    const ownership = beginHabitMutation(id, ["name", "metadata"]);
    const stateBefore = get();
    const previousHabit =
      stateBefore.allHabits.find((habit) => habit.id === id) ??
      stateBefore.habits.find((habit) => habit.id === id) ??
      null;
    const updateName = (habit: Habit): Habit =>
      habit.id === id
        ? { ...habit, name, updatedAt: updatedAt.getTime() }
        : habit;
    set((state) => {
      const nextActiveHabits = state.habits.map(updateName);
      transitionHabitViewModelCaches(
        state.habits,
        nextActiveHabits,
        "metadata",
      );
      return {
        habits: nextActiveHabits,
        allHabits: state.allHabits.map(updateName),
      };
    });
    await persistenceCommitScheduler.waitForCommitOpportunity();
    if (!(await waitForHabitPersistenceTurn(ownership.writeSequence))) {
      finishHabitMutation(ownership);
      return;
    }
    if (!shouldPersistHabitMutation(ownership, "name")) {
      finishHabitMutation(ownership);
      return;
    }
    try {
      await habitPersistence.patchHabit(id, {
        name,
        updatedAt: updatedAt.getTime(),
      });
    } catch (error) {
      let rollbackHabit = previousHabit;
      if (isLatestHabitMutation(ownership, "name")) {
        try {
          rollbackHabit = await queryHabitModelById(id);
        } catch {}
      }
      const stillOwnsName = isLatestHabitMutation(ownership, "name");
      if (stillOwnsName && rollbackHabit) {
        const rollbackValues: Partial<Habit> = {
          name: rollbackHabit.name,
          updatedAt: rollbackHabit.updatedAt,
        };
        set((state) => {
          const nextHabits = state.habits.map((habit) =>
            applyOwnedHabitFields(habit, ownership, rollbackValues),
          );
          transitionHabitViewModelCaches(state.habits, nextHabits, "metadata");
          return {
            habits: nextHabits,
            allHabits: state.allHabits.map((habit) =>
              applyOwnedHabitFields(habit, ownership, rollbackValues),
            ),
            ...createHabitErrorUpdate(
              error instanceof Error ? error.message : "Failed to rename habit",
            ),
          };
        });
      } else if (stillOwnsName) {
        set(
          createHabitErrorUpdate(
            error instanceof Error ? error.message : "Failed to rename habit",
          ),
        );
      }
      finishHabitMutation(ownership);
      throw error;
    }
    const shouldSyncReminder =
      isLatestHabitMutation(ownership, "name") &&
      get().habits.some(
        (habit) =>
          habit.id === id &&
          habit.reminderEnabled &&
          habit.reminderTime != null,
      );
    finishHabitMutation(ownership);
    if (shouldSyncReminder) {
      scheduleHabitRemindersSync(get().habits);
    }
  },
  async reorderHabits(orderedIds) {
    const currentHabits = get().habits;
    const currentIds = currentHabits.map((habit) => habit.id);
    if (currentIds.some((id) => id <= 0) || orderedIds.some((id) => id <= 0)) {
      return;
    }
    if (orderedIds.some((id) => pendingHabitDeletionIds.has(id))) return;
    if (orderedIds.length !== currentIds.length) {
      return;
    }
    if (new Set(orderedIds).size !== orderedIds.length) {
      return;
    }
    const currentIdSet = new Set(currentIds);
    const hasUnknownIds = orderedIds.some((id) => !currentIdSet.has(id));
    if (hasUnknownIds) {
      return;
    }
    const habitById = new Map(currentHabits.map((habit) => [habit.id, habit]));
    const reorderedHabits = orderedIds.map((id) => habitById.get(id)!);
    const token = ++reorderWriteToken;
    const writeSequence = getCurrentHabitWriteSequence();
    latestReorderWriteSequence = writeSequence;
    set((state) => {
      let nextHabits = reorderedHabits;
      let nextAllHabits = state.allHabits;
      if (state.allHabitsLoaded) {
        const assignments = assignDisplayOrdersAroundArchivedSlots(
          orderedIds,
          state.allHabits
            .filter((habit) => habit.isArchived)
            .map(({ id, displayOrder }) => ({ id, displayOrder })),
        );
        const optimisticOrders = [
          ...assignments.archived,
          ...assignments.active,
        ];
        nextHabits = reconcileDisplayOrderRows(
          reorderedHabits,
          assignments.active,
        );
        nextAllHabits = reconcileDisplayOrderRows(
          state.allHabits,
          optimisticOrders,
        );
      }
      transitionHabitViewModelCaches(state.habits, nextHabits, "ordering");
      return { habits: nextHabits, allHabits: nextAllHabits };
    });
    await persistenceCommitScheduler.waitForCommitOpportunity();
    if (!(await waitForHabitPersistenceTurn(writeSequence))) return;
    if (
      token !== reorderWriteToken &&
      !isHabitWriteProtectedByFence(writeSequence, latestReorderWriteSequence)
    ) {
      return;
    }
    try {
      const persistedOrders = await habitPersistence.persistReorder(orderedIds);
      if (token === reorderWriteToken) {
        set((state) => {
          const nextHabits = reconcileDisplayOrderRows(
            state.habits,
            persistedOrders,
          );
          const nextAllHabits = reconcileDisplayOrderRows(
            state.allHabits,
            persistedOrders,
          );
          if (
            nextHabits === state.habits &&
            nextAllHabits === state.allHabits
          ) {
            return state;
          }
          transitionHabitViewModelCaches(state.habits, nextHabits, "ordering");
          return {
            habits: nextHabits,
            allHabits: nextAllHabits,
          };
        });
      }
    } catch (e) {
      if (token !== reorderWriteToken) {
        return;
      }
      let authoritativeHabits: Habit[] | null = null;
      try {
        authoritativeHabits = await queryAllHabitModels();
      } catch {}
      if (token !== reorderWriteToken) return;
      if (authoritativeHabits) {
        const authoritativeOrders = authoritativeHabits.map(
          ({ id, displayOrder }) => ({ id, displayOrder }),
        );
        set((state) => {
          const nextHabits = reconcileDisplayOrderRows(
            state.habits,
            authoritativeOrders,
          );
          const nextAllHabits = reconcileDisplayOrderRows(
            state.allHabits,
            authoritativeOrders,
          );
          if (nextHabits !== state.habits) {
            transitionHabitViewModelCaches(
              state.habits,
              nextHabits,
              "ordering",
            );
          }
          return {
            habits: nextHabits,
            allHabits: nextAllHabits,
            ...createHabitErrorUpdate(
              e instanceof Error ? e.message : "Failed to reorder habits",
            ),
          };
        });
      } else {
        set(
          createHabitErrorUpdate(
            e instanceof Error ? e.message : "Failed to reorder habits",
          ),
        );
      }
    }
  },
  async archiveHabit(id) {
    if (id <= 0 || pendingHabitDeletionIds.has(id)) return;
    const stateBefore = get();
    const target =
      stateBefore.allHabits.find((habit) => habit.id === id) ??
      stateBefore.habits.find((habit) => habit.id === id);
    if (!target || target.isArchived) return;
    const now = new Date();
    const archivedHabit: Habit = {
      ...target,
      isArchived: true,
      archivedAt: now.getTime(),
      archiveHistory: startArchivePeriod(target.archiveHistory, now.getTime()),
      updatedAt: now.getTime(),
    };
    const ownership = beginHabitMutation(id, [
      "existence",
      "lifecycle",
      "metadata",
    ]);
    invalidateViewModelCachesForChange("lifecycle");
    set((state) => {
      const nextActiveHabits = state.habits.filter((habit) => habit.id !== id);
      return {
        habits: nextActiveHabits,
        allHabits: state.allHabits.map((habit) =>
          habit.id === id ? archivedHabit : habit,
        ),
      };
    });
    await persistenceCommitScheduler.waitForCommitOpportunity();
    if (!(await waitForHabitPersistenceTurn(ownership.writeSequence))) {
      finishHabitMutation(ownership);
      return;
    }
    if (
      !shouldPersistHabitMutation(ownership, "existence") ||
      !shouldPersistHabitMutation(ownership, "lifecycle")
    ) {
      finishHabitMutation(ownership);
      return;
    }
    try {
      const persistedArchiveHabit = await habitPersistence.archiveHabit(
        id,
        now.getTime(),
      );
      const shouldPublish =
        isLatestHabitMutation(ownership, "existence") &&
        isLatestHabitMutation(ownership, "lifecycle");
      if (shouldPublish) {
        set((state) => {
          const authoritative = persistedArchiveHabit as Habit | null;
          if (!authoritative) {
            const nextHabits = state.habits.filter((habit) => habit.id !== id);
            transitionHabitViewModelCaches(
              state.habits,
              nextHabits,
              "existence",
            );
            return {
              habits: nextHabits,
              allHabits: state.allHabits.filter((habit) => habit.id !== id),
            };
          }
          const current =
            state.allHabits.find((habit) => habit.id === id) ??
            state.habits.find((habit) => habit.id === id) ??
            authoritative;
          const reconciledHabit = applyOwnedHabitFields(
            current,
            ownership,
            authoritative,
          );
          const collections = upsertHabitInCollections(
            state.habits,
            state.allHabits,
            reconciledHabit,
          );
          if (
            collections.habits === state.habits &&
            collections.allHabits === state.allHabits
          ) {
            return state;
          }
          invalidateViewModelCachesForChange("lifecycle");
          return collections;
        });
      }
      finishHabitMutation(ownership);
      if (shouldPublish) {
        scheduleHabitRemindersSync(get().habits);
      }
    } catch (archiveError) {
      let rollbackHabit: Habit | null = target;
      if (
        isLatestHabitMutation(ownership, "existence") &&
        isLatestHabitMutation(ownership, "lifecycle")
      ) {
        try {
          rollbackHabit = await queryHabitModelById(id);
        } catch {}
      }
      const stillOwnsLifecycle =
        isLatestHabitMutation(ownership, "existence") &&
        isLatestHabitMutation(ownership, "lifecycle");
      if (stillOwnsLifecycle && rollbackHabit) {
        const rollbackValues: Partial<Habit> = {
          isArchived: rollbackHabit.isArchived,
          archivedAt: rollbackHabit.archivedAt,
          archiveHistory: rollbackHabit.archiveHistory,
          updatedAt: rollbackHabit.updatedAt,
        };
        invalidateViewModelCachesForChange("lifecycle");
        set((state) => {
          const currentHabit =
            state.allHabits.find((habit) => habit.id === id) ??
            state.habits.find((habit) => habit.id === id) ??
            archivedHabit;
          const restoredHabit = applyOwnedHabitFields(
            currentHabit,
            ownership,
            rollbackValues,
          );
          const reconciled = upsertHabitInCollections(
            state.habits,
            state.allHabits,
            restoredHabit,
          );
          return {
            ...reconciled,
            ...createHabitErrorUpdate(
              archiveError instanceof Error
                ? archiveError.message
                : "Failed to archive habit",
            ),
          };
        });
      } else if (stillOwnsLifecycle) {
        set(
          createHabitErrorUpdate(
            archiveError instanceof Error
              ? archiveError.message
              : "Failed to archive habit",
          ),
        );
      }
      finishHabitMutation(ownership);
      throw archiveError;
    }
  },
  async restoreHabit(id) {
    if (id <= 0 || pendingHabitDeletionIds.has(id)) return;
    await get().restoreHabits([id]);
  },
  async restoreHabits(ids) {
    const uniqueIds = [...new Set(ids)].filter(
      (id) => id > 0 && !pendingHabitDeletionIds.has(id),
    );
    if (uniqueIds.length === 0) return;
    const restoredIds = new Set(uniqueIds);
    const stateBefore = get();
    const targets = stateBefore.allHabits.filter(
      (habit) => restoredIds.has(habit.id) && habit.isArchived,
    );
    if (targets.length === 0) return;
    const now = new Date();
    const ownershipById = new Map(
      targets.map((habit) => [
        habit.id,
        beginHabitMutation(habit.id, ["existence", "lifecycle", "metadata"]),
      ]),
    );
    const restoredById = new Map(
      targets.map((habit) => [
        habit.id,
        {
          ...habit,
          isArchived: false,
          archivedAt: null,
          archiveHistory: closeArchivePeriod(
            habit.archiveHistory,
            now.getTime(),
            habit.archivedAt,
          ),
          updatedAt: now.getTime(),
        } satisfies Habit,
      ]),
    );
    const nextAllHabits = stateBefore.allHabits
      .map((habit) => restoredById.get(habit.id) ?? habit)
      .sort(
        (left, right) =>
          left.displayOrder - right.displayOrder || left.id - right.id,
      );
    const nextActiveHabits = nextAllHabits.filter((habit) => !habit.isArchived);
    invalidateViewModelCachesForChange("lifecycle");
    set({ habits: nextActiveHabits, allHabits: nextAllHabits });
    await persistenceCommitScheduler.waitForCommitOpportunity();
    const writeSequence = ownershipById.values().next().value?.writeSequence;
    if (
      writeSequence == null ||
      !(await waitForHabitPersistenceTurn(writeSequence))
    ) {
      for (const ownership of ownershipById.values()) {
        finishHabitMutation(ownership);
      }
      return;
    }
    const targetsToPersist = targets.filter((target) => {
      const ownership = ownershipById.get(target.id)!;
      return (
        shouldPersistHabitMutation(ownership, "existence") &&
        shouldPersistHabitMutation(ownership, "lifecycle")
      );
    });
    if (targetsToPersist.length === 0) {
      for (const ownership of ownershipById.values()) {
        finishHabitMutation(ownership);
      }
      return;
    }
    try {
      const persistedById = await habitPersistence.restoreHabits(
        targetsToPersist.map((target) => target.id),
        now.getTime(),
      );
      let publishedLifecycle = false;
      let confirmedActiveHabits = get().habits;
      set((state) => {
        let habits = state.habits;
        let allHabits = state.allHabits;
        for (const [id, ownership] of ownershipById) {
          if (
            !isLatestHabitMutation(ownership, "existence") ||
            !isLatestHabitMutation(ownership, "lifecycle")
          ) {
            continue;
          }
          publishedLifecycle = true;
          const authoritative = persistedById.get(id);
          if (!authoritative) {
            habits = habits.filter((habit) => habit.id !== id);
            allHabits = allHabits.filter((habit) => habit.id !== id);
            continue;
          }
          const current =
            allHabits.find((habit) => habit.id === id) ?? authoritative;
          const reconciledHabit = applyOwnedHabitFields(
            current,
            ownership,
            authoritative,
          );
          ({ habits, allHabits } = upsertHabitInCollections(
            habits,
            allHabits,
            reconciledHabit,
          ));
        }
        confirmedActiveHabits = habits;
        if (habits === state.habits && allHabits === state.allHabits) {
          return state;
        }
        invalidateViewModelCachesForChange("lifecycle");
        return { habits, allHabits };
      });
      for (const ownership of ownershipById.values()) {
        finishHabitMutation(ownership);
      }
      if (publishedLifecycle) {
        scheduleHabitRemindersSync(confirmedActiveHabits);
      }
    } catch (restoreError) {
      const authoritativeById = new Map<number, Habit | null>();
      await Promise.all(
        targets.map(async (target) => {
          const ownership = ownershipById.get(target.id)!;
          if (
            !isLatestHabitMutation(ownership, "existence") ||
            !isLatestHabitMutation(ownership, "lifecycle")
          ) {
            return;
          }
          try {
            authoritativeById.set(
              target.id,
              await queryHabitModelById(target.id),
            );
          } catch {
            authoritativeById.set(target.id, target);
          }
        }),
      );
      let publishedError = false;
      set((state) => {
        let habits = state.habits;
        let allHabits = state.allHabits;
        for (const [id, ownership] of ownershipById) {
          if (
            !isLatestHabitMutation(ownership, "existence") ||
            !isLatestHabitMutation(ownership, "lifecycle")
          ) {
            continue;
          }
          publishedError = true;
          const authoritative = authoritativeById.get(id);
          if (!authoritative) {
            habits = habits.filter((habit) => habit.id !== id);
            allHabits = allHabits.filter((habit) => habit.id !== id);
            continue;
          }
          const current =
            allHabits.find((habit) => habit.id === id) ?? authoritative;
          const reconciledHabit = applyOwnedHabitFields(
            current,
            ownership,
            authoritative,
          );
          ({ habits, allHabits } = upsertHabitInCollections(
            habits,
            allHabits,
            reconciledHabit,
          ));
        }
        if (!publishedError) return state;
        if (habits !== state.habits || allHabits !== state.allHabits) {
          invalidateViewModelCachesForChange("lifecycle");
        }
        return {
          habits,
          allHabits,
          ...(publishedError
            ? createHabitErrorUpdate(
                restoreError instanceof Error
                  ? restoreError.message
                  : "Failed to restore habits",
              )
            : null),
        };
      });
      for (const ownership of ownershipById.values()) {
        finishHabitMutation(ownership);
      }
      throw restoreError;
    }
  },
  async deleteHabit(id) {
    if (id <= 0) return;
    await get().deleteHabits([id]);
  },
  async deleteHabits(ids) {
    const deletedIds = new Set(
      ids.filter((id) => id > 0 && !pendingHabitDeletionIds.has(id)),
    );
    if (deletedIds.size === 0) return;
    const deletionOwnershipById = new Map(
      [...deletedIds].map((id) => [
        id,
        beginHabitMutation(id, ALL_HABIT_MUTATION_SCOPES),
      ]),
    );
    for (const id of deletedIds) {
      pendingHabitDeletionIds.add(id);
      invalidateNotesProjection(id);
    }
    deletedHabitTombstones.add(deletedIds);
    const stateBefore = get();
    const overlaysBefore = new Map(dayRecordOverlays);
    const knownRecords = [
      ...stateBefore.allDayRecords,
      ...stateBefore.dayRecords,
      ...Object.values(stateBefore.dayRecordsByDate).flat(),
    ];
    const invalidatedDayMutations = new Map<string, number>();
    for (const record of knownRecords) {
      if (deletedIds.has(record.habitId)) {
        const key = dayRecordOverlayKey(record.habitId, record.date);
        if (invalidatedDayMutations.has(key)) continue;
        const mutation = beginDayMutation(record.habitId, record.date);
        invalidatedDayMutations.set(mutation.key, mutation.mutationId);
        dayRecordOverlays.set(mutation.key, null);
      }
    }
    for (const key of dayRecordOverlays.keys()) {
      if (invalidatedDayMutations.has(key)) continue;
      const separatorIndex = key.indexOf("|");
      if (separatorIndex < 0) continue;
      const habitId = Number(key.slice(0, separatorIndex));
      if (!deletedIds.has(habitId)) continue;
      const mutation = beginDayMutation(habitId, key.slice(separatorIndex + 1));
      invalidatedDayMutations.set(mutation.key, mutation.mutationId);
      dayRecordOverlays.set(key, null);
    }
    let nextActiveHabits: Habit[] = [];
    invalidateViewModelCachesForChange("existence");
    set((state) => {
      const nextDayRecordsByDate: Record<string, DayRecord[]> = {};
      for (const [date, records] of Object.entries(state.dayRecordsByDate)) {
        nextDayRecordsByDate[date] = records.filter(
          (record) => !deletedIds.has(record.habitId),
        );
      }
      const nextAllDayRecords = state.allDayRecords.filter(
        (record) => !deletedIds.has(record.habitId),
      );
      const nextCurrentDayRecords = state.dayRecords.filter(
        (record) => !deletedIds.has(record.habitId),
      );
      const nextGlobalDateCache: Record<string, DayRecord[]> = {};
      for (const [date, records] of Object.entries(allDayRecordsByDateCache)) {
        nextGlobalDateCache[date] = records.filter(
          (record) => !deletedIds.has(record.habitId),
        );
      }
      allDayRecordsByDateCache = nextGlobalDateCache;
      nextActiveHabits = state.habits.filter(
        (habit) => !deletedIds.has(habit.id),
      );
      return {
        habits: nextActiveHabits,
        allHabits: state.allHabits.filter((habit) => !deletedIds.has(habit.id)),
        dayRecordsByDate: nextDayRecordsByDate,
        dayRecords: nextCurrentDayRecords,
        allDayRecords: nextAllDayRecords,
      };
    });
    await persistenceCommitScheduler.waitForCommitOpportunity();
    const writeSequence = deletionOwnershipById.values().next()
      .value?.writeSequence;
    if (
      writeSequence == null ||
      !(await waitForHabitPersistenceTurn(writeSequence))
    ) {
      for (const [key, mutationId] of invalidatedDayMutations) {
        if (isLatestDayMutation(key, mutationId)) {
          dayRecordOverlays.delete(key);
        }
        finishDayMutation(key, mutationId);
      }
      for (const id of deletedIds) {
        pendingHabitDeletionIds.delete(id);
      }
      deletedHabitTombstones.discard(deletedIds);
      for (const ownership of deletionOwnershipById.values()) {
        finishHabitMutation(ownership);
      }
      return;
    }
    try {
      const deletedIdList = [...deletedIds];
      await habitPersistence.deleteHabits(deletedIdList);
      publishDeletedHabitDescriptionLines(deletedIds);
      clearDayRecordOverlaysForHabits(deletedIds);
      for (const [key, mutationId] of invalidatedDayMutations) {
        finishDayMutation(key, mutationId);
      }
      for (const id of deletedIds) pendingHabitDeletionIds.delete(id);
      deletedHabitTombstones.retireWhenReadersSettle(deletedIds);
      for (const ownership of deletionOwnershipById.values()) {
        finishHabitMutation(ownership);
      }
      scheduleHabitRemindersSync(get().habits);
    } catch (deleteError) {
      for (const [key, mutationId] of invalidatedDayMutations) {
        if (isLatestDayMutation(key, mutationId)) {
          const previousOverlay = overlaysBefore.get(key);
          if (previousOverlay === undefined) dayRecordOverlays.delete(key);
          else dayRecordOverlays.set(key, previousOverlay);
        }
        finishDayMutation(key, mutationId);
      }
      const authoritativeById = new Map<number, Habit | null>();
      const authoritativeRecordsById = new Map<number, DayRecord[]>();
      await Promise.all(
        [...deletedIds].map(async (id) => {
          const ownership = deletionOwnershipById.get(id)!;
          if (!isLatestHabitMutation(ownership, "existence")) return;
          try {
            const [habit, records] = await Promise.all([
              queryHabitModelById(id),
              queryHabitDayRecordModels(id),
            ]);
            authoritativeById.set(id, habit);
            authoritativeRecordsById.set(id, records);
          } catch {
            authoritativeById.set(
              id,
              stateBefore.allHabits.find((habit) => habit.id === id) ??
                stateBefore.habits.find((habit) => habit.id === id) ??
                null,
            );
            authoritativeRecordsById.set(
              id,
              stateBefore.allDayRecords.filter(
                (record) => record.habitId === id,
              ),
            );
          }
        }),
      );
      for (const [date, records] of Object.entries(allDayRecordsByDateCache)) {
        let reconciled = records;
        for (const [id, authoritativeRecords] of authoritativeRecordsById) {
          const ownership = deletionOwnershipById.get(id)!;
          if (!isLatestHabitMutation(ownership, "existence")) continue;
          const byDate = new Map(
            authoritativeRecords.map((record) => [record.date, record]),
          );
          reconciled = replaceHabitRecordsForDate(reconciled, id, date, byDate);
        }
        allDayRecordsByDateCache[date] = reconciled;
      }
      let publishedError = false;
      invalidateViewModelCachesForChange("existence");
      set((state) => {
        let habits = state.habits;
        let allHabits = state.allHabits;
        let allDayRecords = state.allDayRecords;
        let dayRecords = state.dayRecords;
        const dayRecordsByDate = { ...state.dayRecordsByDate };
        for (const [id, ownership] of deletionOwnershipById) {
          if (!isLatestHabitMutation(ownership, "existence")) continue;
          publishedError = true;
          const authoritativeHabit = authoritativeById.get(id);
          if (authoritativeHabit) {
            ({ habits, allHabits } = upsertHabitInCollections(
              habits,
              allHabits,
              authoritativeHabit,
            ));
          } else {
            habits = habits.filter((habit) => habit.id !== id);
            allHabits = allHabits.filter((habit) => habit.id !== id);
          }
          const authoritativeRecords = authoritativeRecordsById.get(id) ?? [];
          allDayRecords = replaceAllHabitRecords(
            allDayRecords,
            id,
            authoritativeRecords,
          );
          const byDate = new Map(
            authoritativeRecords.map((record) => [record.date, record]),
          );
          if (state.currentDayRecordsDate) {
            dayRecords = replaceHabitRecordsForDate(
              dayRecords,
              id,
              state.currentDayRecordsDate,
              byDate,
            );
          }
          for (const [date, records] of Object.entries(dayRecordsByDate)) {
            dayRecordsByDate[date] = replaceHabitRecordsForDate(
              records,
              id,
              date,
              byDate,
            );
          }
        }
        return {
          habits,
          allHabits,
          dayRecordsByDate,
          dayRecords,
          allDayRecords,
          ...(publishedError
            ? createHabitErrorUpdate(
                deleteError instanceof Error
                  ? deleteError.message
                  : "Failed to delete habits",
              )
            : null),
        };
      });
      for (const id of deletedIds) pendingHabitDeletionIds.delete(id);
      deletedHabitTombstones.discard(deletedIds);
      for (const ownership of deletionOwnershipById.values()) {
        finishHabitMutation(ownership);
      }
      throw deleteError;
    }
  },
  async markDay(habitId, date, status, reason) {
    if (habitId <= 0 || pendingHabitDeletionIds.has(habitId)) return false;
    if (date > format(new Date(), "yyyy-MM-dd")) return false;
    const stateBefore = get();
    const habit = ensureHabitByIdMap(stateBefore.habits).get(habitId);
    if (!habit) return false;
    if (!isHabitTrackingActiveOnDate(habit, date)) return false;
    if (
      !stateBefore.allDayRecordsLoaded &&
      isCompletionLedIntervalScheduleForDate(
        habit.repeatSchedule,
        habit.startDate,
        date,
        habit.scheduleHistory,
      )
    ) {
      return false;
    }
    const habitRecords = getHabitDayRecordsForState(stateBefore, habitId);
    if (
      !isHabitScheduledForDate(
        habit.repeatSchedule,
        habit.startDate,
        date,
        habitRecords,
        habit.scheduleHistory,
      )
    ) {
      return false;
    }
    const now = new Date();
    const nowTs = now.getTime();
    const optimisticId = -nowTs;
    const existingGlobal = habitRecords.find((record) => record.date === date);
    const baseList = resolveDayRecordsForDate(stateBefore, date);
    const existingLocal = baseList.find((r) => r.habitId === habitId);
    const existingRecord = existingLocal ?? existingGlobal;
    const optimisticRecord: DayRecord = existingRecord
      ? { ...existingRecord, status, updatedAt: nowTs }
      : {
          id: optimisticId,
          habitId,
          date,
          status,
          createdAt: nowTs,
          updatedAt: nowTs,
        };
    const optimisticHabitRecords = projectHabitDayRecordsForDate(
      habitRecords,
      date,
      optimisticRecord,
    );
    const {
      key: overlayKey,
      mutationId,
      writeSequence,
    } = beginDayMutation(habitId, date);
    dayRecordOverlays.set(overlayKey, optimisticRecord);
    const optimisticList = existingLocal
      ? baseList.map((r) => (r.habitId === habitId ? optimisticRecord : r))
      : [...baseList, optimisticRecord];
    (() =>
      set((state) => {
        const nextAll = existingGlobal
          ? state.allDayRecords.map((r) =>
              r.habitId === habitId && r.date === date ? optimisticRecord : r,
            )
          : [...state.allDayRecords, optimisticRecord];
        advanceRecordsByHabitCacheForDayMutation(
          state.allDayRecords,
          nextAll,
          habitId,
          date,
          optimisticRecord,
        );
        advanceScheduledIdsCacheForHabit(
          state.habits,
          state.allDayRecords,
          nextAll,
          habitId,
          optimisticHabitRecords,
        );
        advanceStreakCacheForHabit(
          state.habits,
          state.allDayRecords,
          nextAll,
          habitId,
          optimisticHabitRecords,
        );
        advanceDayListSnapshotCacheForDayMutation({
          habits: state.habits,
          previousAllRecords: state.allDayRecords,
          nextAllRecords: nextAll,
          habitId,
          changedDate: date,
          changedDateRecords: optimisticList,
        });
        allDayRecordsByDateCache[date] = optimisticList;
        return {
          dayRecordsByDate: mergeHotDayRecordsByDate({
            prevMap: state.dayRecordsByDate,
            updates: { [date]: optimisticList },
            pinnedDates: [state.currentDayRecordsDate, date],
          }),
          dayRecords:
            state.currentDayRecordsDate === date
              ? optimisticList
              : state.dayRecords,
          allDayRecords: nextAll,
        };
      }))();
    await persistenceCommitScheduler.waitForCommitOpportunity();
    if (!(await waitForHabitPersistenceTurn(writeSequence))) {
      if (isLatestDayMutation(overlayKey, mutationId)) {
        dayRecordOverlays.delete(overlayKey);
      }
      finishDayMutation(overlayKey, mutationId);
      return false;
    }
    if (!shouldPersistDayMutation(overlayKey, mutationId, writeSequence)) {
      return true;
    }
    try {
      let persisted!: DayRecord;
      const reasonText = normalizePersistedDayReason(status, reason);
      if (reasonText != null) {
        invalidateNotesProjection(habitId);
      }
      persisted = await habitPersistence.markDay({
        habitId,
        date,
        status,
        reason: reasonText ?? undefined,
        now: nowTs,
      });
      if (!isLatestDayMutation(overlayKey, mutationId)) return true;
      invalidatePendingDayRecordReads();
      dayRecordOverlays.set(overlayKey, persisted);
      const optimisticMatchesPersisted =
        optimisticRecord.habitId === persisted.habitId &&
        optimisticRecord.date === persisted.date &&
        optimisticRecord.status === persisted.status &&
        optimisticRecord.createdAt === persisted.createdAt &&
        optimisticRecord.updatedAt === persisted.updatedAt;
      if (optimisticMatchesPersisted) {
        // SQL identity does not change the logical record or its presentation.
        // Keep the accepted immutable object and every derived snapshot intact.
        dayRecordOverlays.delete(overlayKey);
        finishDayMutation(overlayKey, mutationId);
        scheduleHabitReminderAfterRecordChange(get().habits, habitId);
        return true;
      }
      (() =>
        set((state) => {
          const currentHabitRecords = getHabitDayRecordsForState(
            state,
            habitId,
          );
          const normalizedHabitRecords = projectHabitDayRecordsForDate(
            currentHabitRecords,
            date,
            persisted,
          );
          const currentDateList = state.dayRecordsByDate[date] ?? [];
          const normalizedDateList = currentDateList.some(
            (r) => r.habitId === habitId,
          )
            ? currentDateList.map((r) =>
                r.habitId === habitId ? persisted : r,
              )
            : [...currentDateList, persisted];
          const normalizedAll = state.allDayRecords.some(
            (r) => r.habitId === habitId && r.date === date,
          )
            ? state.allDayRecords.map((r) =>
                r.habitId === habitId && r.date === date ? persisted : r,
              )
            : [...state.allDayRecords, persisted];
          advanceRecordsByHabitCacheForDayMutation(
            state.allDayRecords,
            normalizedAll,
            habitId,
            date,
            persisted,
          );
          advanceScheduledIdsCacheForHabit(
            state.habits,
            state.allDayRecords,
            normalizedAll,
            habitId,
            normalizedHabitRecords,
          );
          advanceStreakCacheForHabit(
            state.habits,
            state.allDayRecords,
            normalizedAll,
            habitId,
            normalizedHabitRecords,
          );
          advanceDayListSnapshotCacheForDayMutation({
            habits: state.habits,
            previousAllRecords: state.allDayRecords,
            nextAllRecords: normalizedAll,
            habitId,
            changedDate: date,
            changedDateRecords: normalizedDateList,
          });
          allDayRecordsByDateCache[date] = normalizedDateList;
          return {
            dayRecordsByDate: mergeHotDayRecordsByDate({
              prevMap: state.dayRecordsByDate,
              updates: { [date]: normalizedDateList },
              pinnedDates: [state.currentDayRecordsDate, date],
            }),
            dayRecords:
              state.currentDayRecordsDate === date
                ? normalizedDateList
                : state.dayRecords,
            allDayRecords: normalizedAll,
          };
        }))();
      dayRecordOverlays.delete(overlayKey);
      finishDayMutation(overlayKey, mutationId);
      scheduleHabitReminderAfterRecordChange(get().habits, habitId);
      return true;
    } catch (e) {
      if (!isLatestDayMutation(overlayKey, mutationId)) return true;
      dayRecordOverlays.delete(overlayKey);
      const repaired = await repairFailedDayMutation(
        habitId,
        date,
        overlayKey,
        mutationId,
      );
      const ownedFailure =
        repaired && isLatestDayMutation(overlayKey, mutationId);
      if (ownedFailure) {
        set(
          createHabitErrorUpdate(
            e instanceof Error ? e.message : "Failed to mark day",
          ),
        );
        scheduleHabitReminderAfterRecordChange(get().habits, habitId);
      }
      finishDayMutation(overlayKey, mutationId);
      // A superseded write may already have reached SQLite before this latest
      // intent failed. Reconcile once from the authoritative database state;
      // the reminder coordinator coalesces adjacent repairs for this habit.
      return !ownedFailure;
    }
  },
  async unmarkDay(habitId, date) {
    if (habitId <= 0 || pendingHabitDeletionIds.has(habitId)) return false;
    const stateBefore = get();
    const habit = ensureHabitByIdMap(stateBefore.habits).get(habitId);
    if (!habit || !isHabitTrackingActiveOnDate(habit, date)) return false;
    if (
      !stateBefore.allDayRecordsLoaded &&
      isCompletionLedIntervalScheduleForDate(
        habit.repeatSchedule,
        habit.startDate,
        date,
        habit.scheduleHistory,
      )
    ) {
      return false;
    }
    const baseList = resolveDayRecordsForDate(stateBefore, date);
    const optimisticList = baseList.filter((r) => r.habitId !== habitId);
    const habitRecords = getHabitDayRecordsForState(stateBefore, habitId);
    const optimisticHabitRecords = projectHabitDayRecordsForDate(
      habitRecords,
      date,
      null,
    );
    const {
      key: overlayKey,
      mutationId,
      writeSequence,
    } = beginDayMutation(habitId, date);
    dayRecordOverlays.set(overlayKey, null);
    (() =>
      set((state) => {
        const nextAll = state.allDayRecords.filter(
          (r) => !(r.habitId === habitId && r.date === date),
        );
        advanceRecordsByHabitCacheForDayMutation(
          state.allDayRecords,
          nextAll,
          habitId,
          date,
          null,
        );
        advanceScheduledIdsCacheForHabit(
          state.habits,
          state.allDayRecords,
          nextAll,
          habitId,
          optimisticHabitRecords,
        );
        advanceStreakCacheForHabit(
          state.habits,
          state.allDayRecords,
          nextAll,
          habitId,
          optimisticHabitRecords,
        );
        advanceDayListSnapshotCacheForDayMutation({
          habits: state.habits,
          previousAllRecords: state.allDayRecords,
          nextAllRecords: nextAll,
          habitId,
          changedDate: date,
          changedDateRecords: optimisticList,
        });
        allDayRecordsByDateCache[date] = optimisticList;
        return {
          dayRecordsByDate: mergeHotDayRecordsByDate({
            prevMap: state.dayRecordsByDate,
            updates: { [date]: optimisticList },
            pinnedDates: [state.currentDayRecordsDate, date],
          }),
          dayRecords:
            state.currentDayRecordsDate === date
              ? optimisticList
              : state.dayRecords,
          allDayRecords: nextAll,
        };
      }))();
    await persistenceCommitScheduler.waitForCommitOpportunity();
    if (!(await waitForHabitPersistenceTurn(writeSequence))) {
      if (isLatestDayMutation(overlayKey, mutationId)) {
        dayRecordOverlays.delete(overlayKey);
      }
      finishDayMutation(overlayKey, mutationId);
      return false;
    }
    if (!shouldPersistDayMutation(overlayKey, mutationId, writeSequence)) {
      return true;
    }
    try {
      await habitPersistence.unmarkDay(habitId, date);
      if (!isLatestDayMutation(overlayKey, mutationId)) return true;
      invalidatePendingDayRecordReads();
      dayRecordOverlays.delete(overlayKey);
      finishDayMutation(overlayKey, mutationId);
      scheduleHabitReminderAfterRecordChange(get().habits, habitId);
      return true;
    } catch (e) {
      if (!isLatestDayMutation(overlayKey, mutationId)) return true;
      dayRecordOverlays.delete(overlayKey);
      const repaired = await repairFailedDayMutation(
        habitId,
        date,
        overlayKey,
        mutationId,
      );
      const ownedFailure =
        repaired && isLatestDayMutation(overlayKey, mutationId);
      if (ownedFailure) {
        set(
          createHabitErrorUpdate(
            e instanceof Error ? e.message : "Failed to unmark day",
          ),
        );
        scheduleHabitReminderAfterRecordChange(get().habits, habitId);
      }
      finishDayMutation(overlayKey, mutationId);
      // See markDay: the failed latest intent can reveal an older persisted
      // result whose reminder repair was intentionally skipped as superseded.
      return !ownedFailure;
    }
  },
  resetInMemoryCaches() {
    dataCacheEpoch += 1;
    pendingOptimisticHabitIds.clear();
    pendingHabitDeletionIds.clear();
    deletedHabitTombstones.clear();
    latestHabitMutationIds.clear();
    latestDayMutationIds.clear();
    habitsLoadInFlight = null;
    allDayRecordsLoadInFlight = null;
    resetDerivedCaches();
    clearHabitDescriptionLinesCache();
    invalidateAllNotesProjections();
    set({
      habits: [],
      allHabits: [],
      allHabitsLoaded: false,
      dayRecords: [],
      currentDayRecordsDate: null,
      dayRecordsByDate: {},
      allDayRecords: [],
      allDayRecordsLoaded: false,
      isLoading: false,
      error: null,
    });
  },
  refreshComputedData() {
    // A local-day rollover changes the meaning of "current streak" and every
    // day-list snapshot that embeds it, but it does not invalidate persisted
    // day rows. In particular, keep the by-date history cache, hot window,
    // in-flight reads and optimistic overlays intact: clearing those here can
    // turn an already-loaded date into an empty slice and lets an older SELECT
    // overwrite a still-pending mark.
    invalidateViewModelCaches(["day-list", "streaks"]);
    set((state) => ({ dayRecordsByDate: { ...state.dayRecordsByDate } }));
  },
  clearError(expectedRevision) {
    let cleared = false;
    set((state) => {
      if (
        !canConsumeHabitStoreError(
          state.error,
          state.errorRevision,
          expectedRevision,
        )
      ) {
        return state;
      }
      cleared = true;
      return { error: null };
    });
    return cleared;
  },
}));
// Register each accepted mutation with the shared durable write fence.
const habitActions = useHabitStore.getState();
useHabitStore.setState({
  createHabit: withPendingHabitWriteTracking(habitActions.createHabit),
  updateHabit: withPendingHabitWriteTracking(habitActions.updateHabit),
  renameHabit: withPendingHabitWriteTracking(habitActions.renameHabit),
  reorderHabits: withPendingHabitWriteTracking(habitActions.reorderHabits),
  archiveHabit: withPendingHabitWriteTracking(habitActions.archiveHabit),
  restoreHabit: withPendingHabitWriteTracking(habitActions.restoreHabit),
  restoreHabits: withPendingHabitWriteTracking(habitActions.restoreHabits),
  deleteHabit: withPendingHabitWriteTracking(habitActions.deleteHabit),
  deleteHabits: withPendingHabitWriteTracking(habitActions.deleteHabits),
  markDay: withPendingHabitWriteTracking(habitActions.markDay),
  unmarkDay: withPendingHabitWriteTracking(habitActions.unmarkDay),
});
