export interface HomeSnapshotComparable<TDayRecords = unknown> {
  habits: unknown;
  allHabitsLoaded: boolean;
  allDayRecords: unknown;
  allDayRecordsLoaded: boolean;
  dayRecords: unknown;
  currentDayRecordsDate: string | null;
  dayRecordsByDate: Record<string, TDayRecords>;
  isLoading: boolean;
  error: unknown;
  errorRevision: number;
}

export interface HomeSnapshotController<
  TSnapshot extends HomeSnapshotComparable,
> {
  getSnapshot(publishVisibleFacts: boolean): TSnapshot;
  reconcile(current: TSnapshot, publishVisibleFacts: boolean): boolean;
  getDayRecordsWitness(
    date: string,
  ): TSnapshot["dayRecordsByDate"][string] | undefined;
}

export function homeSnapshotChanged<T extends HomeSnapshotComparable>(
  previous: T,
  current: T,
): boolean {
  if (
    previous.habits !== current.habits ||
    previous.allHabitsLoaded !== current.allHabitsLoaded ||
    previous.allDayRecords !== current.allDayRecords ||
    previous.allDayRecordsLoaded !== current.allDayRecordsLoaded ||
    previous.dayRecords !== current.dayRecords ||
    previous.currentDayRecordsDate !== current.currentDayRecordsDate ||
    previous.isLoading !== current.isLoading ||
    previous.error !== current.error ||
    previous.errorRevision !== current.errorRevision
  ) {
    return true;
  }

  const visibleDate = current.currentDayRecordsDate;
  return (
    visibleDate != null &&
    previous.dayRecordsByDate[visibleDate] !==
      current.dayRecordsByDate[visibleDate]
  );
}

/**
 * Keeps the latest Home facts while another route covers Home without asking
 * React Native to rebuild an invisible native tree. A focus render reads the
 * latest coherent snapshot directly. Neighbour-date cache fills remain an
 * imperative witness and do not rebuild the large list by themselves.
 */
export function createHomeSnapshotController<
  TSnapshot extends HomeSnapshotComparable,
>(initialSnapshot: TSnapshot): HomeSnapshotController<TSnapshot> {
  let latestSnapshot = initialSnapshot;
  let publishedSnapshot = initialSnapshot;
  let latestDayRecordsByDate = initialSnapshot.dayRecordsByDate;

  return {
    getSnapshot: (publishVisibleFacts) =>
      publishVisibleFacts ? latestSnapshot : publishedSnapshot,
    reconcile(current, publishVisibleFacts) {
      latestDayRecordsByDate = current.dayRecordsByDate;
      if (homeSnapshotChanged(latestSnapshot, current)) {
        latestSnapshot = current;
      }
      if (!publishVisibleFacts) return false;
      if (!homeSnapshotChanged(publishedSnapshot, latestSnapshot)) {
        publishedSnapshot = latestSnapshot;
        return false;
      }
      publishedSnapshot = latestSnapshot;
      return true;
    },
    getDayRecordsWitness(date) {
      return Object.prototype.hasOwnProperty.call(latestDayRecordsByDate, date)
        ? (latestDayRecordsByDate[
            date
          ] as TSnapshot["dayRecordsByDate"][string])
        : undefined;
    },
  };
}
