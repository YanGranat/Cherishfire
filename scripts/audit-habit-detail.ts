import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

import { parseHabitRouteId } from "../src/domain/habits/route-id";
import { resolveHabitDetailPresentationState } from "../src/features/habit-detail/utils/presentation-state";

const root = resolve(__dirname, "..");
const read = (relativePath: string) =>
  readFileSync(resolve(root, relativePath), "utf8");

function assertSourceOrder(
  source: string,
  markers: readonly string[],
  message: string,
): void {
  let previousIndex = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker, previousIndex + 1);
    assert.ok(index > previousIndex, `${message}: missing ${marker}`);
    previousIndex = index;
  }
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source boundary ${start}`);
  assert.ok(endIndex > startIndex, `missing source boundary ${end}`);
  return source.slice(startIndex, endIndex);
}

for (const invalid of [
  undefined,
  null,
  "",
  "0",
  "-1",
  "1.5",
  "1x",
  " 1",
  String(Number.MAX_SAFE_INTEGER + 1),
]) {
  assert.equal(parseHabitRouteId(invalid), null);
}
assert.equal(parseHabitRouteId("1"), 1);
assert.equal(
  parseHabitRouteId(String(Number.MAX_SAFE_INTEGER)),
  Number.MAX_SAFE_INTEGER,
);

assert.equal(
  resolveHabitDetailPresentationState({
    hasHabit: true,
    isContentReady: false,
    hasError: false,
  }),
  "loading",
  "a cached habit without resolved day records must not paint false statistics",
);
assert.equal(
  resolveHabitDetailPresentationState({
    hasHabit: true,
    isContentReady: true,
    hasError: true,
  }),
  "error",
  "a record-load failure must replace the incomplete detail body",
);
assert.equal(
  resolveHabitDetailPresentationState({
    hasHabit: false,
    isContentReady: true,
    hasError: false,
  }),
  "missing",
);
assert.equal(
  resolveHabitDetailPresentationState({
    hasHabit: true,
    isContentReady: true,
    hasError: false,
  }),
  "data",
);

const routeSource = read("app/habit/[id].tsx");
const hookSource = read("src/features/habit-detail/hooks/useHabitDetail.ts");
const descriptionSource = read(
  "src/features/habit-detail/components/InlineDescription.tsx",
);
const menuControllerSource = read(
  "src/features/habit-detail/components/HabitDetailMenuController.tsx",
);
const formOverlayControllerSource = read(
  "src/features/habit-detail/components/HabitDetailFormOverlayController.tsx",
);
const statusOverlayControllerSource = read(
  "src/features/habit-detail/components/HabitDetailStatusOverlayController.tsx",
);

assert.match(
  routeSource,
  /const habitId = parseHabitRouteId\(id\);[\s\S]{0,220}<ResolvedHabitDetailRoute key=\{String\(habitId\)\} habitId=\{habitId\}/,
  "dynamic habit routes must validate and key their complete state owner",
);
assert.match(
  routeSource,
  /function HabitDetailScreenContent\(\{ habitId \}: \{\s*habitId: number;?\s*\}\)/,
  "the stateful detail body must receive its validated owner explicitly",
);
assert.doesNotMatch(
  routeSource,
  /const \[(?:menuVisible|renameVisible|deleteVisible),/,
  "ephemeral menu/dialog visibility must not wake the complete habit-detail owner",
);
assert.match(
  routeSource,
  /menuControllerRef\.current\?\.openMenu\(\)/,
  "the header menu action must delegate directly to the isolated overlay owner",
);
assert.match(
  menuControllerSource,
  /useImperativeHandle\([\s\S]{0,500}openMenu\(\)[\s\S]{0,400}setMenu\(\{ visible: true, mounted: true \}\)/,
  "the isolated overlay owner must publish menu visibility without parent state",
);
assert.match(
  menuControllerSource,
  /setMenu\(\(current\) => \(\{ \.\.\.current, visible: false \}\)\);[\s\S]{0,100}onToggleDescription\(\)/,
  "description changes must begin menu dismissal before waking the detail data tree",
);
assert.match(
  menuControllerSource,
  /const pendingDeleteConfirmRef = useRef\(false\);[\s\S]{0,500}const flushPendingDelete = useCallback\([\s\S]{0,260}pendingDeleteConfirmRef\.current = false;[\s\S]{0,100}onDeleteRef\.current\(\)/,
  "an accepted delete must have one product-owned handoff independent of observer state",
);
assert.match(
  menuControllerSource,
  /useLayoutEffect\([\s\S]{0,80}\(\) => \(\) => \{[\s\S]{0,120}flushPendingDelete\(\)/,
  "controller disposal must flush an accepted delete exactly once",
);
assert.doesNotMatch(
  routeSource,
  /const \[(?:repeatSheetVisible|repeatSheetActionId|datePickerVisible|datePickerActionId|reminderScreenVisible|reminderScreenActionId),/,
  "form-overlay visibility and action identity must not wake the complete habit-detail owner",
);
assert.doesNotMatch(
  routeSource,
  /set(?:RepeatSheetVisible|RepeatSheetActionId|DatePickerVisible|DatePickerActionId|ReminderScreenVisible|ReminderScreenActionId)/,
  "the complete habit-detail owner must not retain a second form-overlay state path",
);
assert.doesNotMatch(
  routeSource,
  /<(?:RepeatSheet|DatePickerModal|ReminderScreen)\b/,
  "form overlays must render only inside their isolated controller",
);
assert.match(
  routeSource,
  /formOverlayControllerRef\.current\?\.openRepeat\(\)[\s\S]{0,260}formOverlayControllerRef\.current\?\.openStartDate\(\)[\s\S]{0,260}formOverlayControllerRef\.current\?\.openReminders\(\)/,
  "all three form rows must delegate directly to the isolated overlay owner",
);
assert.match(
  routeSource,
  /<HabitDetailFormOverlayController[\s\S]{0,120}ref=\{formOverlayControllerRef\}[\s\S]{0,360}onRepeatApply=\{handleRepeatApply\}[\s\S]{0,120}onStartDateConfirm=\{handleStartDateConfirm\}[\s\S]{0,120}onReminderSave=\{handleReminderSave\}/,
  "the detail data owner must expose product commands to exactly one form-overlay controller",
);
assert.match(
  routeSource,
  /const formOverlayStartDate = habit\?\.startDate \?\? "1970-01-01";/,
  "the hidden date overlay must receive the canonical date string without a local Date conversion",
);
assert.match(
  formOverlayControllerSource,
  /const \[session, setSession\] = useState<FormOverlaySession \| null>\(null\);[\s\S]{0,140}const sessionRef = useRef<FormOverlaySession \| null>\(null\);[\s\S]{0,100}const generationRef = useRef\(0\);/,
  "the isolated controller must expose one synchronous owner for every form overlay",
);
assert.doesNotMatch(
  formOverlayControllerSource,
  /const \[(?:repeat|startDateSession|reminder), set(?:Repeat|StartDateSession|Reminder)\]/,
  "repeat, start-date, and reminder overlays must not regain independent visible sessions",
);
assert.match(
  formOverlayControllerSource,
  /generationRef\.current \+= 1;[\s\S]{0,260}kind,[\s\S]{0,120}generation: generationRef\.current,[\s\S]{0,420}sessionRef\.current = next;[\s\S]{0,80}setSession\(next\);/,
  "an accepted form-overlay intent must atomically replace the single visible session",
);
assert.match(
  formOverlayControllerSource,
  /const closeOverlay = useCallback\([\s\S]{0,500}current\.kind !== kind[\s\S]{0,120}current\.generation !== generation[\s\S]{0,120}!current\.visible[\s\S]{0,220}return false;/,
  "a callback from a superseded overlay generation must not close or mutate the current overlay",
);
assert.match(
  formOverlayControllerSource,
  /const MemoizedRepeatSheet = React\.memo\(RepeatSheet\);[\s\S]{0,140}const MemoizedDatePickerModal = React\.memo\(DatePickerModal\);[\s\S]{0,140}const MemoizedReminderScreen = React\.memo\(ReminderScreen\);/,
  "unrelated detail commits must not redraw hidden form portals",
);
assert.match(
  formOverlayControllerSource,
  /const isFocused = useIsFocused\(\);[\s\S]{0,220}const \[datePickerHostWarmed, setDatePickerHostWarmed\] = useState\(false\);/,
  "Habit Detail must own one reusable Android date-host warm state",
);
assert.match(
  formOverlayControllerSource,
  /Platform\.OS !== "android"[\s\S]{0,160}!isFocused[\s\S]{0,240}hasVisibleOverlay[\s\S]{0,240}runAfterUiPaint[\s\S]{0,220}isFocusedRef\.current && !sessionRef\.current\?\.visible/,
  "date prewarm must be guaranteed after the first correct frame and pause while an overlay is visible",
);
assert.doesNotMatch(
  formOverlayControllerSource,
  /setDatePickerHostWarmed\(false\)/,
);
assert.match(
  formOverlayControllerSource,
  /const onStartDateConfirmRef = useRef\(onStartDateConfirm\);[\s\S]{0,520}onStartDateConfirmRef\.current = onStartDateConfirm;/,
  "the date confirmation ref must track the current callback",
);
assertSourceOrder(
  sourceBetween(
    formOverlayControllerSource,
    "const confirmCurrentStartDate",
    "const cancelCurrentStartDate",
  ),
  ["sessionRef.current", "onStartDateConfirmRef.current(date)"],
  "date confirmation must resolve the current session before applying the current callback",
);
assert.match(
  formOverlayControllerSource,
  /onConfirm=\{confirmCurrentStartDate\}[\s\S]{0,100}onCancel=\{cancelCurrentStartDate\}/,
  "a warmed date picker must keep stable confirmation and cancellation callbacks",
);
assert.match(
  formOverlayControllerSource,
  /const shouldPreloadDatePicker =\s*Platform\.OS === "android" && isFocused && datePickerHostWarmed;/,
  "blurred or iOS detail scenes must not retain an Android prewarm portal",
);
assert.match(
  formOverlayControllerSource,
  /\{shouldPreloadDatePicker \|\| session\?\.kind === "start-date" \? \([\s\S]{0,180}preloadOnAndroid=\{shouldPreloadDatePicker\}/,
  "the focus-owned prewarm decision must control the hidden native host",
);
assert.match(
  formOverlayControllerSource,
  /const current = sessionRef\.current;[\s\S]{0,120}current\?\.visible && current\.kind === kind[\s\S]{0,100}return;[\s\S]{0,100}dismissKeyboardForHabitFormOverlay\(\);[\s\S]{0,100}generationRef\.current \+= 1;/,
  "same-kind duplicate opens must preserve the existing overlay while accepted replacements get a new generation",
);
assert.doesNotMatch(
  routeSource,
  /const \[(?:dayMenu|failureDialog),|<(?:CalendarDayMenu|FailureReasonDialog)\b/,
  "calendar status overlay state and portals must not wake the complete habit-detail owner",
);
assert.match(
  routeSource,
  /const controller = statusOverlayControllerRef\.current;[\s\S]{0,260}controller\.openDayMenu\(\{[\s\S]{0,80}date,[\s\S]{0,80}x: pageX,[\s\S]{0,80}y: pageY/,
  "calendar long press must delegate its exact date and geometry to the isolated overlay owner",
);
assert.match(
  routeSource,
  /<HabitDetailStatusOverlayController[\s\S]{0,120}ref=\{statusOverlayControllerRef\}[\s\S]{0,120}onApplyStatus=\{handleDayStatusApply\}/,
  "the detail data owner must expose one product status command to exactly one overlay controller",
);
assert.match(
  statusOverlayControllerSource,
  /const \[dayMenu, setDayMenu\] = useState<DayMenuSession \| null>\(null\);[\s\S]{0,180}useState<FailureDialogSession \| null>\(null\)/,
  "status portals must stay unmounted until their first use",
);
assert.match(
  statusOverlayControllerSource,
  /useImperativeHandle\([\s\S]{0,240}openDayMenu,[\s\S]{0,160}flushPendingCommandBeforeOwnerUnmount/,
  "the isolated status owner must expose open and ordered owner-unmount handoff commands",
);
assert.match(
  statusOverlayControllerSource,
  /new OneShotActionGate\(\)[\s\S]{0,2500}!current\?\.visible \|\| !gate\?\.claim\(\)/,
  "only the first action belonging to a visible status overlay may mutate product state",
);
const dayMenuStatusSource = sourceBetween(
  statusOverlayControllerSource,
  "const applyDayMenuStatus",
  "const submitFailureReason",
);
assertSourceOrder(
  dayMenuStatusSource,
  [
    "publishDayMenu({ ...current, visible: false });",
    "onApplyStatusRef.current({",
  ],
  "a direct calendar status command must begin menu dismissal before waking the detail tree",
);
const reasonSubmissionSource = sourceBetween(
  statusOverlayControllerSource,
  "const submitFailureReason",
  "return (",
);
assertSourceOrder(
  reasonSubmissionSource,
  [
    "pendingFailureSubmissionRef.current = {",
    "publishFailureDialog({ ...current, visible: false });",
  ],
  "a reason command must be captured before the dialog publishes its hidden state",
);
assert.doesNotMatch(
  reasonSubmissionSource,
  /onApplyStatusRef\.current|patchDayStatus|persistDayStatus/,
  "the reason dialog submit turn must not mutate the calendar tree",
);
assert.match(
  statusOverlayControllerSource,
  /<FailureReasonDialog[\s\S]{0,700}onDismiss=\{flushPendingFailureSubmission\}/,
  "accepted reason commands must hand off from the modal's actual native dismissal instead of a guessed frame or timeout",
);
assertSourceOrder(
  statusOverlayControllerSource,
  [
    "flushPendingFailureSubmission();",
    "dayMenuRef.current = null;",
  ],
  "owner unmount must flush an accepted reason command before releasing product refs",
);
assert.match(
  routeSource,
  /useLayoutEffect\([\s\S]{0,80}\(\) => \(\) => \{[\s\S]{0,160}statusOverlayControllerRef\.current\?\.flushPendingCommandBeforeOwnerUnmount\(\)/,
  "route disposal must pull an accepted reason command from the child owner",
);

const repeatControllerApply = sourceBetween(
  formOverlayControllerSource,
  "const applyRepeat",
  "const confirmCurrentStartDate",
);
const startDateControllerApply = sourceBetween(
  formOverlayControllerSource,
  "const confirmCurrentStartDate",
  "const saveReminders",
);
const reminderControllerApply = sourceBetween(
  formOverlayControllerSource,
  "const saveReminders",
  "return (",
);
assertSourceOrder(
  repeatControllerApply,
  ['if (!closeOverlay("repeat", generation))', "onRepeatApply(schedule);"],
  "repeat dismissal must begin before the product update",
);
assertSourceOrder(
  startDateControllerApply,
  [
    'if (!closeOverlay("start-date", current.generation)) {',
    "onStartDateConfirmRef.current(date);",
  ],
  "start-date dismissal must begin before the product update",
);
assertSourceOrder(
  reminderControllerApply,
  [
    'if (!closeOverlay("reminder", generation))',
    "onReminderSave(enabled, time);",
  ],
  "reminder dismissal must begin before the product update",
);

const repeatProductApply = sourceBetween(
  routeSource,
  "const handleRepeatApply",
  "const handleStartDateConfirm",
);
const startDateProductApply = sourceBetween(
  routeSource,
  "const handleStartDateConfirm",
  "const handleReminderSave",
);
const reminderProductApply = sourceBetween(
  routeSource,
  "const handleReminderSave",
  'if (presentationState === "loading")',
);
assertSourceOrder(
  repeatProductApply,
  [
    "const currentHabit = habitRef.current;",
    "if (!currentHabit)",
    "if (currentHabit.isArchived)",
    "areRepeatSchedulesEqual(currentHabit.repeatSchedule, schedule)",
    "previewSchedule({ repeatSchedule: schedule });",
    'runDetailAction("repeat"',
  ],
  "repeat apply must reject stale/archived/no-op input before optimistic state and persistence",
);
assertSourceOrder(
  startDateProductApply,
  [
    "const currentHabit = habitRef.current;",
    "if (!currentHabit)",
    "if (currentHabit.isArchived)",
    "const nextStartDate = date;",
    "nextStartDate === currentHabit.startDate",
    "previewSchedule({ startDate: nextStartDate });",
    'runDetailAction("start-date"',
  ],
  "start-date confirm must reject stale/archived/no-op input before optimistic state and persistence",
);
assertSourceOrder(
  reminderProductApply,
  [
    "const currentHabit = habitRef.current;",
    "if (!currentHabit)",
    "if (currentHabit.isArchived)",
    "const nextEnabled = enabled && Boolean(time);",
    "currentHabit.reminderEnabled === nextEnabled",
    "patchHabit({",
    'runDetailAction("reminder"',
  ],
  "reminder save must reject stale/archived/no-op input before optimistic state and persistence",
);
assert.match(
  repeatProductApply,
  /if \(succeeded \|\| !isLatest\)[\s\S]{0,100}clearSchedulePreview\(\);[\s\S]{0,80}reload\(true\)/,
  "repeat persistence failure must retain the existing rollback and authoritative reload",
);
assert.match(
  startDateProductApply,
  /if \(succeeded \|\| !isLatest\)[\s\S]{0,100}clearSchedulePreview\(\);[\s\S]{0,80}reload\(true\)/,
  "start-date persistence failure must retain the existing rollback and authoritative reload",
);
assert.match(
  reminderProductApply,
  /if \(succeeded \|\| !isLatest\)[\s\S]{0,180}patchHabit\(\{[\s\S]{0,140}reminderEnabled: previousReminderEnabled/,
  "reminder persistence failure must retain the existing point rollback",
);
assert.doesNotMatch(
  routeSource,
  /function HabitDetailScreenContent[\s\S]{0,220}useLocalSearchParams/,
  "the keyed detail body must not independently re-read a reusable route id",
);
assert.match(
  routeSource,
  /setDescriptionRecoveryDraft\(\{[\s\S]{0,120}text,/,
  "a failed description write must return the exact optimistic draft to its editor",
);
assert.match(
  descriptionSource,
  /mergeRecoveredDraft\(/,
  "description rollback must merge without overwriting a newer draft",
);
assert.match(
  descriptionSource,
  /setEditing\(true\)/,
  "description rollback must return to editable state",
);
assert.match(
  descriptionSource,
  /descriptionInputRef\.current\?\.focus\(\)/,
  "description rollback must keep the draft visible and editable",
);
assert.match(
  routeSource,
  /if \(presentationState === "loading"\)[\s\S]{0,1800}if \(presentationState === "error"\)[\s\S]{0,1800}if \(presentationState === "missing" \|\| !habit\)/,
  "loading and error shells must be selected before the full detail body",
);
assert.match(
  hookSource,
  /const isDataResolved =[\s\S]{0,180}resolvedContentHabitId === habitId;[\s\S]{0,100}const isContentReady = error != null \|\| isDataResolved;/,
  "content readiness must distinguish successful record resolution from a terminal error",
);
assert.match(
  hookSource,
  /const stats = useMemo\(\(\) => \{[\s\S]{0,120}if \(!isDataResolved\) \{[\s\S]{0,120}return \{ current: 0, best: 0, total: 0 \};/,
  "unresolved records must not trigger authoritative streak computation",
);
assert.doesNotMatch(
  hookSource,
  /finally \{[\s\S]{0,100}setResolvedContentHabitId/,
  "a failed query must never mark day-record content as successfully resolved",
);
assert.match(
  hookSource,
  /const mountedRef = useRef\(true\);[\s\S]{0,180}const loadRequestTokenRef = useRef\(0\);/,
  "habit-detail loads must have explicit mounted and monotonically increasing request ownership",
);
assert.match(
  hookSource,
  /return \(\) => \{[\s\S]{0,120}mountedRef\.current = false;[\s\S]{0,120}loadRequestTokenRef\.current \+= 1;/,
  "unmount must invalidate the latest load before it can publish state",
);
assert.match(
  hookSource,
  /const requestToken = loadRequestTokenRef\.current \+ 1;[\s\S]{0,120}loadRequestTokenRef\.current = requestToken;[\s\S]{0,180}const isLatestLiveRequest = \(\) =>[\s\S]{0,100}mountedRef\.current && loadRequestTokenRef\.current === requestToken;/,
  "every load must capture a monotonically increasing mounted-owner token",
);
assert.match(
  hookSource,
  /await habitDetailQueries\.load\([\s\S]{0,320}if \(!isLatestLiveRequest\(\)\) \{[\s\S]{0,60}return;/,
  "a stale successful query must stop before publishing any state",
);
assert.match(
  hookSource,
  /catch \(loadError\) \{[\s\S]{0,100}if \(!isLatestLiveRequest\(\)\) \{[\s\S]{0,60}return;/,
  "a stale failed query must not replace the latest screen with an error",
);
assert.match(
  hookSource,
  /finally \{[\s\S]{0,100}if \(isLatestLiveRequest\(\)\) \{[\s\S]{0,100}setIsLoading\(false\);/,
  "only the latest mounted request may clear the loading state",
);

const awaitedQueryIndex = hookSource.indexOf(
  "await habitDetailQueries.load({",
);
const resolvedGuardIndex = hookSource.indexOf(
  "if (!isLatestLiveRequest()) {",
  awaitedQueryIndex,
);
const firstResolvedStateWriteIndex = hookSource.indexOf(
  "setStoredHabit(",
  awaitedQueryIndex,
);
assert.ok(
  awaitedQueryIndex >= 0,
  "the detail query await must remain auditable",
);
assert.ok(
  resolvedGuardIndex > awaitedQueryIndex &&
    resolvedGuardIndex < firstResolvedStateWriteIndex,
  "the latest-live guard must precede every successful post-await state write",
);

const rejectedQueryIndex = hookSource.indexOf("catch (loadError)");
const rejectedGuardIndex = hookSource.indexOf(
  "if (!isLatestLiveRequest()) {",
  rejectedQueryIndex,
);
const rejectedStateWriteIndex = hookSource.indexOf(
  'setError("load-failed")',
  rejectedQueryIndex,
);
assert.ok(rejectedQueryIndex >= 0, "the detail query failure path must exist");
assert.ok(
  rejectedGuardIndex > rejectedQueryIndex &&
    rejectedGuardIndex < rejectedStateWriteIndex,
  "the latest-live guard must precede the post-await error state write",
);

function auditOverlayAdmission(transform: (source: string) => string): void {
  const source = transform(formOverlayControllerSource);

  for (const kind of ["repeat", "start-date", "reminder"]) {
    const sessionRef: {
      current: { kind: string; visible: boolean; generation: number } | null;
    } = { current: null };
    const generationRef = { current: 0 };
    let writes = 0;
    let dismisses = 0;
    const open = loadSourceCallableForAudit<(kind: string) => void>(
      source,
      "openOverlay",
      {
        sessionRef,
        generationRef,
        dismissKeyboardForHabitFormOverlay: () => {
          assert.equal(
            generationRef.current,
            writes,
            "keyboard dismissal must occur after duplicate admission and before generation changes",
          );
          dismisses += 1;
        },
        setSession: () => {
          writes += 1;
        },
      },
    );
    open(kind);
    const original = sessionRef.current;
    open(kind);
    assert.equal(sessionRef.current, original);
    assert.equal(generationRef.current, 1);
    assert.equal(writes, 1);
    assert.equal(
      dismisses,
      1,
      "duplicates must not replace the keyboard transition owner",
    );
    sessionRef.current = { ...sessionRef.current!, visible: false };
    open(kind);
    assert.equal(
      generationRef.current,
      2,
      "hidden sessions must reopen normally",
    );
    assert.equal(sessionRef.current?.kind, kind);
    const replacementKind = kind === "repeat" ? "reminder" : "repeat";
    open(replacementKind);
    assert.equal(
      generationRef.current,
      3,
      "different overlay kinds must replace the session",
    );
    assert.equal(sessionRef.current?.kind, replacementKind);
    assert.equal(writes, 3);
    assert.equal(dismisses, 3);
  }
}

auditOverlayAdmission((source) => source);
for (const [label, transform] of [
  [
    "duplicate branch removed",
    (source: string) =>
      source.replace("current?.visible && current.kind === kind", "false"),
  ],
  [
    "hidden session blocked",
    (source: string) =>
      source.replace(
        "current?.visible && current.kind === kind",
        "current?.kind === kind",
      ),
  ],
  [
    "different kind blocked",
    (source: string) =>
      source.replace(
        "current?.visible && current.kind === kind",
        "current?.visible",
      ),
  ],
  [
    "generation changes before admission",
    (source: string) =>
      source.replace(
        "const current = sessionRef.current;",
        "generationRef.current += 1; const current = sessionRef.current;",
      ),
  ],
  [
    "keyboard dismissal removed",
    (source: string) =>
      source.replace("dismissKeyboardForHabitFormOverlay();", ""),
  ],
  [
    "keyboard dismissal before duplicate admission",
    (source: string) =>
      source.replace(
        "const current = sessionRef.current;",
        "dismissKeyboardForHabitFormOverlay(); const current = sessionRef.current;",
      ),
  ],
  [
    "generation changes before keyboard dismissal",
    (source: string) =>
      source.replace(
        /dismissKeyboardForHabitFormOverlay\(\);\s*generationRef\.current \+= 1;/,
        "generationRef.current += 1; dismissKeyboardForHabitFormOverlay();",
      ),
  ],
] as const) {
  const mutated = transform(formOverlayControllerSource);
  assert.notEqual(
    mutated,
    formOverlayControllerSource,
    `${label}: mutation target must exist`,
  );
  assert.throws(
    () => auditOverlayAdmission(() => mutated),
    { name: "AssertionError" },
    `${label} must violate the product admission contract`,
  );
}

function auditCivilDateConfirmation(route: string, controller: string): void {
  for (const date of [
    "2026-02-28",
    "2024-02-29",
    "2011-12-30",
    "0001-01-01",
    "9999-12-31",
  ]) {
    const effects: string[] = [];
    const projected: string[] = [];
    const persisted: Record<string, unknown>[] = [];
    const habitRef: {
      current: {
        startDate: string;
        repeatSchedule: { type: string };
        isArchived: boolean;
      } | null;
    } = {
      current: {
        startDate: "2026-01-01",
        repeatSchedule: { type: "daily" },
        isArchived: false,
      },
    };
    const product = loadSourceCallableForAudit<(date: string) => void>(
      route,
      "handleStartDateConfirm",
      {
        habitRef,
        habitId: 41,
        previewSchedule: (patch: { startDate: string }) => {
          effects.push("preview");
          projected.push(patch.startDate);
        },
        updateHabit: async (_id: number, patch: Record<string, unknown>) => {
          effects.push("persist");
          persisted.push(patch);
        },
        runDetailAction: (_name: string, operation: () => Promise<void>) =>
          operation().then(() => ({ succeeded: true, isLatest: true })),
        clearSchedulePreview: () => {},
        reload: () => {},
      },
    );
    const sessionRef: {
      current: { kind: string; generation: number; visible: boolean } | null;
    } = {
      current: { kind: "start-date", generation: 7, visible: true },
    };
    const closeOverlay = loadSourceCallableForAudit<
      (kind: string, generation: number) => boolean
    >(controller, "closeOverlay", {
      sessionRef,
      setSession: () => effects.push("close"),
    });
    const callbackRef: { current: (date: string) => void } = {
      current: () => assert.fail("the callback ref must remain live"),
    };
    const confirm = loadSourceCallableForAudit<(date: string) => void>(
      controller,
      "confirmCurrentStartDate",
      {
        sessionRef,
        closeOverlay,
        onStartDateConfirmRef: callbackRef,
      },
    );
    callbackRef.current = product;
    confirm(date);
    assert.deepEqual(
      effects,
      ["close", "preview", "persist"],
      "a date confirmation must dismiss its owner before synchronous preview and persistence",
    );
    assert.deepEqual(
      projected,
      [date],
      "a civil date must reach the visible preview without conversion",
    );
    assert.equal(
      persisted[0].startDate,
      date,
      "a civil date must reach persistence without conversion",
    );
    assert.equal(persisted[0].repeatSchedule, habitRef.current!.repeatSchedule);
    confirm(date);
    assert.equal(
      persisted.length,
      1,
      "a queued callback from a closed session must not repeat persistence",
    );
    sessionRef.current = { kind: "repeat", generation: 8, visible: true };
    confirm(date);
    assert.equal(
      persisted.length,
      1,
      "a callback from another overlay kind must not persist a date",
    );

    product("2026-01-01");
    habitRef.current!.isArchived = true;
    product(date);
    habitRef.current = null;
    product(date);
    assert.equal(
      persisted.length,
      1,
      "unchanged, archived, and missing owners must not write",
    );
    assert.deepEqual(
      projected,
      [date],
      "rejected date commands must not change the preview",
    );
  }
}

auditCivilDateConfirmation(routeSource, formOverlayControllerSource);
for (const [owner, search, replacement] of [
  [
    "route",
    "const nextStartDate = date;",
    'const nextStartDate = "2020-01-01";',
  ],
  [
    "controller",
    "onStartDateConfirmRef.current(date);",
    'onStartDateConfirmRef.current("2020-01-01");',
  ],
  [
    "controller",
    'if (!closeOverlay("start-date", current.generation)) {',
    "if (false) {",
  ],
] as const) {
  const original =
    owner === "route" ? routeSource : formOverlayControllerSource;
  assert.equal(
    original.split(search).length,
    2,
    "a date confirmation mutation must identify one executable target",
  );
  const mutated = original.replace(search, replacement);
  assert.throws(
    () =>
      auditCivilDateConfirmation(
        owner === "route" ? mutated : routeSource,
        owner === "controller" ? mutated : formOverlayControllerSource,
      ),
    { name: "AssertionError" },
    "date mutations must violate value preservation or session admission",
  );
}

console.log(
  "Habit detail audit passed, including overlay admission, civil-date confirmation, and ten mutation guards.",
);
