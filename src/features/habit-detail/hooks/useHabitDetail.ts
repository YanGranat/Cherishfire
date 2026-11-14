import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { habitDetailQueries } from "@/composition/habits";
import { areRepeatSchedulesEqual } from "@/types/habit";
import { calculateStreakStats } from "@/domain/habits/streak";
import {
  peekStreakStats,
  rememberStreakStats,
} from "@/application/statistics/streak-cache";
import {
  getHabitDayRecordsForState,
  useHabitStore,
} from "@/stores/habit-store";
import type { Habit, DayRecord, DayStatus } from "@/types/habit";
import { useCurrentLocalDate } from "@/hooks/useCurrentLocalDate";
import { planHabitScheduleEdit } from "@/domain/habits/schedule-edit";
interface LocalSchedulePreview {
  habit: Habit;
  records: DayRecord[];
}
function dayRecordsHaveSameVisibleState(
  left: readonly DayRecord[],
  right: readonly DayRecord[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const rightByKey = new Map(
    right.map((record) => [`${record.habitId}|${record.date}`, record]),
  );
  return left.every((record) => {
    const other = rightByKey.get(`${record.habitId}|${record.date}`);
    return (
      other != null &&
      other.habitId === record.habitId &&
      other.date === record.date &&
      other.status === record.status &&
      other.createdAt === record.createdAt &&
      other.updatedAt === record.updatedAt
    );
  });
}
function habitsHaveSameVisibleState(
  left: Habit | null,
  right: Habit | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.description !== right.description ||
    left.descriptionVisible !== right.descriptionVisible ||
    left.startDate !== right.startDate ||
    left.reminderEnabled !== right.reminderEnabled ||
    left.reminderTime !== right.reminderTime ||
    left.displayOrder !== right.displayOrder ||
    left.isArchived !== right.isArchived ||
    left.archivedAt !== right.archivedAt ||
    !areRepeatSchedulesEqual(left.repeatSchedule, right.repeatSchedule)
  ) {
    return false;
  }
  const leftArchive = left.archiveHistory;
  const rightArchive = right.archiveHistory;
  if (leftArchive.length !== rightArchive.length) return false;
  for (let index = 0; index < leftArchive.length; index += 1) {
    const a = leftArchive[index];
    const b = rightArchive[index];
    if (
      a.archivedAt !== b.archivedAt ||
      a.restoredAt !== b.restoredAt ||
      a.archivedDate !== b.archivedDate ||
      a.restoredDate !== b.restoredDate
    ) {
      return false;
    }
  }
  const leftSchedule = left.scheduleHistory ?? [];
  const rightSchedule = right.scheduleHistory ?? [];
  if (leftSchedule.length !== rightSchedule.length) return false;
  for (let index = 0; index < leftSchedule.length; index += 1) {
    const a = leftSchedule[index];
    const b = rightSchedule[index];
    if (
      a.effectiveFrom !== b.effectiveFrom ||
      a.startDate !== b.startDate ||
      !areRepeatSchedulesEqual(a.repeatSchedule, b.repeatSchedule)
    ) {
      return false;
    }
  }
  return true;
}
// Load a single habit by ID with all day records and computed stats.
export function useHabitDetail(habitId: number) {
  const todayDate = useCurrentLocalDate();
  const cachedHabit = useHabitStore(
    (s) =>
      s.allHabits.find((h) => h.id === habitId) ??
      s.habits.find((h) => h.id === habitId) ??
      null,
  );
  const cachedHabitRecords = useHabitStore((state) =>
    getHabitDayRecordsForState(state, habitId),
  );
  const allDayRecordsLoaded = useHabitStore((s) => s.allDayRecordsLoaded);
  const [storedHabit, setStoredHabit] = useState<Habit | null>(cachedHabit);
  const [fallbackRecords, setFallbackRecords] = useState<DayRecord[]>(() =>
    allDayRecordsLoaded ? cachedHabitRecords : [],
  );
  const [authoritativeRecords, setAuthoritativeRecords] = useState<
    DayRecord[] | null
  >(null);
  const storedRecords =
    authoritativeRecords ??
    (allDayRecordsLoaded ? cachedHabitRecords : fallbackRecords);
  const [schedulePreview, setSchedulePreview] =
    useState<LocalSchedulePreview | null>(null);
  const schedulePreviewRef = useRef(schedulePreview);
  schedulePreviewRef.current = schedulePreview;
  const habit = schedulePreview?.habit ?? storedHabit;
  const records = schedulePreview?.records ?? storedRecords;
  const [isLoading, setIsLoading] = useState(
    cachedHabit == null || !allDayRecordsLoaded,
  );
  const [error, setError] = useState<string | null>(null);
  const [resolvedContentHabitId, setResolvedContentHabitId] = useState<
    number | null
  >(() => (cachedHabit && allDayRecordsLoaded ? habitId : null));
  const mountedRef = useRef(true);
  const loadRequestTokenRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestTokenRef.current += 1;
    };
  }, []);
  const load = useCallback(
    async (showLoading = true, forceDatabase = false) => {
      const requestToken = loadRequestTokenRef.current + 1;
      loadRequestTokenRef.current = requestToken;
      const isLatestLiveRequest = () =>
        mountedRef.current && loadRequestTokenRef.current === requestToken;
      if (showLoading) {
        setIsLoading(true);
      }
      if (!forceDatabase) setAuthoritativeRecords(null);
      setError(null);
      try {
        let storeState = useHabitStore.getState();
        let storeHabit =
          storeState.allHabits.find((candidate) => candidate.id === habitId) ??
          storeState.habits.find((candidate) => candidate.id === habitId) ??
          null;
        let storeRecords = storeState.allDayRecordsLoaded
          ? getHabitDayRecordsForState(storeState, habitId)
          : null;
        if (!forceDatabase && storeHabit && storeRecords) {
          setStoredHabit(storeHabit);
          setResolvedContentHabitId(habitId);
          return;
        }
        if (!forceDatabase) {
          // A direct/deep link can mount detail before Home has hydrated the
          // process-wide store. Detail mutations, schedule validation and
          // reminder replacement all use that store, so a private local DB
          // fallback would render an interactive screen whose writes are then
          // rejected. Hydrate the two authoritative global projections first.
          const [habitsReady, recordsReady] = await Promise.all([
            storeState.allHabitsLoaded
              ? Promise.resolve(true)
              : storeState.loadHabits({ publishError: false }),
            storeState.allDayRecordsLoaded
              ? Promise.resolve(true)
              : storeState.loadAllDayRecords({ publishError: false }),
          ]);
          if (!isLatestLiveRequest()) {
            return;
          }
          if (!habitsReady || !recordsReady) {
            throw new Error("HabitDetailGlobalStoreHydrationFailed");
          }
          storeState = useHabitStore.getState();
          storeHabit =
            storeState.allHabits.find(
              (candidate) => candidate.id === habitId,
            ) ??
            storeState.habits.find((candidate) => candidate.id === habitId) ??
            null;
          storeRecords = storeState.allDayRecordsLoaded
            ? getHabitDayRecordsForState(storeState, habitId)
            : null;
          if (!storeHabit) {
            setStoredHabit(null);
            setFallbackRecords([]);
            setResolvedContentHabitId(habitId);
            return;
          }
          if (!storeRecords) {
            throw new Error("HabitDetailGlobalRecordsUnavailable");
          }
          setStoredHabit(storeHabit);
          setResolvedContentHabitId(habitId);
          return;
        }
        const { habit: databaseHabit, dayRecords: databaseRecords } =
          await habitDetailQueries.load({
            habitId,
            includeHabit: true,
            includeDayRecords: true,
          });
        if (!isLatestLiveRequest()) {
          return;
        }
        if (databaseHabit) {
          setStoredHabit(databaseHabit);
        } else {
          setStoredHabit(null);
          setFallbackRecords([]);
          setResolvedContentHabitId(habitId);
          return;
        }
        const mappedRecords: DayRecord[] = databaseRecords ?? [];
        // This private database snapshot is a recovery-only override. Normal
        // direct opens hydrate the process-wide store above so every
        // interactive consumer observes the same source of truth.
        if (forceDatabase) setAuthoritativeRecords(mappedRecords);
        setResolvedContentHabitId(habitId);
      } catch (loadError) {
        if (!isLatestLiveRequest()) {
          return;
        }
        console.error("Failed to load habit details", loadError);
        setError("load-failed");
      } finally {
        if (isLatestLiveRequest()) {
          setIsLoading(false);
        }
      }
    },
    [habitId],
  );
  useEffect(() => {
    // Keep the authoritative store snapshot current underneath a local
    // schedule preview. Do not let an older cache acknowledgement replace a
    // new repeat row while its matching calendar snapshot is still visible.
    setStoredHabit((current) =>
      habitsHaveSameVisibleState(current, cachedHabit) ? current : cachedHabit,
    );
    const preview = schedulePreviewRef.current;
    if (
      !preview ||
      !cachedHabit ||
      !allDayRecordsLoaded ||
      !habitsHaveSameVisibleState(cachedHabit, preview.habit) ||
      !dayRecordsHaveSameVisibleState(cachedHabitRecords, preview.records)
    ) {
      return;
    }
    setSchedulePreview(null);
  }, [allDayRecordsLoaded, cachedHabit, cachedHabitRecords]);
  useEffect(() => {
    // A forced database snapshot is only a recovery bridge. As soon as the
    // global cache changes again, resume using it as the optimistic owner.
    setAuthoritativeRecords(null);
  }, [cachedHabitRecords]);
  useEffect(() => {
    const state = useHabitStore.getState();
    const habitIsCached =
      state.allHabits.some((habit) => habit.id === habitId) ||
      state.habits.some((habit) => habit.id === habitId);
    if (habitIsCached && state.allDayRecordsLoaded) return;
    void load(!habitIsCached);
  }, [allDayRecordsLoaded, cachedHabit, habitId, load]);
  const patchHabit = useCallback((patch: Partial<Habit>) => {
    setStoredHabit((current) =>
      current
        ? (() => {
            const next = { ...current, ...patch, updatedAt: Date.now() };
            return habitsHaveSameVisibleState(current, next) ? current : next;
          })()
        : current,
    );
    setSchedulePreview((current) =>
      current
        ? {
            ...current,
            habit: {
              ...current.habit,
              ...patch,
              updatedAt: Date.now(),
            },
          }
        : current,
    );
  }, []);
  const previewSchedule = useCallback(
    (patch: {
      repeatSchedule?: Habit["repeatSchedule"];
      startDate?: string;
    }) => {
      const currentHabit = schedulePreviewRef.current?.habit ?? storedHabit;
      const currentRecords =
        schedulePreviewRef.current?.records ?? storedRecords;
      if (!currentHabit) return false;
      const plan = planHabitScheduleEdit({
        previousSchedule: currentHabit.repeatSchedule,
        previousStartDate: currentHabit.startDate,
        previousHistory: currentHabit.scheduleHistory,
        records: currentRecords,
        nextSchedule: patch.repeatSchedule,
        nextStartDate: patch.startDate,
        today: todayDate,
      });
      if (!plan.changed) return false;
      const nextPreview: LocalSchedulePreview = {
        habit: {
          ...currentHabit,
          repeatSchedule: plan.repeatSchedule,
          startDate: plan.startDate,
          scheduleHistory: plan.scheduleHistory,
          updatedAt: Date.now(),
        },
        records: plan.keptRecords,
      };
      schedulePreviewRef.current = nextPreview;
      setSchedulePreview(nextPreview);
      return true;
    },
    [storedHabit, storedRecords, todayDate],
  );
  const clearSchedulePreview = useCallback(() => {
    schedulePreviewRef.current = null;
    setSchedulePreview(null);
  }, []);
  const patchDayStatus = useCallback(
    (date: string, status: DayStatus | null) => {
      const updateRecords = (current: DayRecord[]) => {
        const existing = current.find((record) => record.date === date);
        if (status == null) {
          return existing
            ? current.filter((record) => record.date !== date)
            : current;
        }
        const now = Date.now();
        if (existing) {
          if (existing.status === status) return current;
          return current.map((record) =>
            record.date === date
              ? { ...record, status, updatedAt: now }
              : record,
          );
        }
        return [
          ...current,
          {
            id: -now,
            habitId,
            date,
            status,
            createdAt: now,
            updatedAt: now,
          },
        ];
      };
      if (schedulePreviewRef.current) {
        setSchedulePreview((current) => {
          if (!current) return current;
          const next = { ...current, records: updateRecords(current.records) };
          schedulePreviewRef.current = next;
          return next;
        });
        return;
      }
      // Once the global record cache is loaded, markDay/unmarkDay is the sole
      // optimistic owner and updates it synchronously before its first await.
      // The fallback exists only for a directly opened detail screen whose
      // global history has not loaded yet.
      if (useHabitStore.getState().allDayRecordsLoaded) return;
      setFallbackRecords(updateRecords);
    },
    [habitId],
  );
  const repeatSchedule = habit?.repeatSchedule;
  const startDate = habit?.startDate;
  const archiveHistory = habit?.archiveHistory;
  const scheduleHistory = habit?.scheduleHistory;
  const isDataResolved =
    (cachedHabit != null && allDayRecordsLoaded) ||
    resolvedContentHabitId === habitId;
  const isContentReady = error != null || isDataResolved;
  const stats = useMemo(() => {
    if (!isDataResolved) {
      return { current: 0, best: 0, total: 0 };
    }
    if (!repeatSchedule || !startDate || !archiveHistory) {
      return { current: 0, best: 0, total: 0 };
    }
    if (habit) {
      const prepared = peekStreakStats(habit, records, todayDate);
      if (prepared) return prepared;
    }
    return calculateStreakStats(
      records,
      repeatSchedule,
      startDate,
      archiveHistory,
      scheduleHistory,
      todayDate,
    );
  }, [
    archiveHistory,
    habit,
    isDataResolved,
    records,
    repeatSchedule,
    scheduleHistory,
    startDate,
    todayDate,
  ]);
  useEffect(() => {
    if (!habit || !isDataResolved) return;
    // A cold deep link can still calculate the small pure fallback during its
    // first render. Remember that exact result after commit; normal Home →
    // detail navigation already arrives here as a prewarm hit.
    if (peekStreakStats(habit, records, todayDate)) return;
    rememberStreakStats(habit, records, todayDate, stats);
  }, [habit, isDataResolved, records, stats, todayDate]);
  const reload = useCallback(
    (forceDatabase = false) => load(false, forceDatabase),
    [load],
  );
  return {
    habit,
    records,
    stats,
    isLoading,
    isContentReady,
    error,
    reload,
    patchHabit,
    previewSchedule,
    clearSchedulePreview,
    patchDayStatus,
  };
}
