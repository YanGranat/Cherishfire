const MIN_MONTH_DATE = 1;
const MAX_MONTH_DATE = 31;
const SELECTED_SNAPSHOT_BIT = 1;
const CAN_TOGGLE_SNAPSHOT_BIT = 2;
type DateListener = () => void;
export interface MonthlyDateToggleResult {
  changed: boolean;
  selected: boolean;
}
export interface MonthlyDateDraftStore {
  getCellSnapshot: (date: number) => number;
  getDates: () => number[];
  isSelected: (date: number) => boolean;
  subscribeDate: (date: number, listener: DateListener) => () => void;
  toggleDate: (date: number) => MonthlyDateToggleResult;
}
function isValidMonthDate(date: number): boolean {
  return (
    Number.isInteger(date) && date >= MIN_MONTH_DATE && date <= MAX_MONTH_DATE
  );
}
export function isMonthlyDateSelected(snapshot: number): boolean {
  return (snapshot & SELECTED_SNAPSHOT_BIT) !== 0;
}
export function canToggleMonthlyDate(snapshot: number): boolean {
  return (snapshot & CAN_TOGGLE_SNAPSHOT_BIT) !== 0;
}
/**
 * Owns the monthly repeat draft while its sheet is mounted.
 *
 * Each date cell subscribes only to its own primitive snapshot. A toggle
 * therefore updates the tapped cell and, only at the 1 <-> 2 boundary, the
 * other selected cell whose disabled state also changes. The RepeatSheet and
 * the other 29/30 cells stay outside the update path.
 */
export function createMonthlyDateDraftStore(
  initialDates: readonly number[],
): MonthlyDateDraftStore {
  const normalizedInitialDates = initialDates.filter(isValidMonthDate);
  const selectedDates = new Set(
    normalizedInitialDates.length > 0
      ? normalizedInitialDates
      : [MIN_MONTH_DATE],
  );
  const listenersByDate = new Map<number, Set<DateListener>>();
  const getCellSnapshot = (date: number): number => {
    const selected = selectedDates.has(date);
    const canToggle = !selected || selectedDates.size > 1;
    return (
      (selected ? SELECTED_SNAPSHOT_BIT : 0) |
      (canToggle ? CAN_TOGGLE_SNAPSHOT_BIT : 0)
    );
  };
  const notifyDates = (dates: Iterable<number>) => {
    for (const date of dates) {
      const listeners = listenersByDate.get(date);
      if (!listeners) continue;
      for (const listener of [...listeners]) {
        listener();
      }
    }
  };
  const subscribeDate = (date: number, listener: DateListener) => {
    let listeners = listenersByDate.get(date);
    if (!listeners) {
      listeners = new Set<DateListener>();
      listenersByDate.set(date, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        listenersByDate.delete(date);
      }
    };
  };
  const toggleDate = (date: number): MonthlyDateToggleResult => {
    if (!isValidMonthDate(date)) {
      return { changed: false, selected: false };
    }
    const wasSelected = selectedDates.has(date);
    if (wasSelected && selectedDates.size === 1) {
      return { changed: false, selected: true };
    }
    const affectedDates = [date];
    if (wasSelected) {
      selectedDates.delete(date);
      if (selectedDates.size === 1) {
        affectedDates.push(selectedDates.values().next().value as number);
      }
    } else {
      if (selectedDates.size === 1) {
        affectedDates.push(selectedDates.values().next().value as number);
      }
      selectedDates.add(date);
    }
    notifyDates(affectedDates);
    return { changed: true, selected: !wasSelected };
  };
  return {
    getCellSnapshot,
    getDates: () => [...selectedDates],
    isSelected: (date) => selectedDates.has(date),
    subscribeDate,
    toggleDate,
  };
}
