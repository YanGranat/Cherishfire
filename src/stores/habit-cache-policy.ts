export const HABIT_VIEW_MODEL_CACHE_DOMAINS = [
  "day-list",
  "scheduled-ids",
  "habit-index",
  "streaks",
  "records-by-habit",
  "archived-habits",
] as const;

export type HabitViewModelCacheDomain =
  (typeof HABIT_VIEW_MODEL_CACHE_DOMAINS)[number];

export type HabitViewModelChange =
  | "metadata"
  | "ordering"
  | "schedule"
  | "records"
  | "lifecycle"
  | "existence"
  | "reset";

const METADATA_DOMAINS = [
  "day-list",
  "habit-index",
  "archived-habits",
] as const satisfies readonly HabitViewModelCacheDomain[];

const ORDERING_DOMAINS = [
  "day-list",
  "scheduled-ids",
  "habit-index",
  "archived-habits",
] as const satisfies readonly HabitViewModelCacheDomain[];

const SCHEDULE_DOMAINS = [
  "day-list",
  "scheduled-ids",
  "habit-index",
  "streaks",
  "records-by-habit",
  "archived-habits",
] as const satisfies readonly HabitViewModelCacheDomain[];

const RECORD_DOMAINS = [
  "day-list",
  "scheduled-ids",
  "streaks",
  "records-by-habit",
] as const satisfies readonly HabitViewModelCacheDomain[];

const LIFECYCLE_DOMAINS = [
  "day-list",
  "scheduled-ids",
  "habit-index",
  "streaks",
  "archived-habits",
] as const satisfies readonly HabitViewModelCacheDomain[];

/**
 * Defines the semantic inputs of every habit-store view-model cache.
 *
 * Metadata deliberately excludes schedule, streak and record indexes. The
 * store can therefore publish a rename, description or reminder immediately
 * without discarding expensive derived work whose inputs did not change.
 */
export function getHabitViewModelCacheDomainsForChange(
  change: HabitViewModelChange,
): readonly HabitViewModelCacheDomain[] {
  switch (change) {
    case "metadata":
      return METADATA_DOMAINS;
    case "ordering":
      return ORDERING_DOMAINS;
    case "schedule":
      return SCHEDULE_DOMAINS;
    case "records":
      return RECORD_DOMAINS;
    case "lifecycle":
      return LIFECYCLE_DOMAINS;
    case "existence":
    case "reset":
      return HABIT_VIEW_MODEL_CACHE_DOMAINS;
  }
}

/**
 * Moves a still-valid cache to the new immutable-array identity. If its
 * semantic domain changed, or it was already based on another source, the
 * caller must rebuild it lazily instead.
 */
export function transitionCacheSource<T>(params: {
  cachedSource: T | null;
  previousSource: T;
  nextSource: T;
  invalidated: boolean;
}): T | null {
  const { cachedSource, previousSource, nextSource, invalidated } = params;
  if (invalidated) return null;
  return cachedSource === previousSource ? nextSource : cachedSource;
}

/**
 * Prevents a SELECT captured before a durable delete from resurrecting the
 * deleted habit. A committed tombstone retires as soon as every read that
 * could still hold the old row has crossed its publication boundary.
 */
export class HabitDeletionTombstoneRegistry {
  private readonly tombstones = new Set<number>();
  private readonly pendingRetirement = new Set<number>();
  private readonly activeReaders = new Set<number>();
  private nextReaderId = 0;

  add(habitIds: Iterable<number>): void {
    for (const habitId of habitIds) {
      this.tombstones.add(habitId);
      this.pendingRetirement.delete(habitId);
    }
  }

  has(habitId: number): boolean {
    return this.tombstones.has(habitId);
  }

  beginRead(): () => void {
    const readerId = ++this.nextReaderId;
    this.activeReaders.add(readerId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!this.activeReaders.delete(readerId)) return;
      this.retireIfQuiescent();
    };
  }

  retireWhenReadersSettle(habitIds: Iterable<number>): void {
    for (const habitId of habitIds) {
      if (this.tombstones.has(habitId)) {
        this.pendingRetirement.add(habitId);
      }
    }
    this.retireIfQuiescent();
  }

  discard(habitIds: Iterable<number>): void {
    for (const habitId of habitIds) {
      this.pendingRetirement.delete(habitId);
      this.tombstones.delete(habitId);
    }
  }

  clear(): void {
    this.activeReaders.clear();
    this.pendingRetirement.clear();
    this.tombstones.clear();
  }

  private retireIfQuiescent(): void {
    if (this.activeReaders.size > 0) return;
    for (const habitId of this.pendingRetirement) {
      this.tombstones.delete(habitId);
    }
    this.pendingRetirement.clear();
  }
}
