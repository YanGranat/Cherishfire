import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canToggleMonthlyDate,
  createMonthlyDateDraftStore,
  isMonthlyDateSelected,
} from "../src/features/habit-form/utils/monthly-date-draft";

const repoRoot = resolve(__dirname, "..");
const readSource = (relativePath: string) =>
  readFileSync(resolve(repoRoot, relativePath), "utf8");
const sortedNotifications = (notifications: Map<number, number>) =>
  [...notifications.entries()].sort(([left], [right]) => left - right);

const singleDateDraft = createMonthlyDateDraftStore([12]);
assert.deepEqual(singleDateDraft.getDates(), [12]);
assert.equal(isMonthlyDateSelected(singleDateDraft.getCellSnapshot(12)), true);
assert.equal(canToggleMonthlyDate(singleDateDraft.getCellSnapshot(12)), false);
assert.deepEqual(singleDateDraft.toggleDate(12), {
  changed: false,
  selected: true,
});
assert.deepEqual(singleDateDraft.getDates(), [12]);

const boundaryDraft = createMonthlyDateDraftStore([1]);
const boundaryNotifications = new Map<number, number>();
const boundaryUnsubscribers = Array.from({ length: 31 }, (_, index) => {
  const date = index + 1;
  return boundaryDraft.subscribeDate(date, () => {
    boundaryNotifications.set(date, (boundaryNotifications.get(date) ?? 0) + 1);
  });
});

assert.deepEqual(boundaryDraft.toggleDate(2), {
  changed: true,
  selected: true,
});
assert.deepEqual(boundaryDraft.getDates(), [1, 2]);
assert.deepEqual(sortedNotifications(boundaryNotifications), [
  [1, 1],
  [2, 1],
]);
assert.equal(canToggleMonthlyDate(boundaryDraft.getCellSnapshot(1)), true);

boundaryNotifications.clear();
assert.deepEqual(boundaryDraft.toggleDate(2), {
  changed: true,
  selected: false,
});
assert.deepEqual(boundaryDraft.getDates(), [1]);
assert.deepEqual(sortedNotifications(boundaryNotifications), [
  [1, 1],
  [2, 1],
]);
assert.equal(canToggleMonthlyDate(boundaryDraft.getCellSnapshot(1)), false);
boundaryUnsubscribers.forEach((unsubscribe) => unsubscribe());
boundaryNotifications.clear();
boundaryDraft.toggleDate(2);
assert.deepEqual(sortedNotifications(boundaryNotifications), []);

const wideDraft = createMonthlyDateDraftStore([1, 2, 3]);
const wideNotifications = new Map<number, number>();
const wideUnsubscribers = Array.from({ length: 31 }, (_, index) => {
  const date = index + 1;
  return wideDraft.subscribeDate(date, () => {
    wideNotifications.set(date, (wideNotifications.get(date) ?? 0) + 1);
  });
});
wideDraft.toggleDate(31);
assert.deepEqual(sortedNotifications(wideNotifications), [[31, 1]]);
wideNotifications.clear();
wideDraft.toggleDate(31);
assert.deepEqual(sortedNotifications(wideNotifications), [[31, 1]]);
wideUnsubscribers.forEach((unsubscribe) => unsubscribe());

const rapidDraft = createMonthlyDateDraftStore([1, 2]);
assert.deepEqual(rapidDraft.toggleDate(2), {
  changed: true,
  selected: false,
});
assert.deepEqual(rapidDraft.toggleDate(2), {
  changed: true,
  selected: true,
});
assert.deepEqual(rapidDraft.toggleDate(1), {
  changed: true,
  selected: false,
});
assert.deepEqual(rapidDraft.toggleDate(31), {
  changed: true,
  selected: true,
});
assert.deepEqual(rapidDraft.getDates(), [2, 31]);

const detachedSnapshot = rapidDraft.getDates();
detachedSnapshot.splice(0, detachedSnapshot.length, 7);
assert.deepEqual(rapidDraft.getDates(), [2, 31]);

const normalizedDraft = createMonthlyDateDraftStore([0, 2, 2, 32]);
assert.deepEqual(normalizedDraft.getDates(), [2]);
const fallbackDraft = createMonthlyDateDraftStore([]);
assert.deepEqual(fallbackDraft.getDates(), [1]);
assert.deepEqual(fallbackDraft.toggleDate(32), {
  changed: false,
  selected: false,
});

const repeatSheetSource = readSource(
  "src/features/habit-form/components/RepeatSheet.tsx",
);
const repeatMonthlySource = readSource(
  "src/features/habit-form/components/RepeatMonthlyTab.tsx",
);

assert.match(
  repeatSheetSource,
  /const \[monthlyDateDraft\] = useState\(\(\) =>[\s\S]{0,100}createMonthlyDateDraftStore\(initialDraft\.dates\)/,
);
assert.match(
  repeatSheetSource,
  /dates: monthlyDateDraft\.getDates\(\)\.sort\(\(a, b\) => a - b\)/,
);
assert.match(
  repeatSheetSource,
  /<RepeatMonthlyTab dateDraft=\{monthlyDateDraft\}\s*\/>/,
);
assert.doesNotMatch(repeatSheetSource, /setDates|datesRef|setDraftDates/);
assert.match(repeatMonthlySource, /React\.useSyncExternalStore\(/);
assert.match(repeatMonthlySource, /const RepeatMonthDateCell = React\.memo/);
assert.doesNotMatch(repeatMonthlySource, /selectedDates\.includes/);

console.log("Repeat monthly draft audit passed.");
