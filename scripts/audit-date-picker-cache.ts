import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import { darkTheme, lightTheme, semantic } from "../src/theme/colors";
import { addMonths } from "date-fns/addMonths";
import { eachDayOfInterval } from "date-fns/eachDayOfInterval";
import { endOfMonth } from "date-fns/endOfMonth";
import { format } from "date-fns/format";
import { getDay } from "date-fns/getDay";
import { startOfMonth } from "date-fns/startOfMonth";
import {
  DatePickerMonthModelCache,
  prewarmAdjacentDatePickerMonthModels,
} from "../src/features/habit-form/utils/date-picker-month-model";
import { resolveDatePickerSelectionIntent } from "../src/features/habit-form/utils/date-picker-selection-intent";
import { LANGUAGE_OPTIONS } from "../src/i18n/languages";
import { formatLocalizedDate, getDateFnsLocale } from "../src/utils/date";

const august = new Date(2026, 7, 18, 12);
const cache = new DatePickerMonthModelCache(3);
const firstLookup = cache.getWithStatus(august, "ru");
const augustRu = firstLookup.model;

assert.equal(firstLookup.cacheHit, false);

assert.equal(augustRu.days.length, 31);
assert.equal(
  augustRu.offset,
  5,
  "1 August 2026 is Saturday in a Monday-first grid",
);
assert.equal(augustRu.days[0].dayNumber, 1);
assert.equal(augustRu.days[30].dayNumber, 31);
assert.equal(augustRu.days[0].dateString, "2026-08-01");
assert.ok(Object.isFrozen(augustRu));
assert.ok(Object.isFrozen(augustRu.days));
assert.ok(Object.isFrozen(augustRu.days[0]));
assert.ok(Object.isFrozen(augustRu.gridSlots));
assert.ok(Object.isFrozen(augustRu.gridSlots[0]));
assert.equal(augustRu.gridSlots.length, augustRu.offset + augustRu.days.length);
assert.deepEqual(
  augustRu.gridSlots.map((slot) => slot.key),
  augustRu.gridSlots.map((_, index) => `slot-${index}`),
  "calendar cells must keep position-based keys while the month changes",
);
assert.ok(
  augustRu.gridSlots
    .slice(0, augustRu.offset)
    .every((slot) => slot.day == null),
);
assert.deepEqual(
  augustRu.gridSlots.slice(augustRu.offset).map((slot) => slot.day),
  augustRu.days,
);

assert.strictEqual(
  cache.getWithStatus(new Date(2026, 7, 31, 23, 59), "ru").model,
  augustRu,
  "different days in the same local month must reuse one immutable model",
);
assert.equal(cache.getWithStatus(august, "ru").cacheHit, true);
assert.notStrictEqual(
  cache.get(august, "en"),
  augustRu,
  "language is a semantic cache input",
);
assert.strictEqual(
  cache.get(august, "en-US"),
  cache.get(august, "en"),
  "equivalent supported language tags share the normalized model",
);

const lru = new DatePickerMonthModelCache(2);
const augustFirst = lru.get(august, "ru");
const septemberFirst = lru.get(addMonths(august, 1), "ru");
assert.strictEqual(lru.get(august, "ru"), augustFirst);
lru.get(addMonths(august, 2), "ru");
assert.equal(lru.size, 2, "cache must remain strictly bounded");
assert.notStrictEqual(
  lru.get(addMonths(august, 1), "ru"),
  septemberFirst,
  "a hit must refresh recency so the true least-recently-used month is evicted",
);

const adjacent = new DatePickerMonthModelCache(5);
const current = adjacent.get(august, "pl");
prewarmAdjacentDatePickerMonthModels(august, "pl", adjacent);
assert.equal(adjacent.size, 5);
assert.strictEqual(adjacent.get(august, "pl"), current);
assert.equal(
  adjacent.getWithStatus(addMonths(august, 2), "pl").cacheHit,
  true,
  "rapid second-arrow navigation must stay on a prepared month model",
);

assert.throws(() => new DatePickerMonthModelCache(0), RangeError);

assert.deepEqual(
  resolveDatePickerSelectionIntent("2000-01-10", "2000-01-10", "2000-01-20"),
  { draftChanged: true, publishSelection: true, outcome: "pending" },
  "a new day must wait for its committed visual state",
);
assert.deepEqual(
  resolveDatePickerSelectionIntent("2000-01-20", "2000-01-10", "2000-01-20"),
  { draftChanged: false, publishSelection: true, outcome: "pending" },
  "a repeated tap on an uncommitted day must replace the pending action",
);
assert.deepEqual(
  resolveDatePickerSelectionIntent("2000-01-20", "2000-01-10", "2000-01-10"),
  { draftChanged: true, publishSelection: true, outcome: "stable" },
  "A -> B -> A before commit must settle on the already rendered A frame",
);
assert.deepEqual(
  resolveDatePickerSelectionIntent("2000-01-10", "2000-01-10", "2000-01-10"),
  { draftChanged: false, publishSelection: false, outcome: "unchanged" },
  "tapping the rendered selected day must be an explicit no-op",
);

const root = resolve(import.meta.dirname, "..");
const datePickerSource = readFileSync(
  resolve(root, "src/features/habit-form/components/DatePickerModal.tsx"),
  "utf8",
);
const habitMonthCalendarSource = readFileSync(
  resolve(root, "src/features/habit-detail/components/MonthCalendar.tsx"),
  "utf8",
);
const createHabitSource = readFileSync(resolve(root, "app/create.tsx"), "utf8");
const detailOverlaySource = readFileSync(
  resolve(
    root,
    "src/features/habit-detail/components/HabitDetailFormOverlayController.tsx",
  ),
  "utf8",
);

for (const [owner, source] of [
  ["Create", createHabitSource],
  ["Habit Detail", detailOverlaySource],
] as const) {
  assert.match(
    source,
    /const isFocused = useIsFocused\(\);[\s\S]{0,180}const \[datePickerHostWarmed, setDatePickerHostWarmed\] = useState\(false\);/,
    `${owner} must own one reusable date-picker host warm state`,
  );
  assert.match(
    source,
    /Platform\.OS !== "android"[\s\S]{0,160}!isFocused[\s\S]{0,320}runAfterUiPaint\([\s\S]{0,160}isFocusedRef\.current/,
    `${owner} must guarantee date-host preparation immediately after its first correct frame`,
  );
  assert.doesNotMatch(
    source,
    /setDatePickerHostWarmed\(false\)/,
    `${owner} must not throw away the prepared Android calendar on a temporary blur`,
  );
  assert.match(
    source,
    /const shouldPreloadDatePicker =\s*Platform\.OS === "android" && isFocused && datePickerHostWarmed;/,
    `${owner} must not retain an Android prewarm portal on iOS or behind a blurred route`,
  );
  assert.match(
    source,
    /preloadOnAndroid=\{shouldPreloadDatePicker\}/,
    `${owner} must pass the focus-owned prewarm flag to the native host`,
  );
  assert.match(
    source,
    /const onStartDateConfirmRef = useRef\(onStartDateConfirm\);[\s\S]{0,900}onStartDateConfirmRef\.current = onStartDateConfirm;/,
    `${owner} must keep hidden DatePicker callback identities stable while reading the latest owner through refs`,
  );
  assert.match(
    source,
    /onConfirm=\{confirmCurrentStartDate\}\s*onCancel=\{cancelCurrentStartDate\}/,
    `${owner} must pass stable date callbacks instead of render-local closures`,
  );
}
assert.doesNotMatch(
  datePickerSource,
  /useSyncExternalStore|listenersRef|\.subscribe\(/,
  "day selection must have one owner instead of one external-store subscription per cell",
);
assert.match(
  datePickerSource,
  /function useDatePickerSelectionDraft\([\s\S]{0,900}const \[pickedDate, setPickedDate\] = useState\([\s\S]{0,3000}useLayoutEffect\(\(\) => \{\s*renderedPickedDateRef\.current = pickedDate;/,
  "the single selection owner must publish the selected date witness from its committed layout",
);
assert.match(
  datePickerSource,
  /const renderedPickedDateRef = React\.useRef\(selectedDate\)[\s\S]{0,2400}resolveDatePickerSelectionIntent\(\s*pickedDateRef\.current,\s*renderedPickedDateRef\.current,\s*date,?\s*\)/,
  "rapid day taps must distinguish the latest draft from the committed UI",
);
assert.match(
  datePickerSource,
  /useLayoutEffect\(\(\) => \{\s*renderedPickedDateRef\.current = pickedDate;/,
  "the rendered date witness must advance only from the selection owner's layout effect",
);
assert.match(
  datePickerSource,
  /onConfirm\(selection\.getPickedDate\(\)\)/,
  "confirmation must preserve the latest selected draft without waiting for a render",
);
assert.match(
  datePickerSource,
  /interface DatePickerDayCellProps[\s\S]{0,250}isSelected: boolean[\s\S]{0,300}const DatePickerDayCell = React\.memo[\s\S]{0,1800}backgroundColor: isSelected/,
  "memoized cells must receive a selected boolean so only the old and new cells visually change",
);
assert.match(
  datePickerSource,
  /const DatePickerCalendarPane = React\.memo\([\s\S]{0,700}const \[currentMonth, setCurrentMonth\]/,
  "month state must be isolated to the calendar pane",
);
assert.match(
  datePickerSource,
  /monthModel\.gridSlots\.map\(\(slot\) => \([\s\S]{0,180}key=\{slot\.key\}/,
  "month switches must reuse position-keyed grid cells",
);
assert.doesNotMatch(
  datePickerSource,
  /display:\s*["']none["']|DATE_PICKER_GRID_SLOT_COUNT|length:\s*37/,
  "the optimization must not add hidden cells or a fixed sixth row",
);
assert.match(
  datePickerSource,
  /const previousMonth = subMonths\(toCivilDate\(currentMonthRef\.current\), 1\);\s*const nextMonth\s*=\s*previousMonth\.getUTCFullYear\(\) < 1/,
  "rapid previous-month taps must derive from the latest requested month",
);
assert.match(
  datePickerSource,
  /const followingMonth = addMonths\(toCivilDate\(currentMonthRef\.current\), 1\);\s*const nextMonth\s*=\s*followingMonth\.getUTCFullYear\(\) > 9999/,
  "rapid next-month taps must derive from the latest requested month",
);

assert.match(
  habitMonthCalendarSource,
  /getDatePickerMonthModel\(currentMonth, language\)\.model/,
  "habit detail must reuse the warmed immutable month model on its first frame",
);
assert.doesNotMatch(
  habitMonthCalendarSource,
  /eachDayOfInterval|format\(day,\s*["']yyyy-MM-dd["']\)|formatLocalizedDate\(/,
  "habit detail must not rebuild and relocalize every date during render",
);

const equivalenceCache = new DatePickerMonthModelCache(18);

interface NativeCellFixture {
  type: string;
  props: Record<string, unknown>;
  children: unknown[];
}
type NativeCellJsx = (
  type: string,
  props: Record<string, unknown> | null,
  ...children: unknown[]
) => NativeCellFixture;

function auditPrimitiveCalendarCells(source: string): void {
  const tree = ts.createSourceFile(
    "calendar.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callable: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === "CalendarDayCell" &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      callable = node.initializer.arguments[0]?.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(
    callable,
    "the calendar cell must expose its current render function",
  );
  const wrapExports: { default?: (jsx: NativeCellJsx) => NativeCellJsx } = {};
  const primitiveTypes = ["Pressable", "View", "Text"];
  const wrappedTypes = new Map(
    primitiveTypes.map((type) => [type, `interop-${type}`]),
  );
  const wrapSource = readFileSync(
    resolve(
      root,
      "node_modules/react-native-css-interop/src/runtime/wrap-jsx.ts",
    ),
    "utf8",
  );
  runInNewContext(
    ts.transpileModule(wrapSource, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    {
      exports: wrapExports,
      process: { env: { NODE_ENV: "test" } },
      require: (name: string) => {
        if (name === "./api") return { interopComponents: wrappedTypes };
        assert.equal(name, "./third-party-libs/react-native-safe-area-context");
        return { maybeHijackSafeAreaProvider: (type: string) => type };
      },
    },
  );
  assert.ok(wrapExports.default);
  const jsx = wrapExports.default((type, props, ...children) => ({
    type,
    props: { ...props },
    children,
  }));
  const statusColor = loadSourceCallableForAudit<
    (status: string | null, archived: boolean, dark: boolean) => string
  >(source, "getDayCellColor", { darkTheme, lightTheme, semantic });
  const calls: string[] = [];
  const cell = runInNewContext(
    ts.transpileModule(`(${callable})`, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
      },
    }).outputText,
    {
      React: { createElement: jsx },
      Pressable: "Pressable",
      View: "View",
      Text: "Text",
      getDayCellColor: statusColor,
      borders: { todayIndicator: 0.8 },
    },
  ) as (props: Record<string, unknown>) => NativeCellFixture;
  for (const status of [
    null,
    "done",
    "minimum",
    "maximum",
    "skipped",
    "failure",
  ]) {
    for (const isDark of [false, true]) {
      for (let flags = 0; flags < 64; flags += 1) {
        const [archived, before, future, today, scheduled, disabled] =
          Array.from({ length: 6 }, (_, bit) => Boolean(flags & (1 << bit)));
        const props = {
          dateStr: "2024-02-14",
          dayNumber: 14,
          status,
          isArchivedPeriod: archived,
          isBeforeStart: before,
          isFutureDay: future,
          isTodayDay: today,
          isScheduled: scheduled,
          hasExistingStatus: status != null,
          isInteractionDisabled: disabled,
          isDark,
          accessibilityLabel: "Calendar day",
          emptyCellBg: "#303030",
          emptyCellBorder: "#606060",
          monthTextColor: "#EEEEEE",
          accent: "#FF6600",
          onDayPress: (date: string) => calls.push(date),
          onDayLongPress: (date: string, x: number, y: number) =>
            calls.push(`${date}:${x}:${y}`),
        };
        const outer = cell(props);
        const surface = outer.children[0] as NativeCellFixture;
        const text = surface.children[0] as NativeCellFixture;
        assert.deepEqual(
          [outer.type, surface.type, text.type],
          primitiveTypes,
          "calendar cells must bypass CSS interop for all three primitive hosts",
        );
        assert.ok(
          [outer, surface, text].every((host) => host.props.className == null),
          "primitive calendar cells must not depend on remapped classes",
        );
        const background =
          before || future
            ? "transparent"
            : statusColor(status, archived, isDark);
        const neutral = background === "transparent";
        const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
        assert.deepEqual(
          plain(outer.props.style),
          {
            width: "14.28%",
            height: 38,
            alignItems: "center",
            justifyContent: "center",
          },
          "primitive calendar geometry must preserve the existing dimensions and alignment",
        );
        assert.deepEqual(
          plain(surface.props.style),
          {
            width: "90%",
            height: 34,
            borderRadius: 6,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: neutral ? props.emptyCellBg : background,
            borderWidth: today && neutral ? 0.8 : 0.5,
            borderColor:
              today && neutral ? props.accent : props.emptyCellBorder,
            opacity:
              before || future || (!scheduled && status == null) ? 0.35 : 1,
          },
          "primitive calendar surface must preserve all visual states",
        );
        assert.deepEqual(
          plain(text.props.style),
          {
            fontSize: 14,
            fontWeight: "500",
            color: neutral ? props.monthTextColor : "#FFFFFF",
          },
          "primitive calendar text must preserve its typography and tone",
        );
        assert.equal(text.children[0], 14);
        assert.equal(outer.props.delayLongPress, 180);
        assert.equal(outer.props.disabled, disabled);
        assert.equal(outer.props.accessibilityRole, "button");
        assert.equal(outer.props.accessibilityLabel, props.accessibilityLabel);
        assert.deepEqual(plain(outer.props.accessibilityState), { disabled });
        calls.length = 0;
        (outer.props.onPress as () => void)();
        (outer.props.onLongPress as (event: unknown) => void)({
          nativeEvent: { pageX: 10, pageY: 20 },
        });
        assert.deepEqual(
          calls,
          disabled
            ? []
            : ["2024-02-14", ...(scheduled ? ["2024-02-14:10:20"] : [])],
          "primitive calendar input must retain disabled, schedule and coordinate semantics",
        );
      }
    }
  }
}

auditPrimitiveCalendarCells(habitMonthCalendarSource);
for (const [before, after] of [
  [/<Pressable\s+cssInterop=\{false\}/g, "<Pressable cssInterop={true}"],
  [/<View\s+cssInterop=\{false\}/g, "<View cssInterop={true}"],
  [/<Text\s+cssInterop=\{false\}/g, "<Text cssInterop={true}"],
  [/width: "14.28%",\s*height: 38/g, 'width: "14.28%", height: 39'],
] as const) {
  assert.equal(habitMonthCalendarSource.match(before)?.length, 1);
  assert.throws(
    () =>
      auditPrimitiveCalendarCells(
        habitMonthCalendarSource.replace(before, after),
      ),
    (error: unknown) =>
      error instanceof assert.AssertionError &&
      /calendar cells must bypass|primitive calendar geometry/.test(
        error.message,
      ),
    "calendar primitive mutations must fail the actual JSX routing or geometry contract",
  );
}

for (const { code } of LANGUAGE_OPTIONS) {
  for (const month of [
    new Date(2024, 1, 14, 12), // leap February
    new Date(2026, 0, 1, 12), // year boundary
    new Date(2026, 2, 15, 12), // common DST-transition month
    new Date(2026, 9, 15, 12), // common DST-transition month
    new Date(2026, 11, 31, 12),
  ]) {
    const start = startOfMonth(month);
    const end = endOfMonth(month);
    const expectedDays = eachDayOfInterval({ start, end });
    const model = equivalenceCache.get(month, code);

    assert.equal(model.days.length, expectedDays.length);
    assert.equal(model.offset, getDay(start) === 0 ? 6 : getDay(start) - 1);
    assert.equal(
      model.gridSlots.length,
      model.offset + expectedDays.length,
      "the optimized grid must preserve the exact legacy row count",
    );
    assert.equal(
      Math.ceil(model.gridSlots.length / 7),
      Math.ceil((model.offset + expectedDays.length) / 7),
    );
    model.gridSlots.forEach((slot, index) => {
      assert.equal(slot.key, `slot-${index}`);
      if (index < model.offset) {
        assert.equal(slot.day, null);
      } else {
        assert.strictEqual(slot.day, model.days[index - model.offset]);
      }
    });
    assert.equal(
      model.label,
      format(start, "LLLL yyyy", { locale: getDateFnsLocale(code) }),
    );
    model.days.forEach((dayModel, index) => {
      const expectedDay = expectedDays[index];
      assert.equal(dayModel.dayLabel, format(expectedDay, "d"));
      assert.equal(dayModel.dateString, format(expectedDay, "yyyy-MM-dd"));
      assert.equal(dayModel.dayNumber, expectedDay.getDate());
      assert.equal(
        dayModel.accessibilityLabel,
        formatLocalizedDate(expectedDay, code),
      );
    });
  }
}

for (const timezone of [
  "Pacific/Apia",
  "Africa/Cairo",
  "America/Santiago",
  "UTC",
]) {
  const worker = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      resolve(root, "scripts/fixtures/date-picker-civil-tz-worker.ts"),
    ],
    {
      cwd: root,
      env: { ...process.env, TZ: timezone },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(
    worker.status,
    0,
    `${timezone} civil-date audit failed:\n${worker.stdout}\n${worker.stderr}`,
  );
  assert.match(worker.stdout, /Civil date worker passed:/);
}

console.log(
  "DatePicker month cache audit passed, including four civil-date time zones.",
);
