import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { addMonths } from "date-fns/addMonths";
import { subMonths } from "date-fns/subMonths";
import { format } from "date-fns/format";
import { getDatePickerMonthModel } from "../src/features/habit-form/utils/date-picker-month-model";
import { toCivilDate } from "../src/utils/date";
import { createMonthlyDateDraftStore } from "../src/features/habit-form/utils/monthly-date-draft";
import { darkTheme, lightTheme } from "../src/theme/colors";

interface Element {
  type: unknown;
  props: Record<string, any>;
}

function createRenderFixture() {
  const states: unknown[] = [];
  let index = 0;
  const react = {
    createElement: (type: unknown, props: object | null, ...children: unknown[]) => ({
      type,
      props: { ...props, children },
    }),
    useState: (initial: unknown) => {
      const current = index++;
      if (!(current in states)) states[current] = typeof initial === "function" ? initial() : initial;
      return [states[current], (value: unknown) => {
        states[current] = typeof value === "function" ? value(states[current]) : value;
      }];
    },
    useRef: (value: unknown) => {
      const current = index++;
      return states[current] ?? (states[current] = { current: value });
    },
    useMemo: (callback: () => unknown) => callback(),
    useCallback: (callback: unknown) => callback,
    memo: (component: unknown) => component,
    useEffect: () => {},
    useLayoutEffect: () => {},
  };
  return { react, render: (component: (...args: any[]) => Element, ...args: any[]) => {
    index = 0;
    return component(...args);
  } };
}

function loadRender(source: string, name: string, environment: Record<string, unknown>) {
  const tree = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      expression = ts.factory.updateFunctionDeclaration(node, undefined, node.asteriskToken,
        node.name, node.typeParameters, node.parameters, node.type, node.body);
    } else if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      expression = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(expression, `${name} must have a current source implementation`);
  const text = ts.createPrinter().printNode(ts.EmitHint.Unspecified, expression, tree);
  const compiled = ts.transpileModule(`(${text})`, { fileName: "component.tsx", compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  } }).outputText;
  return runInNewContext(compiled, environment);
}

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node == null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}

function style(value: any): Record<string, any> {
  return Array.isArray(value) ? Object.assign({}, ...value.map(style)) : value ?? {};
}

const createSource = readFileSync("app/create.tsx", "utf8");
const dateSource = readFileSync("src/features/habit-form/components/DatePickerModal.tsx", "utf8");
const repeatSource = readFileSync("src/features/habits/presentation/repeat-labels.ts", "utf8");

function auditMonthlyLabels(source: string): void {
  const label = loadRender(source, "getRepeatLabel", {
    translate: (t: (key: string, options?: object) => string, key: string, options?: object) => t(key, options),
  });
  for (const [dates, expected] of [
    [[4, 5, 6, 12, 22, 23, 24, 25], "4–6, 12, 22–25"],
    [[5, 6, 18], "5, 6, 18"],
    [[30, 29, 28, 13, 8, 7], "7, 8, 13, 28–30"],
  ] as const) {
    const input = [...dates];
    assert.equal(label({ type: "monthly", dates: input }, () => "single", [], "en"), expected);
    assert.deepEqual(input, dates);
  }
  assert.equal(label({ type: "monthly", dates: [8] }, () => "single", [], "en"), "single");
}

function auditCreateHeader(source: string): void {
  for (const mode of ["light", "dark"]) {
    for (const accent of ["#2D6CB0", "#C13D7A"]) {
      const fixture = createRenderFixture();
      const component = loadRender(source, "CreateHabitScreen", {
        React: fixture.react, ...fixture.react,
        View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable",
        MaterialIcons: "MaterialIcons", ScreenWrapper: "ScreenWrapper",
        InlineErrorBanner: "InlineErrorBanner", CreateHabitScheduleController: "ScheduleController",
        useRouter: () => ({ back() {} }), useSafeAreaInsets: () => ({ top: 0 }),
        useLocalSearchParams: () => ({}),
        useTranslation: () => ({ t: (key: string) => ({
          "creation.title": "Nouvelle habitude", "creation.save": "Enregistrer",
        })[key] ?? key }),
        useCreateHabit: () => ({ create() {}, error: null, clearError() {} }),
        useVisualColorScheme: () => "custom", useVisualEffectiveMode: () => mode,
        useUIStore: (selector: (state: object) => unknown) => selector({ selectedDate: "2034-04-09" }),
        getAccentScheme: () => ({ base: accent }), isCivilDateKey: (value: unknown) => typeof value === "string",
        getCurrentLocalDateSnapshot: () => "2034-04-09",
        darkTheme: { background: "#2C2C2C", disabled: "#616161" },
        lightTheme: { background: "#F2F2F2", disabled: "#BDBDBD" },
      });
      const tree = fixture.render(component);
      const header = (tree.props.children as Element[])[0];
      const [back, title, save] = header.props.children as Element[];
      assert.equal(style(header.props.style).height, 56);
      assert.ok(header.props.className.includes("justify-between"));
      assert.ok(back.props.className.includes("shrink-0"));
      assert.ok(save.props.className.includes("shrink-0"));
      assert.equal(style(title.props.style).fontSize, 18);
      assert.equal(style(title.props.style).flexShrink, 1);
      assert.equal(style(title.props.style).minWidth, 0);
      assert.equal(style(title.props.style).textAlign, "center");
      assert.equal(title.props.numberOfLines, 1);
      assert.equal(title.props.ellipsizeMode, "tail");
      assert.equal(save.props.disabled, true);
      const inputs = elements(tree).filter((element) => element.type === "TextInput");
      assert.equal(inputs.length, 2);
      for (const input of inputs) {
        assert.equal(input.props.cursorColor, accent);
        assert.equal(input.props.selectionColor, accent);
      }
      inputs[0].props.onChange({ nativeEvent: { text: "A clear title" } });
      const enabled = fixture.render(component);
      assert.equal(((enabled.props.children as Element[])[0].props.children as Element[])[2].props.disabled, false);
    }
  }
}

function auditDateControls(source: string): void {
  const actionStyle = loadRender(source, "DATE_ACTION_TEXT_STYLE", {});
  const touchStyle = loadRender(source, "MONTH_NAVIGATION_TARGET_STYLE", {});
  const fixture = createRenderFixture();
  const pane = loadRender(source, "DatePickerCalendarPane", {
    React: fixture.react, ...fixture.react, View: "View", Text: "Text", Pressable: "Pressable",
    MaterialIcons: "MaterialIcons", DatePickerWeekdayHeader: "Weekdays", DatePickerDayCell: "Day",
    MONTH_NAVIGATION_TARGET_STYLE: touchStyle,
    getDatePickerMonthModel, toCivilDate, format, subMonths, addMonths,
  });
  const props = {
    accent: "#2D6CB0", language: "en", selectedDate: "2034-04-09", pickedDate: "2034-04-09",
    today: "2034-04-09", weekdays: [], paletteIcon: "#505050",
    previousMonthLabel: "Previous month", nextMonthLabel: "Next month", onSelectDay() {},
  };
  let tree = fixture.render(pane, props);
  const header = (tree.props.children as Element[])[0];
  const [previous, , next] = header.props.children as Element[];
  const parent = style(header.props.style);
  const target = style(previous.props.style);
  assert.equal(target.width, 44);
  assert.equal(target.height, 44);
  assert.equal(style(next.props.style).height, 44);
  assert.equal(target.margin, -10);
  assert.equal(target.alignItems, "center");
  assert.equal(target.justifyContent, "center");
  assert.equal(parent.paddingVertical, 10);
  assert.equal(parent.marginVertical, -2);
  assert.ok(!header.props.className.includes("py-"));
  const icon = (previous.props.children as Element[])[0];
  assert.equal(icon.props.size, 24);
  const parentHeight = 2 * parent.paddingVertical + target.height + 2 * target.margin;
  assert.ok(parentHeight >= target.height, "the month target must fit inside its direct parent");
  assert.equal(parentHeight + 2 * parent.marginVertical, 40, "month navigation must retain its net layout height");
  assert.equal(parent.marginVertical + parent.paddingVertical + target.margin + (target.height - 24) / 2, 8);
  assert.equal(16 + target.margin + (target.width - 24) / 2, 16, "icon horizontal position must remain unchanged");
  next.props.onPress();
  tree = fixture.render(pane, props);
  assert.equal(((tree.props.children as Element[])[0].props.children as Element[])[1].props.children[0], "May 2034");
  ((tree.props.children as Element[])[0].props.children as Element[])[0].props.onPress();
  tree = fixture.render(pane, props);
  assert.equal(((tree.props.children as Element[])[0].props.children as Element[])[1].props.children[0], "April 2034");

  for (const mode of ["light", "dark"]) {
    let cancelled = 0;
    let confirmed = "";
    const contentFixture = createRenderFixture();
    const content = loadRender(source, "DatePickerContent", {
      React: contentFixture.react, ...contentFixture.react,
      View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView",
      DatePickerSelectedHeader: "SelectedHeader", DatePickerCalendarPane: "CalendarPane",
      DATE_ACTION_TEXT_STYLE: actionStyle, scrimColor: "#00000080", radii: { dialog: 16 },
      useTranslation: () => ({ t: (key: string) => key }), useVisualLanguage: () => "en",
      useVisualColorScheme: () => "custom", useVisualEffectiveMode: () => mode,
      getAccentScheme: () => ({ base: "#2D6CB0" }), lightTheme: {}, darkTheme: {},
      getWeekdayLabels: () => [], useWindowDimensions: () => ({ width: 320, height: 700 }),
      useDatePickerSelectionDraft: () => ({ pickedDate: "2034-04-10", getPickedDate: () => "2034-04-10" }),
      useCurrentLocalDate: () => "2034-04-09",
    });
    const contentTree = contentFixture.render(content, { selectedDate: "2034-04-09",
      onCancel: () => cancelled++, onConfirm: (date: string) => { confirmed = date; } });
    const labels = elements(contentTree).filter((element) => element.type === "Text");
    assert.equal(labels.length, 2);
    for (const label of labels) {
      assert.equal(style(label.props.style).fontSize, 14);
      assert.equal(style(label.props.style).lineHeight, 20);
      assert.equal(style(label.props.style).fontWeight, "600");
    }
    assert.equal(labels[0].props.className, "text-muted");
    assert.equal(style(labels[1].props.style).color, "#2D6CB0");
    const actions = elements(contentTree).filter((element) => element.type === "Pressable").slice(-2);
    actions[0].props.onPress();
    actions[1].props.onPress();
    assert.equal(cancelled, 1);
    assert.equal(confirmed, "2034-04-10");
  }
}

auditCreateHeader(createSource);
auditDateControls(dateSource);
auditMonthlyLabels(repeatSource);
function auditRepeatTouchTarget(source: string): void {
  const fixture = createRenderFixture();
  let applied: unknown;
  const content = loadRender(source, "RepeatSheetContent", {
    React: fixture.react, ...fixture.react,
    View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView",
    KeyboardAvoidingView: "KeyboardAvoidingView", Platform: { OS: "android" },
    RepeatDaysTab: "Days", RepeatMonthlyTab: "Monthly", RepeatIntervalTab: "Interval",
    useTranslation: () => ({ t: (key: string) => key }),
    useVisualColorScheme: () => "blue", useVisualEffectiveMode: () => "light",
    getAccentScheme: () => ({ base: "#2D6CB0" }), lightTheme: {}, darkTheme: {},
    useSafeAreaInsets: () => ({ bottom: 0 }), sizes: { rowHeight: 68 },
    createRepeatDraft: loadRender(source, "createRepeatDraft", {}),
    createMonthlyDateDraftStore,
  });
  const tree = fixture.render(content, { initialSchedule: { type: "daily" }, onApply: (value: unknown) => { applied = value; } });
  const done = elements(tree).find((element) => element.props.accessibilityLabel === "repeat.done")!;
  assert.ok(done);
  assert.ok(done.props.hitSlop.top >= 9 && done.props.hitSlop.bottom >= 9);
  done.props.onPress();
  assert.equal((applied as { type: string }).type, "daily");
}
const repeatSheetSource = readFileSync("src/features/habit-form/components/RepeatSheet.tsx", "utf8");
auditRepeatTouchTarget(repeatSheetSource);
assert.throws(() => auditRepeatTouchTarget(repeatSheetSource.replace("top: 9, bottom: 9", "top: 0, bottom: 0")), { name: "AssertionError" });

function auditRootErrorFallback(source: string): void {
  const ast = ts.createSourceFile("layout.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  assert.ok(ast.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ErrorBoundary" && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)), "Expo Router must discover the exported fallback");
  for (const theme of ["dark", "light", "system"]) {
    for (const system of ["dark", "light"]) {
      const fixture = createRenderFixture();
      let retried = 0;
      const fallback = loadRender(source, "ErrorBoundary", {
        React: fixture.react, ...fixture.react, StartupState: "StartupState",
        useSettingsStore: (selector: (state: object) => unknown) => selector({ theme }),
        useNativeColorMode: () => system, i18n: { t: (key: string) => key },
      });
      const tree = fixture.render(fallback, { error: new Error("Synthetic failure"), retry: () => { retried++; } });
      assert.equal(tree.props.error, true);
      assert.equal(tree.props.errorMessage, "common.dataErrorMessage");
      assert.equal(tree.props.mode, theme === "system" ? system : theme);
      tree.props.onRetry();
      assert.equal(retried, 1);
    }
  }
}
const rootLayoutSource = readFileSync("app/_layout.tsx", "utf8");
auditRootErrorFallback(rootLayoutSource);
function auditStartupStatePalette(source: string): void {
  for (const system of ["light", "dark"]) {
    for (const mode of [undefined, "light", "dark"]) {
      const fixture = createRenderFixture();
      let nativeBar: boolean | undefined;
      const startup = loadRender(source, "StartupState", {
        React: fixture.react, ...fixture.react,
        useLayoutEffect: (effect: () => void) => effect(),
        useNativeColorMode: () => system,
        setAndroidNavigationBarTheme: (value: boolean) => { nativeBar = value; },
        View: "View", Text: "Text", Pressable: "Pressable", StatusBar: "StatusBar", ActivityIndicator: "Spinner",
        darkTheme, lightTheme, i18n: { t: (key: string) => key },
      });
      const tree = fixture.render(startup, { error: true, mode });
      const expectedDark = (mode ?? system) === "dark";
      assert.equal(nativeBar, expectedDark, "native buttons must be styled during layout, not after paint");
      assert.equal(elements(tree).find((node) => node.type === "StatusBar")!.props.style, expectedDark ? "light" : "dark");
      assert.equal(style(elements(tree).find((node) => node.type === "View")!.props.style).backgroundColor, expectedDark ? darkTheme.background : lightTheme.background);
    }
  }
}
auditStartupStatePalette(rootLayoutSource);
const startupDeclaration = ts.createSourceFile("layout.tsx", rootLayoutSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  .statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "StartupState")!;
const startupSource = startupDeclaration.getText();
for (const [target, replacement] of [
  ["useLayoutEffect", "useEffect"],
  ["(mode ?? systemColorScheme)", "systemColorScheme"],
]) {
  assert.ok(startupSource.includes(target));
  assert.throws(() => auditStartupStatePalette(startupSource.replace(target, replacement)), { name: "AssertionError" });
}
for (const [target, replacement] of [
  ["export function ErrorBoundary", "function ErrorBoundary"],
  ['theme === "system" ? systemColorScheme : theme', 'systemColorScheme'],
  ["void retry();", "void 0;"],
]) {
  assert.ok(rootLayoutSource.includes(target));
  assert.throws(() => auditRootErrorFallback(rootLayoutSource.replace(target, replacement)), { name: "AssertionError" });
}
for (const [source, target, replacement, audit] of [
  [createSource, "flexShrink: 1, minWidth: 0", "flexShrink: 0, minWidth: 0", auditCreateHeader],
  [createSource, "cursorColor={accent}", 'cursorColor="#4D4D4D"', auditCreateHeader],
  [dateSource, "marginVertical: -2", "marginVertical: 0", auditDateControls],
  [dateSource, "height: 44", "height: 24", auditDateControls],
  [dateSource, "lineHeight: 20", "lineHeight: 18", auditDateControls],
  [repeatSource, "end - start >= 2", "end - start >= 1", auditMonthlyLabels],
  [repeatSource, "end - start >= 2", "end - start >= 3", auditMonthlyLabels],
] as const) {
  assert.ok(source.includes(target));
  assert.throws(() => audit(source.replace(target, replacement)), { name: "AssertionError" });
}
async function auditCreateLifecycle(source: string): Promise<void> {
  for (const outcome of ["success", "failure", "unmount"] as const) {
    let resolveWrite!: () => void;
    let rejectWrite!: (error: Error) => void;
    const write = new Promise<void>((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    });
    let writes = 0;
    let navigations = 0;
    let error: unknown = null;
    let cleanup: (() => void) | undefined;
    const hook = loadRender(source, "useCreateHabit", {
      useRouter: () => ({ back: () => navigations++ }),
      useHabitStore: (select: (store: object) => unknown) => select({
        createHabit: () => { writes++; return write; },
      }),
      useCallback: (callback: unknown) => callback,
      useRef: (current: unknown) => ({ current }),
      useState: () => [null, (next: unknown) => { error = next; }],
      useEffect: (effect: () => () => void) => { cleanup = effect(); },
      console: { error() {} },
    });
    const input = { name: "Read", description: "A daily chapter" };
    const result = hook();
    const pending = result.create(input);
    assert.equal(navigations, 0, "a pending write must not destroy the form draft");
    const duplicate = result.create(input);
    assert.equal(writes, 1);
    assert.equal(await duplicate, false, "duplicate saves must not create two habits");
    if (outcome === "failure") {
      rejectWrite(new Error("Storage unavailable"));
      assert.equal(await pending, false);
      assert.equal(navigations, 0);
      assert.equal(error, "create-failed", "the retained form must show a retryable error");
      assert.deepEqual(input, { name: "Read", description: "A daily chapter" });
      const retry = result.create(input);
      assert.equal(writes, 2, "failure must release the duplicate-save guard");
      assert.equal(await retry, false);
    } else {
      if (outcome === "unmount") cleanup!();
      resolveWrite();
      assert.equal(await pending, true);
      assert.equal(navigations, outcome === "unmount" ? 0 : 1);
      assert.equal(error, null);
    }
  }
}

async function auditCreatePersistence(): Promise<void> {
  const source = readFileSync("src/features/habit-form/hooks/useCreateHabit.ts", "utf8");
  await auditCreateLifecycle(source);
  for (const [target, replacement] of [
    ["await createHabit(input);", "router.back(); await createHabit(input);"],
    ["if (createInFlightRef.current)", "if (false)"],
    ["if (isMountedRef.current) router.back();", "router.back();"],
    ['if (isMountedRef.current) setError("create-failed");', "if (false) setError(null);"],
  ]) {
    assert.ok(source.includes(target));
    await assert.rejects(auditCreateLifecycle(source.replace(target, replacement)), { name: "AssertionError" });
  }
}

const createAuditDeadline = setTimeout(() => {
  console.error("Habit creation audit did not settle");
  process.exitCode = 1;
}, 10_000);
auditCreatePersistence().then(() => {
  clearTimeout(createAuditDeadline);
  console.log("UI forms audit passed: form geometry, date controls, repeat touch target, themed error recovery, durable creation, and behavioral fault checks.");
}, (error: unknown) => {
  clearTimeout(createAuditDeadline);
  console.error(error);
  process.exitCode = 1;
});
