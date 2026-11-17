import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { format, subDays } from "date-fns";
import {
  closeArchivePeriod,
  isDateInArchiveHistory,
  normalizeArchiveHistory,
  startArchivePeriod,
} from "../src/domain/habits/archive-periods";
import { calculateStreakStats } from "../src/domain/habits/streak";
import type { DayRecord, DayStatus } from "../src/types/habit";
import { assignDisplayOrdersAroundArchivedSlots } from "../src/domain/habits/display-order";
import { getArchiveActionGeometry } from "../src/features/archive/utils/action-geometry";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

const timestamp = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day, 12, 0, 0).getTime();

const firstArchive = timestamp(2026, 7, 10);
const firstRestore = timestamp(2026, 7, 13);
const secondArchive = timestamp(2026, 7, 20);

let history = startArchivePeriod([], firstArchive);
assert.equal(isDateInArchiveHistory("2026-07-09", history), false);
assert.equal(isDateInArchiveHistory("2026-07-10", history), true);
assert.equal(isDateInArchiveHistory("2026-07-12", history), true);

history = closeArchivePeriod(history, firstRestore);
assert.equal(isDateInArchiveHistory("2026-07-12", history), true);
assert.equal(isDateInArchiveHistory("2026-07-13", history), false);

history = startArchivePeriod(history, secondArchive);
assert.equal(history.length, 2);
assert.equal(isDateInArchiveHistory("2026-07-19", history), false);
assert.equal(isDateInArchiveHistory("2026-07-20", history), true);

const immutableBoundaryHistory = normalizeArchiveHistory([
  {
    archivedAt: timestamp(2026, 7, 11),
    restoredAt: timestamp(2026, 7, 14),
    archivedDate: "2026-07-10",
    restoredDate: "2026-07-13",
  },
]);
assert.equal(
  isDateInArchiveHistory("2026-07-10", immutableBoundaryHistory),
  true,
  "archive logic must use the captured local date instead of reinterpreting a timestamp",
);
assert.equal(
  isDateInArchiveHistory("2026-07-13", immutableBoundaryHistory),
  false,
);

const today = new Date();
const dateAtOffset = (offset: number) =>
  format(subDays(today, Math.abs(offset)), "yyyy-MM-dd");
const record = (id: number, offset: number, status: DayStatus): DayRecord => ({
  id,
  habitId: 1,
  date: dateAtOffset(offset),
  status,
  createdAt: today.getTime(),
  updatedAt: today.getTime(),
});

const closedPeriodStats = calculateStreakStats(
  [record(1, 4, "done"), record(2, 3, "done"), record(3, 0, "done")],
  { type: "daily" },
  dateAtOffset(4),
  [
    {
      archivedAt: subDays(today, 2).getTime(),
      restoredAt: today.getTime(),
    },
  ],
);
assert.deepEqual(closedPeriodStats, { current: 1, best: 2, total: 3 });

const openPeriodStats = calculateStreakStats(
  [record(1, 2, "done"), record(2, 1, "done")],
  { type: "daily" },
  dateAtOffset(2),
  [{ archivedAt: today.getTime(), restoredAt: null }],
);
assert.deepEqual(openPeriodStats, { current: 0, best: 2, total: 2 });

const skippedDayStats = calculateStreakStats(
  [record(1, 2, "done"), record(2, 1, "skipped"), record(3, 0, "done")],
  { type: "daily" },
  dateAtOffset(2),
  [],
);
assert.deepEqual(skippedDayStats, { current: 2, best: 2, total: 2 });

assert.deepEqual(
  assignDisplayOrdersAroundArchivedSlots(
    [4, 1, 3],
    [{ id: 2, displayOrder: 1 }],
  ),
  {
    active: [
      { id: 4, displayOrder: 0 },
      { id: 1, displayOrder: 2 },
      { id: 3, displayOrder: 3 },
    ],
    archived: [{ id: 2, displayOrder: 1 }],
  },
  "active reordering must leave an archived habit's old slot reserved",
);
assert.deepEqual(
  assignDisplayOrdersAroundArchivedSlots(
    [1, 2],
    [
      { id: 8, displayOrder: 1 },
      { id: 9, displayOrder: 1 },
    ],
  ),
  {
    active: [
      { id: 1, displayOrder: 0 },
      { id: 2, displayOrder: 3 },
    ],
    archived: [
      { id: 8, displayOrder: 1 },
      { id: 9, displayOrder: 2 },
    ],
  },
  "legacy duplicate archived slots must be normalized without collisions",
);

const root = resolve(import.meta.dirname, "..");
const dbClient = readFileSync(resolve(root, "src/db/client.ts"), "utf8");
const migration = readFileSync(
  resolve(root, "drizzle/0000_lonely_victor_mancha.sql"),
  "utf8",
);
const store = readFileSync(resolve(root, "src/stores/habit-store.ts"), "utf8");
const habitPersistence = readFileSync(
  resolve(root, "src/application/habits/habit-persistence.ts"),
  "utf8",
);
const habitRepository = readFileSync(
  resolve(root, "src/data/sqlite/habit-repository.ts"),
  "utf8",
);
const detail = readFileSync(resolve(root, "app/habit/[id].tsx"), "utf8");
const archiveScreen = readFileSync(resolve(root, "app/archive.tsx"), "utf8");
const homeScreen = readFileSync(resolve(root, "app/index.tsx"), "utf8");
const archiveCard = readFileSync(
  resolve(root, "src/features/archive/components/ArchiveCard.tsx"),
  "utf8",
);
const header = readFileSync(
  resolve(root, "src/components/layout/Header.tsx"),
  "utf8",
);
const monthCalendar = readFileSync(
  resolve(root, "src/features/habit-detail/components/MonthCalendar.tsx"),
  "utf8",
);

assert.match(dbClient, /PRAGMA foreign_keys = ON/);
assert.match(migration, /`archive_history` text DEFAULT '\[\]' NOT NULL/);
assert.match(
  migration,
  /REFERENCES `habits`\(`id`\) ON UPDATE no action ON DELETE cascade/g,
);
assert.match(store, /restoreHabits\(ids: number\[\]\)/);
assert.match(store, /deleteHabits\(ids: number\[\]\)/);
assert.match(habitPersistence, /assignDisplayOrdersAroundArchivedSlots/);
assert.match(habitRepository, /ORDER BY display_order ASC, id ASC/);
assert.match(detail, /visible=\{isArchived \|\| habit\.descriptionVisible\}/);
assert.match(detail, /archiveHistory=\{habit\.archiveHistory\}/);
assert.match(archiveCard, /openArchivePeriod\?\.archivedDate/);
assert.match(archiveCard, /formatLocalizedDate\(storedArchiveDate, language\)/);
assert.match(
  archiveCard,
  /export const ArchiveCard = React\.memo\(function ArchiveCard/,
  "archive cards must not rerender when only the confirmation dialog changes",
);
assert.match(archiveScreen, /keyExtractor=\{archiveHabitKeyExtractor\}/);
assert.match(archiveScreen, /renderItem=\{renderArchiveHabit\}/);
assert.match(
  archiveCard,
  /isInteractionBlocked: \(\) => boolean;/,
  "archive cards must read the synchronous mutation gate without receiving volatile pending state",
);
assert.equal(
  archiveCard.match(/if \(isInteractionBlocked\(\)\)\s*(?:\{\s*)?return;/g)
    ?.length,
  3,
  "open, delete, and restore presses must all be rejected while a mutation owns the archive",
);
assert.doesNotMatch(
  archiveCard,
  /\bdisabled\??:\s*boolean|disabled=\{/,
  "per-card disabled props would rerender every archived habit for one pending mutation",
);
assert.match(
  archiveCard,
  /className="px-sm py-xs"/,
  "delete label geometry must stay unchanged inside its larger touch container",
);
assert.match(
  archiveCard,
  /className="pl-sm py-xs"/,
  "restore label geometry must stay unchanged inside its larger touch container",
);
assert.match(
  archiveScreen,
  /const isArchiveInteractionBlocked = useCallback\(\s*\(\) => archiveMutationBusyRef\.current,\s*\[\],?\s*\);/,
  "the row interaction gate must remain stable while reading the synchronous global mutation owner",
);
const archiveRenderItem = archiveScreen.slice(
  archiveScreen.indexOf("const renderArchiveHabit = useCallback"),
  archiveScreen.indexOf(
    "const handleDelete = async",
    archiveScreen.indexOf("const renderArchiveHabit = useCallback"),
  ),
);
assert.match(
  archiveRenderItem,
  /isInteractionBlocked=\{isArchiveInteractionBlocked\}/,
);
assert.doesNotMatch(
  archiveRenderItem,
  /archiveListDisabled|pendingHabitId|isApplyingDialogAction|disabled=\{/,
  "pending one archive mutation must not change props of every memoized card",
);
assert.doesNotMatch(
  archiveScreen,
  /ARCHIVE_LIST_MUTATION_PENDING_STYLE|style=\{\s*archiveListDisabled\s*\?/,
  "one archive mutation must not flash or dim every archived card",
);
assert.match(
  archiveScreen,
  /contentContainerStyle=\{ARCHIVE_LIST_CONTENT_STYLE\}/,
  "the FlatList content style must keep stable identity across dialog and pending renders",
);
const archiveListMarkup = archiveScreen.slice(
  archiveScreen.indexOf("<FlatList"),
  archiveScreen.indexOf("/>", archiveScreen.indexOf("<FlatList")) + 2,
);
assert.match(
  archiveListMarkup,
  /pointerEvents={archiveListDisabled \? "box-only" : "auto"}/,
  "the native list surface must keep its own scroll responder while blocking every child press target",
);
assert.match(
  archiveListMarkup,
  /accessibilityElementsHidden={archiveListDisabled}/,
  "blocked archive actions must leave the accessibility tree with the list surface",
);
assert.match(
  archiveListMarkup,
  /importantForAccessibility={[\s\S]*?archiveListDisabled \? "no-hide-descendants" : "auto"[\s\S]*?}/,
  "Android accessibility must not expose actions that cannot currently run",
);
assert.doesNotMatch(
  archiveListMarkup,
  /scrollEnabled=/,
  "blocking row presses must not explicitly disable FlatList scrolling",
);
assert.equal(
  archiveScreen.match(/disabled: archiveListDisabled,/g)?.length,
  2,
  "both archive header actions must be natively disabled during any archive mutation",
);
assert.equal(
  archiveScreen
    .slice(archiveScreen.indexOf("const headerActions"))
    .match(/if \(archiveMutationBusyRef\.current\)\s*\{\s*return;/g)?.length,
  2,
  "both header actions must reject a rapid tap while the mutation owner is busy",
);
assert.match(
  homeScreen,
  /const suppressLayoutAnimations =\s*suppressInitialLayoutAnimations\s*\|\|\s*isLayoutEpochSwitchFrame\s*\|\|\s*isDateEpochSnapLock;/,
  "Home layout suppression must be owned only by reactive, self-clearing geometry epochs",
);
assert.doesNotMatch(
  homeScreen,
  /const suppressLayoutAnimations =[\s\S]{0,320}homeFocusedRef\.current/,
  "a focus ref must not own rendered Home gesture admission because ref writes cannot publish an unlock render",
);
assert.match(header, /disabled\?: boolean;/);
assert.match(header, /disabled=\{action\.disabled\}/);
assert.match(
  header,
  /accessibilityState=\{\{ disabled: action\.disabled === true \}\}/,
  "header controls must publish their disabled state to accessibility services",
);
assert.match(
  archiveScreen,
  /setDeleteDialog\(\{\s*\.\.\.currentDialog,\s*visible: false\s*,?\s*\}\)/,
  "closing a bulk dialog must retain its content throughout the fade",
);
assert.match(
  archiveScreen,
  /setDeleteDialog\(\(currentDialog\) => \(\{[\s\S]{0,120}\.\.\.currentDialog,[\s\S]{0,120}visible: false/,
  "cancelling a dialog must retain its content throughout the fade",
);
assert.doesNotMatch(
  archiveScreen,
  /setDeleteDialog\(\{\s*visible: false,\s*type: "single"/,
  "dialog content must not switch to the single-delete copy before its fade ends",
);
const restoreHandler = archiveScreen.slice(
  archiveScreen.indexOf("const handleRestore = useCallback"),
  archiveScreen.indexOf(
    "const handleDeleteRequest",
    archiveScreen.indexOf("const handleRestore = useCallback"),
  ),
);
assert.doesNotMatch(
  restoreHandler,
  /archivedHabits\.length/,
  "removing one item must not recreate the restore callback for every remaining card",
);
assert.match(
  restoreHandler,
  /if \(archiveMutationBusyRef\.current\)[\s\S]{0,600}archiveMutationBusyRef\.current = true;[\s\S]{0,1800}archiveMutationBusyRef\.current = false;/,
  "restore must synchronously reject a second mutation before React pending state commits",
);
const confirmationHandler = archiveScreen.slice(
  archiveScreen.indexOf("const confirmAction = async"),
  archiveScreen.indexOf(
    "const headerActions",
    archiveScreen.indexOf("const confirmAction = async"),
  ),
);
assert.match(
  confirmationHandler,
  /if \(archiveMutationBusyRef\.current\)[\s\S]{0,600}archiveMutationBusyRef\.current = true;[\s\S]{0,3200}archiveMutationBusyRef\.current = false;/,
  "archive confirmation must not enqueue twice on a rapid double tap",
);
assert.match(
  archiveScreen,
  /const isLoading = !allHabitsLoaded && loadError == null;/,
  "a terminal archive load error must replace the spinner and expose Retry",
);
assert.match(
  monthCalendar,
  /const currentMonthRef = useRef\(currentMonth\);/,
  "the calendar must own a synchronous month intent",
);
assert.match(
  monthCalendar,
  /subMonths\(currentMonthRef\.current, 1\)/,
  "rapid previous-month taps must use the synchronous intent",
);
assert.match(
  monthCalendar,
  /addMonths\(currentMonthRef\.current, 1\)/,
  "rapid month taps must derive from the latest synchronous intent, not a render closure",
);

const restoreStoreFlow = store.slice(
  store.indexOf("async restoreHabits(ids)"),
  store.indexOf(
    "async deleteHabit(id)",
    store.indexOf("async restoreHabits(ids)"),
  ),
);
const restoreOptimisticIndex = restoreStoreFlow.indexOf(
  "set({ habits: nextActiveHabits, allHabits: nextAllHabits });",
);
const restorePersistenceIndex = restoreStoreFlow.indexOf(
  "await persistenceCommitScheduler.waitForCommitOpportunity();",
);
assert.ok(
  restoreOptimisticIndex >= 0 &&
    restorePersistenceIndex >= 0 &&
    restoreOptimisticIndex < restorePersistenceIndex,
  "restore must remove archived items optimistically before persistence",
);
assert.match(
  restoreStoreFlow,
  /catch \(restoreError\)[\s\S]*queryHabitModelById[\s\S]*throw restoreError;/,
  "restore failure must republish authoritative rows and propagate the error to archive UI",
);

const deleteStoreFlow = store.slice(
  store.indexOf("async deleteHabits(ids)"),
  store.indexOf("async markDay(", store.indexOf("async deleteHabits(ids)")),
);
const deleteOptimisticIndex = deleteStoreFlow.indexOf("set((state) => {");
const deletePersistenceIndex = deleteStoreFlow.indexOf(
  "await persistenceCommitScheduler.waitForCommitOpportunity();",
);
assert.ok(
  deleteOptimisticIndex >= 0 &&
    deletePersistenceIndex >= 0 &&
    deleteOptimisticIndex < deletePersistenceIndex,
  "delete must remove rows and dependent records optimistically before persistence",
);
assert.match(
  deleteStoreFlow,
  /catch \(deleteError\)[\s\S]*queryHabitModelById[\s\S]*authoritativeRecordsById[\s\S]*throw deleteError;/,
  "delete failure must restore authoritative habits and records before surfacing the error",
);

type ControlElement = { type: string; props: Record<string, any> };
function archiveElements(tree: unknown, predicate: (node: ControlElement) => boolean): ControlElement[] {
  if (Array.isArray(tree)) return tree.flatMap((node) => archiveElements(node, predicate));
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as ControlElement;
  return [...(predicate(node) ? [node] : []), ...archiveElements(node.props.children, predicate)];
}
function auditArchiveActionTargets(
  source: string,
  geometry = getArchiveActionGeometry,
): void {
  let state: Record<string, number | string> = {};
  let scale = 1;
  let language = "en";
  let blocked = false;
  let measurementRef: { current: unknown } | undefined;
  const calls: string[] = [];
  const jsx = (type: string, props: Record<string, unknown>) => ({ type, props });
  const render = loadSourceCallableForAudit<(props: unknown) => ControlElement>(
    source, "ArchiveCard", {
      exports: {},
      require: () => ({ jsx, jsxs: jsx }),
      React: {
        useRef: (initial: unknown) => measurementRef ??= { current: initial },
        useState: () => [state, (next: (current: typeof state) => typeof state) => { state = next(state); }],
      },
      View: "View", Pressable: "Pressable", Text: "Text", MaterialIcons: "Icon",
      useTranslation: () => ({ t: (key: string) => key }),
      useWindowDimensions: () => ({ fontScale: scale }),
      useVisualLanguage: () => language,
      useVisualEffectiveMode: () => "light",
      formatLocalizedDate: () => "2031-04-06",
      lightTheme: { surfaceElevated: "white" }, radii: { listCard: 10 },
      CARD_BOTTOM_GAP: 11.5, getArchiveActionGeometry: geometry,
    }, true,
  );
  const props = {
    habit: { id: 23, name: "Read a page", archiveHistory: [] },
    onDelete: () => calls.push("delete"), onRestore: () => calls.push("restore"),
    onPress: () => calls.push("open"), isInteractionBlocked: () => blocked,
  };
  const inspect = () => {
    const tree = render(props);
    const row = archiveElements(tree, (node) => node.props.className === "flex-row justify-end")[0];
    const actions = archiveElements(row, (node) => node.type === "Pressable");
    assert.equal(actions.length, 2);
    assert.equal(row.props.style.height, actions[0].props.style.height);
    assert.equal(row.props.style.height, actions[1].props.style.height);
    assert.ok(row.props.style.height >= 44, "the immediate action parent must contain the complete touch height");
    const natural = state.key === `${language}:${scale}`
      ? Math.max(Number(state.delete ?? 17.5 * scale + 8), Number(state.restore ?? 17.5 * scale + 8))
      : 17.5 * scale + 8;
    assert.equal(row.props.style.height + row.props.style.marginTop + row.props.style.marginBottom,
      natural + 8, "expanded touch regions must preserve the card's flow height");
    for (const action of actions) {
      assert.equal(row.props.style.marginTop + action.props.style.paddingTop, 8,
        "the label top must not shift when either action wraps or scales");
    }
    assert.equal(tree.props.style.marginBottom, 11.5);
    return actions;
  };
  let actions = inspect();
  for (const action of actions) {
    let stops = 0;
    action.props.onPress({ stopPropagation: () => stops += 1 });
    assert.equal(stops, 1, "nested actions must stop the card navigation press");
  }
  assert.deepEqual(calls, ["delete", "restore"]);
  blocked = true;
  actions.forEach((action) => action.props.onPress({ stopPropagation() {} }));
  assert.deepEqual(calls, ["delete", "restore"], "the existing mutation gate must still reject both actions");
  const oldMeasurement = actions[0].props.children.props.onLayout;
  oldMeasurement({ nativeEvent: { layout: { height: 52 } } });
  actions = inspect();
  language = "de";
  inspect();
  const beforeLateLayout = state;
  oldMeasurement({ nativeEvent: { layout: { height: 91 } } });
  assert.equal(state, beforeLateLayout, "an old locale layout cannot replace current measurements");
  scale = 1.3;
  actions = inspect();
  actions[1].props.children.props.onLayout({ nativeEvent: { layout: { height: 47 } } });
  inspect();
}
auditArchiveActionTargets(archiveCard);
assert.throws(() => auditArchiveActionTargets(
  archiveCard.replaceAll("if (isInteractionBlocked()) return;", ""),
), /existing mutation gate/);
assert.throws(() => auditArchiveActionTargets(
  archiveCard.replace("event.stopPropagation();", "undefined;"),
), /stop the card navigation/);
assert.throws(() => auditArchiveActionTargets(
  archiveCard,
  loadSourceCallableForAudit<typeof getArchiveActionGeometry>(
    readFileSync(resolve(root, "src/features/archive/utils/action-geometry.ts"), "utf8")
      .replace("marginBottom: -expansion", "marginBottom: 0"),
    "getArchiveActionGeometry", {},
  ),
), /preserve the card's flow height/);
for (const height of [25.5, 30.75, 43, 44, 58, Number.NaN, -1]) {
  const geometry = getArchiveActionGeometry(height);
  const natural = Number.isFinite(height) && height > 0 ? height : 25.5;
  assert.ok(geometry.height >= 44);
  assert.ok(geometry.height >= natural);
  assert.equal(geometry.height + geometry.marginTop + geometry.marginBottom, natural + 8);
}

console.log("Archive audit passed.");
