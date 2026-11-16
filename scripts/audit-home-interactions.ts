import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { resolve } from "node:path";

import { runInNewContext } from "node:vm";

import ts from "typescript";

import { addDays } from "date-fns/addDays";

import { format } from "date-fns/format";

import { getDay } from "date-fns/getDay";

import { parseISO } from "date-fns/parseISO";

import { subDays } from "date-fns/subDays";

import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import { loadHabitStoreForAudit } from "./fixtures/load-habit-store-for-audit";
import { auditReasonDialogCancellation } from "./fixtures/audit-reason-dialog-cancellation";

import { MAIN_CALENDAR_FUTURE_DAYS } from "../src/features/habits/constants";

const root = resolve(__dirname, "..");

const read = (relativePath: string) =>
  readFileSync(resolve(root, relativePath), "utf8");

const transferSource = read("src/features/habits/hooks/useHabitTransfer.ts");

const overlaySource = read(
  "src/features/habits/components/SectionFlightOverlay.tsx",
);

const activeListSource = read(
  "src/features/habits/components/ActiveHabitsList.tsx",
);

const homeSource = read("app/index.tsx");

const checkboxSource = read(
  "src/features/habits/components/CheckboxCircle.tsx",
);

const itemSource = read("src/features/habits/components/HabitItem.tsx");

const completedSource = read(
  "src/features/habits/components/CompletedHabitsSection.tsx",
);

const calendarStripSource = read(
  "src/features/habits/components/CalendarStrip.tsx",
);

type LayoutEvent = {
  nativeEvent: {
    layout: { width: number; height: number; x: number; y: number };
  };
};

function loadOverlayLayoutCallback(
  source: string,
  environment: Record<string, unknown>,
): (event: LayoutEvent) => void {
  const tree = ts.createSourceFile(
    "SectionFlightOverlay.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const candidates: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(tree) === "onLayout" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      const text = node.initializer.expression.getText(tree);
      if (text.includes("onOverlayVisualReadyRef.current")) {
        candidates.push(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(
    candidates.length,
    1,
    "the overlay card must expose exactly one native layout witness",
  );
  const transpiled = ts.transpileModule(`(${candidates[0]})`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
    reportDiagnostics: true,
  });
  assert.equal(
    (transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ).length,
    0,
    "the extracted layout callback must compile",
  );
  return runInNewContext(transpiled.outputText, environment) as (
    event: LayoutEvent,
  ) => void;
}

function auditOwnerLeaseRegistration(source: string): void {
  const tree = ts.createSourceFile(
    "component.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const hooks: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0]?.getText(tree) === "installOwnerLease"
    ) {
      hooks.push(node.expression.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.deepEqual(
    hooks,
    ["useLayoutEffect"],
    "the owner lease must be installed and revoked in the layout phase",
  );
}

function findEffectHookForAssignment(
  source: string,
  assignment: string,
): string {
  const tree = ts.createSourceFile(
    "component.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const hooks: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.getText(tree) === "useEffect" ||
        node.expression.getText(tree) === "useLayoutEffect") &&
      node.arguments[0]?.getText(tree).includes(assignment)
    ) {
      hooks.push(node.expression.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(hooks.length, 1, `one effect must assign ${assignment}`);
  return hooks[0];
}

function auditPhysicalCallbackRefPhases(home: string, calendar: string): void {
  assert.equal(
    findEffectHookForAssignment(
      calendar,
      "onSelectDateRef.current = onSelectDate",
    ),
    "useLayoutEffect",
    "the calendar callback ref must be current before native input resumes",
  );
  assert.equal(
    findEffectHookForAssignment(
      home,
      "transferHandleCheckboxPressRef.current = transfer.handleCheckboxPress",
    ),
    "useLayoutEffect",
    "the transfer callback ref must be current before native input resumes",
  );
}

function loadArrowContaining<T>(
  source: string,
  needle: string,
  environment: Record<string, unknown>,
): T {
  const tree = ts.createSourceFile(
    "component.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const candidates: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node)) {
      const text = node.getText(tree);
      if (text.includes(needle)) candidates.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(candidates.length, 1, `one callback must contain ${needle}`);
  const code = ts.transpileModule(`(${candidates[0]})`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return runInNewContext(code, environment) as T;
}

function auditDateOwnerKeys(source: string): void {
  const tree = ts.createSourceFile(
    "index.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const keys = new Map<string, string[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(tree);
      if (tag === "ActiveHabitsList" || tag === "CompletedHabitsSection") {
        const key = node.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) &&
            property.name.getText(tree) === "key",
        );
        const expression =
          key?.initializer && ts.isJsxExpression(key.initializer)
            ? key.initializer.expression?.getText(tree)
            : undefined;
        keys.set(tag, [...(keys.get(tag) ?? []), expression ?? ""]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.deepEqual(keys.get("ActiveHabitsList"), ["`active-${layoutEpoch}`"]);
  assert.deepEqual(keys.get("CompletedHabitsSection"), [
    "`completed-${layoutEpoch}`",
  ]);
}

function auditInitialHeightSynchronization(
  source: string,
  completed: boolean,
): void {
  const targetName = completed ? "targetCurtainHeight" : "targetListHeight";
  const valueName = completed ? "curtainHeight" : "listHeight";
  assert.match(
    source,
    new RegExp(
      `const ${valueName} = useSharedValue\\(${targetName}\\);\\s*` +
        `const initialHeightRef = useRef<number \\| null>\\(${targetName}\\);`,
    ),
    "the first-commit shortcut must match the actual shared-value seed",
  );

  for (const initialMatches of [true, false]) {
    const target = completed ? 0 : 65;
    let reads = 0;
    let writes = 0;
    let rowClosures = 0;
    let snapCompletions = 0;
    const initialHeightRef = { current: initialMatches ? target : target + 65 };
    let nativeHeight = initialHeightRef.current;
    const sharedHeight = {
      get value() {
        reads += 1;
        return nativeHeight;
      },
      set value(value: number) {
        assert.equal(value, target);
        nativeHeight = value;
        writes += 1;
      },
    };
    const environment = {
      initialHeightRef,
      [targetName]: target,
      [valueName]: sharedHeight,
      prevBusyRef: { current: false },
      isBusy: false,
      isExpanded: false,
      renderRows: [],
      prevExpandedRef: { current: false },
      suppressLayoutAnimations: true,
      suppressReflowAnimation: false,
      forceCurtainSnap: true,
      suppressRowReflowAnimation: false,
      effectiveRowShiftDurationMs: 180,
      hiddenHabitId: null,
      [`${completed ? "curtain" : "listHeight"}AnimSeqRef`]: { current: 0 },
      [`${completed ? "curtain" : "listHeight"}AnimRef`]: { current: null },
      [completed ? "handleCurtainAnimFinish" : "handleListHeightAnimFinish"]: (
        _animationId: number,
        finished: boolean,
      ) => {
        assert.equal(finished, true);
        snapCompletions += 1;
      },
      NOOP_HEIGHT_DELTA_PX: 0.5,
      NOOP_CURTAIN_DELTA_PX: 0.5,
      setRowsMounted: (mounted: boolean) => {
        assert.equal(mounted, false);
        rowClosures += 1;
      },
    };
    const synchronize = loadArrowContaining<() => void>(
      source,
      `const target = ${targetName};`,
      environment,
    );
    synchronize();
    assert.equal(
      reads,
      initialMatches ? 0 : 1,
      "initial height synchronization must skip only a matching seed read",
    );
    assert.equal(
      initialHeightRef.current,
      null,
      "initial height synchronization must consume its seed after the first effect",
    );
    assert.equal(
      writes,
      1,
      "initial height synchronization must retain the existing no-op write",
    );
    if (completed)
      assert.equal(
        snapCompletions,
        initialMatches ? 0 : 1,
        "initial height synchronization must snap an outdated seed to the current target",
      );
    if (completed && initialMatches) {
      assert.equal(
        rowClosures,
        1,
        "initial height synchronization must retain collapsed-row cleanup",
      );
    }
    const previousReads = reads;
    synchronize();
    assert.equal(
      reads,
      previousReads + 1,
      "initial height synchronization must read live UI state on subsequent effects",
    );
    assert.equal(writes, 2);
  }
}

function replaceExactlyOnce(
  source: string,
  search: string | RegExp,
  replacement: string,
): string {
  const pattern =
    typeof search === "string"
      ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      : new RegExp(
          search.source,
          search.flags.includes("g") ? search.flags : `${search.flags}g`,
        );
  assert.equal(
    [...source.matchAll(pattern)].length,
    1,
    `mutation target must occur exactly once: ${String(search)}`,
  );
  return source.replace(search, replacement);
}

function assertMutationKilled(
  name: string,
  source: string,
  transform: (value: string) => string,
  audit: (value: string) => void,
  expectedMessage: RegExp,
): void {
  const mutated = transform(source);
  const transpiled = ts.transpileModule(mutated, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
    reportDiagnostics: true,
  });
  assert.equal(
    (transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ).length,
    0,
    `${name} must remain valid TypeScript`,
  );
  let failure: unknown;
  try {
    audit(mutated);
  } catch (error) {
    failure = error;
  }
  if (failure == null) {
    throw new Error(`${name} survived its behavioral audit`);
  }
  assert.equal(
    (failure as Error).name,
    "AssertionError",
    `${name} must fail an observable assertion`,
  );
  assert.match(
    (failure as Error).message,
    expectedMessage,
    `${name} must fail for its intended contract`,
  );
}

function evaluateInitializer<T>(
  source: string,
  name: string,
  environment: Record<string, unknown>,
): T {
  const tree = ts.createSourceFile(
    "component.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let expression: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) {
      expression = node.initializer?.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(expression, `${name} initializer must exist`);
  return runInNewContext(
    ts.transpileModule(`(${expression})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    environment,
  ) as T;
}

function auditCheckboxAnimatedInitializers(source: string): void {
  const chooseVariant = loadTsxCallable<
    (props: Record<string, unknown>) => AuditElement
  >(source, "CheckboxCircle", {
    CheckboxCircleStatic: "static",
    CheckboxCircleAnimated: "animated",
  });
  assert.equal(chooseVariant({ animateTransitions: false }).type, "static");
  assert.equal(chooseVariant({ animateTransitions: true }).type, "animated");
  for (const platform of ["android", "ios", "web"]) {
    const usesJsRuntime = evaluateInitializer<boolean>(
      source,
      "USES_JS_ANIMATION_RUNTIME",
      {
        Platform: { OS: platform },
      },
    );
    for (const worklet of platform === "web" ? [false] : [false, true]) {
      const nativeInitializer = platform !== "web" && !worklet;
      let reads = 0;
      const values: Record<string, number | string> = {
        colorProgress: 0.25,
        prevBgColor: "before",
        currentBgColor: "after",
        pressOverlay: 0.4,
        pressScale: 0.93,
      };
      const shared = Object.fromEntries(
        Object.keys(values).map((name) => [
          name,
          {
            get value() {
              assert.equal(
                nativeInitializer,
                false,
                "native initial updaters must not read shared values",
              );
              reads += 1;
              return values[name];
            },
          },
        ]),
      );
      const environment = {
        ...shared,
        global: { _WORKLET: worklet },
        USES_JS_ANIMATION_RUNTIME: usesJsRuntime,
        bgColor: "#123456",
        interpolateColor: (
          progress: number,
          input: number[],
          colors: string[],
        ) => {
          assert.deepEqual(Array.from(input), [0, 1]);
          return `${progress}:${colors[0]}:${colors[1]}`;
        },
      };
      const updaters = [
        "circleStyle",
        "pressOverlayStyle",
        "pressScaleStyle",
      ].map((name) =>
        loadSourceCallableForAudit<() => unknown>(source, name, environment),
      );
      const readStyles = () =>
        JSON.parse(JSON.stringify(updaters.map((updater) => updater())));
      assert.deepEqual(
        readStyles(),
        nativeInitializer
          ? [
              { backgroundColor: "#123456" },
              { opacity: 0 },
              { transform: [{ scale: 1 }] },
            ]
          : [
              { backgroundColor: "0.25:before:after" },
              { opacity: 0.4 },
              { transform: [{ scale: 0.93 }] },
            ],
        nativeInitializer
          ? "native initial styles must match their shared-value seeds"
          : "live animated styles must use current shared values",
      );
      assert.equal(reads, nativeInitializer ? 0 : 5);
      if (!nativeInitializer) {
        Object.assign(values, {
          colorProgress: 0.75,
          currentBgColor: "next",
          pressOverlay: 0.8,
          pressScale: 1.03,
        });
        assert.deepEqual(
          readStyles(),
          [
            { backgroundColor: "0.75:before:next" },
            { opacity: 0.8 },
            { transform: [{ scale: 1.03 }] },
          ],
          "native UI and Web animation updates must remain live",
        );
        assert.equal(reads, 10);
      }
    }
  }
}

function auditStaticBottomSeparator(source: string): void {
  assert.doesNotMatch(
    source,
    /const bottomSeparatorStyle\s*=\s*useAnimatedStyle/,
    "constant separator opacity must not install an animated mapper",
  );
  const styles = evaluateInitializer<Record<string, Record<string, unknown>>>(
    source,
    "styles",
    {
      StyleSheet: { create: (value: unknown) => value },
      SLOT_HEIGHT: 64,
      SEPARATOR_RENDER_HEIGHT: 1,
    },
  );
  assert.equal(
    styles.rowBottomSeparator.opacity,
    1,
    "the static separator must retain full opacity",
  );
}

type AuditElement = { type: unknown; props: Record<string, any>; key?: string };

const auditJsx = (
  type: unknown,
  props: Record<string, any>,
  key?: string,
): AuditElement => ({ type, props, key });

function loadTsxCallable<T>(
  source: string,
  name: string,
  environment: Record<string, unknown>,
): T {
  const tree = ts.createSourceFile(
    "component.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let expression: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      expression = ts.createPrinter().printNode(
        ts.EmitHint.Unspecified,
        ts.factory.updateFunctionDeclaration(
          node,
          node.modifiers?.filter(
            (modifier) =>
              modifier.kind !== ts.SyntaxKind.ExportKeyword &&
              modifier.kind !== ts.SyntaxKind.DefaultKeyword,
          ),
          node.asteriskToken,
          node.name,
          node.typeParameters,
          node.parameters,
          node.type,
          node.body,
        ),
        tree,
      );
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    )
      expression = node.initializer.arguments[0]?.getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(expression, `${name} must exist in the current TSX source`);
  const code = ts.transpileModule(`(${expression})`, {
    fileName: "component.tsx",
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  return runInNewContext(code, {
    exports: {},
    require: (name: string) => {
      assert.equal(name, "react/jsx-runtime");
      return { jsx: auditJsx, jsxs: auditJsx, Fragment: "fragment" };
    },
    ...environment,
  }) as T;
}

function auditCheckboxPresentationIdentity(source: string): void {
  const same = loadSourceCallableForAudit<
    (a: Record<string, unknown>, b: Record<string, unknown>) => boolean
  >(source, "areHabitItemPropsEqual", {});
  for (const animated of [true, false]) {
    const refs: { current: unknown }[] = [];
    let cursor = 0;
    let effects: (() => void)[] = [];
    const render = loadTsxCallable<
      (props: Record<string, unknown>) => AuditElement
    >(source, "HabitItemComponent", {
      useTranslation: () => ({ t: (key: string) => key }),
      useRef: (value: unknown) =>
        refs[cursor++] ?? (refs[cursor - 1] = { current: value }),
      useLayoutEffect: (effect: () => void) => effects.push(effect),
      useEffect: () => undefined,
      Pressable: "pressable",
      View: "view",
      Text: "text",
      CheckboxCircle: "checkbox",
      DragHandle: "drag-handle",
    });
    let previous: Record<string, unknown> | null = null;
    let accepted = false;
    let currentKey: string | undefined;
    let mountCount = 0;
    const base = {
      habitId: 41,
      habitName: "Example",
      checkboxState: "minimum",
      currentStreak: 2,
      showDragHandle: false,
      animateCheckboxTransitions: animated,
      visualEpoch: "day-A",
      onCheckboxPress: (id: number) => {
        assert.equal(id, 41);
        return accepted;
      },
    };
    const update = (changes: Record<string, unknown>) => {
      const props = { ...base, ...changes };
      if (previous == null || !same(previous, props)) {
        cursor = 0;
        effects = [];
        const tree = render(props);
        const checkbox = tree.props.children.find(
          (child: AuditElement) => child?.type === "checkbox",
        ) as AuditElement;
        assert.ok(checkbox, "the retained habit item must expose its checkbox");
        assert.equal(checkbox.props.onPress(), accepted,
          "the habit row must preserve transfer admission for checkbox feedback");
        assert.equal(checkbox.props.animateTransitions, animated);
        if (currentKey === undefined || currentKey !== checkbox.key)
          mountCount += 1;
        currentKey = checkbox.key;
        effects.forEach((effect) => effect());
      }
      previous = props;
      return currentKey;
    };
    assert.equal(update({}), "day-A");
    accepted = true;
    assert.equal(
      update({ checkboxState: "maximum" }),
      "day-A",
      "same-date changes must retain the checkbox instance",
    );
    assert.equal(
      update({ visualEpoch: "day-B", checkboxState: "maximum" }),
      "day-A",
    );
    assert.equal(
      update({ visualEpoch: "day-B" }),
      "day-A",
      "a same-tone date commit must not cause the next local change to remount",
    );
    assert.equal(
      update({}),
      "day-A",
      "an A-to-B-to-A same-tone round trip must retain its instance",
    );
    assert.equal(
      mountCount,
      1,
      "same-tone date changes and same-day tone changes must not remount",
    );
    assert.equal(
      update({ visualEpoch: "day-C", checkboxState: "done" }),
      "day-C",
    );
    assert.equal(
      mountCount,
      2,
      "a different date and tone must reset the checkbox exactly once",
    );
    assert.equal(
      update({ visualEpoch: "day-C", checkboxState: "maximum" }),
      "day-C",
    );
    assert.equal(mountCount, 2);
  }
}

function auditRowEpochComparators(active: string, completed: string): void {
  const item = {
    habit: { id: 41, name: "Example" },
    checkboxState: "minimum",
    currentStreak: 2,
  };
  for (const [source, name] of [
    [active, "areActiveHabitRowPropsEqual"],
    [completed, "areCompletedHabitRowPropsEqual"],
  ]) {
    const same = loadSourceCallableForAudit<
      (a: Record<string, unknown>, b: Record<string, unknown>) => boolean
    >(source, name, {});
    const before = { item, checkboxVisualEpoch: "day-A" };
    assert.equal(same(before, { ...before }), true);
    assert.equal(
      same(before, { ...before, checkboxVisualEpoch: "day-B" }),
      false,
      "row comparators must publish a changed date epoch before later local mutations",
    );
  }
}

type CalendarStripAuditHandle = {
  revealToday(): void;
  cancelPendingTodayReveal(): void;
};

type CalendarScrollCall = {
  kind: "offset" | "end";
  options: Record<string, unknown>;
};

function createCalendarStripHarness(source: string) {
  const layoutEffects: (() => void)[] = [];
  const effects: (() => void)[] = [];
  const animationFrames: (() => void)[] = [];
  const selections: string[] = [];
  const scrollCalls: CalendarScrollCall[] = [];
  const externalRef: { current: CalendarStripAuditHandle | null } = {
    current: null,
  };
  const generateDateMeta = loadSourceCallableForAudit<
    (todayDate: string) => Record<string, unknown>[]
  >(source, "generateDateMeta", {
    addDays,
    format,
    getDay,
    parseISO,
    subDays,
    DAYS_TO_SHOW: 30,
    MAIN_CALENDAR_FUTURE_DAYS,
  });
  const getReadableTextColor = loadSourceCallableForAudit<
    (color: string) => string
  >(source, "getReadableTextColor", {});
  const react = {
    useImperativeHandle: (
      target: { current: CalendarStripAuditHandle | null },
      create: () => CalendarStripAuditHandle,
    ) => {
      target.current = create();
    },
  };
  const render = loadTsxCallable<
    (
      props: Record<string, unknown>,
      target: { current: CalendarStripAuditHandle | null },
    ) => AuditElement
  >(source, "CalendarStripComponent", {
    React: react,
    useRef: <T>(value: T) => ({ current: value }),
    useMemo: <T>(create: () => T) => create(),
    useCallback: <T>(callback: T) => callback,
    useLayoutEffect: (effect: () => void) => layoutEffects.push(effect),
    useEffect: (effect: () => void) => effects.push(effect),
    useVisualColorScheme: () => "orange",
    useVisualLanguage: () => "en",
    useVisualEffectiveMode: () => "light",
    getAccentScheme: () => ({
      base: "#E67E22",
      pale: "#F0B27A",
      bright: "#D35400",
    }),
    getReadableTextColor,
    lightTheme: { muted: "#777777", primary: "#212121" },
    getWeekdayLabels: () => ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
    generateDateMeta,
    CALENDAR_CELL_WIDTH: 48,
    VISIBLE_DAYS: 8,
    formatLocalizedDate: (date: string) => date,
    CalendarDayCell: "calendar-day",
    ScrollView: "scroll-view",
    View: "view",
    requestAnimationFrame: (callback: () => void) => {
      animationFrames.push(callback);
      return animationFrames.length;
    },
  });
  const tree = render(
    {
      selectedDate: "2026-11-13",
      todayDate: "2026-11-13",
      onSelectDate: (date: string) => selections.push(date),
    },
    externalRef,
  );
  const nativeScroll = {
    scrollTo: (options: Record<string, unknown>) =>
      scrollCalls.push({ kind: "offset", options }),
    scrollToEnd: (options: Record<string, unknown>) =>
      scrollCalls.push({ kind: "end", options }),
  };
  (tree.props.ref as { current: unknown }).current = nativeScroll;
  layoutEffects.forEach((effect) => effect());
  effects.forEach((effect) => effect());
  const cells = tree.props.children as AuditElement[];
  const todayCell = cells.find(
    (cell) => (cell.props.meta as { isTodayDate: boolean }).isTodayDate,
  );
  assert.ok(todayCell, "the actual strip must render its Today cell");
  const lastCell = cells.at(-1);
  assert.equal(
    (lastCell?.props.meta as { dateStr: string }).dateStr,
    "2026-11-15",
    "the native right edge must remain Today plus two days",
  );
  return {
    tree,
    externalRef,
    todayCell,
    selections,
    scrollCalls,
    layout(width: number) {
      (tree.props.onLayout as (event: unknown) => void)({
        nativeEvent: { layout: { width, height: 64, x: 0, y: 0 } },
      });
    },
    content(width: number) {
      (
        tree.props.onContentSizeChange as (
          width: number,
          height: number,
        ) => void
      )(width, 64);
    },
    flushAnimationFrames() {
      animationFrames.splice(0).forEach((callback) => callback());
    },
  };
}

function auditCalendarStripTodayReveal(source: string): void {
  const layoutFirst = createCalendarStripHarness(source);
  layoutFirst.externalRef.current!.revealToday();
  layoutFirst.layout(0);
  layoutFirst.content(Number.POSITIVE_INFINITY);
  assert.equal(
    layoutFirst.scrollCalls.length,
    0,
    "non-positive or non-finite geometry must not admit the Today command",
  );
  layoutFirst.content(1600);
  assert.equal(
    layoutFirst.scrollCalls.length,
    0,
    "content geometry alone must not admit the Today command",
  );
  layoutFirst.layout(360);
  assert.equal(layoutFirst.scrollCalls.length, 1);
  assert.equal(
    layoutFirst.scrollCalls[0].kind,
    "end",
    "the ready native strip must reveal its exact right edge",
  );
  assert.equal(
    layoutFirst.scrollCalls[0].options.animated,
    false,
    "the Today reveal must not introduce a new animation",
  );
  layoutFirst.flushAnimationFrames();
  assert.equal(
    layoutFirst.scrollCalls.at(-1)?.kind,
    "end",
    "an older mount or local-day frame must not overwrite explicit Today",
  );
  layoutFirst.externalRef.current!.revealToday();
  layoutFirst.externalRef.current!.revealToday();
  assert.equal(
    layoutFirst.scrollCalls.filter((call) => call.kind === "end").length,
    3,
    "every explicit Today press must work even when Today is already selected",
  );

  const contentFirst = createCalendarStripHarness(source);
  contentFirst.externalRef.current!.revealToday();
  contentFirst.content(1600);
  assert.equal(contentFirst.scrollCalls.length, 0);
  contentFirst.layout(360);
  assert.equal(contentFirst.scrollCalls.length, 1);
  assert.equal(
    contentFirst.scrollCalls[0].kind,
    "end",
    "either native callback order must fulfill the same pending command",
  );
  assert.equal(contentFirst.scrollCalls[0].options.animated, false);

  const externallyCancelled = createCalendarStripHarness(source);
  externallyCancelled.externalRef.current!.revealToday();
  externallyCancelled.externalRef.current!.cancelPendingTodayReveal();
  externallyCancelled.layout(360);
  externallyCancelled.content(1600);
  assert.equal(
    externallyCancelled.scrollCalls.some((call) => call.kind === "end"),
    false,
    "an external ordinary origin must cancel an unfulfilled Today reveal",
  );

  for (const selectedDate of ["2026-11-12", "2026-11-13"]) {
    const cancelled = createCalendarStripHarness(source);
    cancelled.externalRef.current!.revealToday();
    const cell =
      selectedDate === "2026-11-13"
        ? cancelled.todayCell
        : (cancelled.tree.props.children as AuditElement[]).find(
            (candidate) =>
              (candidate.props.meta as { dateStr: string }).dateStr ===
              selectedDate,
          );
    assert.ok(cell);
    (cell.props.onSelectDate as (date: string) => void)(selectedDate);
    cancelled.layout(360);
    cancelled.content(1600);
    assert.equal(
      cancelled.scrollCalls.some((call) => call.kind === "end"),
      false,
      "an ordinary date selection must cancel only an unfulfilled Today reveal",
    );
    assert.deepEqual(cancelled.selections, [selectedDate]);
  }
}

type TransferSync = {
  habitId: number;
  from: "active" | "completed";
  to: "active" | "completed";
  plannedFlightDurationMs: number;
  rowShiftDurationMs: number;
  source: string;
  startedAtMs: number;
  flightLaunchedAtMs: number | null;
  overlayBindAtMs: number | null;
  visualOverlayAtMs: number | null;
  commitFlushedAtMs: number | null;
  flightCompletedAtMs: number | null;
};
function createSync(overrides: Partial<TransferSync> = {}): TransferSync {
  return {
    habitId: 41,
    from: "active",
    to: "completed",
    plannedFlightDurationMs: 180,
    rowShiftDurationMs: 180,
    source: "checkbox",
    startedAtMs: 1,
    flightLaunchedAtMs: null,
    overlayBindAtMs: null,
    visualOverlayAtMs: null,
    commitFlushedAtMs: null,
    flightCompletedAtMs: null,
    ...overrides,
  };
}
function auditTransferStart(source: string): void {
  for (const zero of [false, true]) {
    const transferSyncRef: { current: TransferSync | null } = { current: null };
    const durations: number[] = [];
    let activeWrites = 0;
    const callback = loadSourceCallableForAudit<
      (params: Record<string, unknown>) => void
    >(source, "startTransferSyncSession", {
      transferSyncRef,
      finalizeTransferSyncSession: () => assert.fail("unexpected replacement"),
      setIsTransferSyncActive: (active: boolean) => {
        assert.equal(active, true);
        activeWrites++;
      },
      updateRowShiftDuration: (duration: number) => durations.push(duration),
      Date: { now: () => 100 },
    });
    callback({
      habitId: 41,
      from: "active",
      to: "completed",
      plannedFlightDurationMs: 180,
      source: zero ? "zero-distance" : "checkbox",
    });
    assert.equal(activeWrites, 1);
    assert.deepEqual(durations, [zero ? 0 : 180]);
    assert.equal(transferSyncRef.current?.habitId, 41);
    assert.equal(transferSyncRef.current?.startedAtMs, 100);
    assert.equal(transferSyncRef.current?.rowShiftDurationMs, zero ? 0 : 180);
  }
}
function auditOverlayCallback(source: string): void {
  const transferSyncRef: { current: TransferSync | null } = {
    current: createSync(),
  };
  const launched: number[] = [];
  const flushed: string[] = [];
  let mounted: number | null = null;
  const environment = {
    transferSyncRef,
    Date: { now: () => 100 },
    beginFlight: (id: number) => launched.push(id),
    setOverlayMountedHabitId: (
      update: (id: number | null) => number | null,
    ) => {
      mounted = update(mounted);
    },
    pendingCommitRef: { current: { habitId: 41 } },
    flushPendingCommitRef: {
      current: (reason: string) => flushed.push(reason),
    },
  };
  const bind = loadSourceCallableForAudit<(id: number, layer: string) => void>(
    source,
    "handleOverlayBind",
    environment,
  );
  bind(41, "under");
  bind(41, "under");
  assert.deepEqual(
    launched,
    [41],
    "bind must launch an unstarted downward flight once",
  );
  assert.equal(mounted, 41);
  assert.deepEqual(flushed, ["overlay-ready", "overlay-ready"]);
  assert.equal(transferSyncRef.current?.overlayBindAtMs, 100);
  assert.equal(transferSyncRef.current?.flightLaunchedAtMs, 100);
  const ready = loadSourceCallableForAudit<(id: number, layer: string) => void>(
    source,
    "handleOverlayVisualReady",
    environment,
  );
  ready(41, "under");
  assert.equal(transferSyncRef.current?.visualOverlayAtMs, 100);
  assert.equal(launched.at(-1), 41);
  assert.equal(flushed.at(-1), "overlay-ready");
  const unbind = loadSourceCallableForAudit<
    (id: number, layer: string) => void
  >(source, "handleOverlayUnbind", environment);
  unbind(42, "over");
  assert.equal(mounted, 41);
  unbind(41, "under");
  assert.equal(mounted, null);
  transferSyncRef.current = createSync({ from: "completed", to: "active" });
  launched.length = 0;
  bind(41, "over");
  assert.deepEqual(
    launched,
    [],
    "upward flight must wait for visual readiness",
  );
  ready(41, "over");
  assert.deepEqual(launched, [41]);
  assert.equal(mounted, 41);
}
function auditOverlayLayout(source: string): void {
  const visualReadySignatureRef: { current: string | null } = { current: null };
  const calls: unknown[][] = [];
  const callback = loadOverlayLayoutCallback(source, {
    visualReadySignatureRef,
    bindSignature: "41:active:completed:0:1",
    flyingState: { habitId: 41 },
    layer: "under",
    onOverlayVisualReadyRef: {
      current: (...args: unknown[]) => calls.push(args),
    },
  });
  const event = {
    nativeEvent: { layout: { width: 360, height: 65, x: 0, y: 10 } },
  };
  callback(event);
  callback(event);
  assert.deepEqual(
    calls,
    [[41, "under"]],
    "native layout must acknowledge its captured overlay once",
  );
}
function auditDropCommit(source: string): void {
  const ownerLeaseRef = { current: { live: false } },
    reordered: number[][] = [];
  const install = loadSourceCallableForAudit<() => () => void>(
    source,
    "installOwnerLease",
    { ownerLeaseRef },
  );
  const admit = loadSourceCallableForAudit<() => boolean>(
    source,
    "admitOwnerCallback",
    { ownerLeaseRef },
  );
  const dispose = install();
  let finalized = 0,
    scheduled = 0;
  const callback = loadSourceCallableForAudit<
    (from: number, to: number) => void
  >(source, "handleDropCommit", {
    admitOwnerCallback: admit,
    itemIdsRef: { current: [1, 2, 3] },
    pendingDropOrderRef: { current: null },
    clearFinalizeTimeout: () => undefined,
    finalizeTimeoutRef: { current: null },
    setTimeout: (_task: () => void, delay: number) => {
      assert.equal(delay, 2500);
      scheduled++;
      return 1;
    },
    finalizeDrop: () => {
      finalized++;
    },
    onReorderRef: { current: (ids: number[]) => reordered.push([...ids]) },
  });
  callback(1, 0);
  assert.deepEqual(reordered, [[2, 1, 3]]);
  assert.equal(scheduled, 1);
  callback(-1, 0);
  callback(1, 1);
  assert.equal(finalized, 2);
  assert.equal(reordered.length, 1);
  dispose();
  callback(0, 2);
  assert.equal(
    reordered.length,
    1,
    "disposed date owner must not persist an order",
  );
  assert.equal(scheduled, 1);
}
function auditDragSessionOwnerAdmission(source: string): void {
  let live = true;
  const sessions: Record<number, number>[] = [];
  const begin = loadArrowContaining<(id: number) => void>(
    source,
    "const ids = itemIdsRef.current;",
    {
      admitOwnerCallback: () => live,
      itemIdsRef: { current: [1, 2, 3] },
      setDragSessionIndexById: (value: Record<number, number>) =>
        sessions.push({ ...value }),
    },
  );
  begin(2);
  assert.deepEqual(sessions, [{ 1: 0, 2: 1, 3: 2 }]);
  live = false;
  begin(1);
  assert.equal(
    sessions.length,
    1,
    "disposed owner must not publish a new drag session",
  );
}
function auditRapidDateIntentReversal(source: string): void {
  const visible = "2026-11-11",
    target = "2026-11-12";
  for (const warm of [false, true])
    for (const busy of [false, true])
      for (const last of [target, "2026-11-13"]) {
        let requested = visible,
          resolved = visible,
          locked = false;
        const pendingDateRequestRef: {
          current: { id: number; toDate: string } | null;
        } = { current: null };
        const readPendingRequest = () => pendingDateRequestRef.current;
        const transferBusyRef = { current: false },
          deferredDateSwitchRef: { current: { date: string } | null } = {
            current: null,
          };
        const apply = (
          value: string,
          update: string | ((value: string) => string),
        ) => (typeof update === "function" ? update(value) : update);
        const common = {
          pendingDateRequestRef,
          dateEpochStartedAtRef: { current: null },
          clearDateEpochSnapRafs: () => undefined,
          setRequestedDateForList: (
            update: string | ((v: string) => string),
          ) => {
            requested = apply(requested, update);
          },
          setResolvedDateForList: (
            update: string | ((v: string) => string),
          ) => {
            resolved = apply(resolved, update);
          },
          setIsDateEpochSnapLock: (value: boolean) => {
            locked = value;
          },
        };
        const cancel = loadSourceCallableForAudit<() => void>(
          source,
          "cancelPrivateDateRequest",
          { ...common, resolvedDateForList: visible },
        );
        const select = loadSourceCallableForAudit<(date: string) => void>(
          source,
          "handleSelectDate",
          {
            ...common,
            cancelPrivateDateRequest: cancel,
            maxSelectableDateStr: "2026-11-13",
            todayDateStr: "2026-11-13",
            transferBusyRef,
            deferredDateSwitchRef,
            resolvedDateForList: visible,
            selectedDate: visible,
            dateRequestSequenceRef: { current: 0 },
            useHabitStore: {
              getState: () => ({
                dayRecordsByDate: warm ? { [target]: [], [last]: [] } : {},
                allDayRecordsLoaded: warm,
              }),
            },
            hasDayListSnapshotForState: () => warm,
            getDayListSnapshotForState: () => undefined,
          },
        );
        select(target);
        assert.equal(requested, target);
        assert.equal(resolved, warm ? target : visible);
        assert.equal(pendingDateRequestRef.current?.toDate, target);
        transferBusyRef.current = busy;
        select(visible);
        assert.equal(
          requested,
          visible,
          "returning to visible date must revoke queued request",
        );
        assert.equal(
          resolved,
          visible,
          "returning to visible date must revoke queued warm publication",
        );
        assert.equal(pendingDateRequestRef.current, null);
        assert.equal(locked, false);
        assert.equal(deferredDateSwitchRef.current, null);
        transferBusyRef.current = false;
        select(last);
        assert.equal(requested, last);
        assert.equal(resolved, warm ? last : visible);
        assert.equal(readPendingRequest()?.toDate, last);
      }
}
function auditOwnerGeometryCallbacks(active: string, completed: string): void {
  assert.doesNotMatch(active, /onListLayout/);
  const layouts: unknown[] = [];
  let live = true;
  const callback = loadArrowContaining<(event: unknown) => void>(
    completed,
    "onToggleLayout?.",
    {
      admitOwnerCallback: () => live,
      onToggleLayout: (layout: unknown) =>
        layouts.push(JSON.parse(JSON.stringify(layout))),
    },
  );
  callback({ nativeEvent: { layout: { height: 56, y: 137 } } });
  live = false;
  callback({ nativeEvent: { layout: { height: 56, y: 7 } } });
  assert.deepEqual(
    layouts,
    [{ height: 56, y: 137 }],
    "disposed completed owner must not overwrite parent geometry",
  );
}
function auditCompletedOwnerDisposal(source: string): void {
  const ownerLeaseRef = { current: { live: false } },
    curtainAnimRef: { current: { id: number } | null } = { current: { id: 4 } };
  const dispose = loadSourceCallableForAudit<() => () => void>(
    source,
    "installOwnerLease",
    { ownerLeaseRef, curtainAnimRef },
  )();
  assert.equal(ownerLeaseRef.current.live, true);
  dispose();
  assert.equal(ownerLeaseRef.current.live, false);
  assert.equal(curtainAnimRef.current, null);
  const finish = loadSourceCallableForAudit<
    (id: number, finished: boolean) => void
  >(source, "handleCurtainAnimFinish", {
    curtainAnimRef,
    latestExpandedRef: { current: false },
    latestBusyRef: { current: false },
    setRowsMounted: () =>
      assert.fail("disposed curtain must not publish state"),
  });
  finish(4, true);
}
function auditHomeReorder(source: string): void {
  const persisted: number[][] = [];
  const callback = loadSourceCallableForAudit<(ids: number[]) => void>(
    source,
    "handleReorderActiveIds",
    {
      activeHabitIds: [1, 2],
      habitOrderIds: [1, 2, 3],
      haveSameIdSet: (a: number[], b: number[]) =>
        a.length === b.length && a.every((id) => b.includes(id)),
      mergeReorderedSubsetIntoOrder: (_full: number[], subset: number[]) => [
        ...subset,
        3,
      ],
      isSameOrder: (a: number[], b: number[]) =>
        a.length === b.length && a.every((id, i) => id === b[i]),
      reorderHabits: async (ids: number[]) => {
        persisted.push([...ids]);
      },
    },
  );
  callback([2, 1]);
  assert.deepEqual(
    persisted,
    [[2, 1, 3]],
    "accepted order command must run exactly once",
  );
  callback([1, 2]);
  callback([1, 4]);
  callback([-1, 2]);
  assert.equal(persisted.length, 1);
}
function auditHomeTodayStripWiring(source: string): void {
  const calls: string[] = [],
    ref: { current: CalendarStripAuditHandle | null } = {
      current: {
        revealToday: () => calls.push("reveal"),
        cancelPendingTodayReveal: () => calls.push("cancel"),
      },
    };
  const select = (date: string) => calls.push("select:" + date);
  const header = loadSourceCallableForAudit<() => void>(
    source,
    "handleHeaderTitlePress",
    {
      calendarStripRef: ref,
      handleSelectDate: select,
      todayDateStr: "2026-11-13",
    },
  );
  header();
  header();
  assert.deepEqual(
    calls,
    ["select:2026-11-13", "reveal", "select:2026-11-13", "reveal"],
    "Header Today must request the viewport",
  );
  calls.length = 0;
  ref.current = null;
  header();
  assert.deepEqual(calls, ["select:2026-11-13"]);
  ref.current = {
    revealToday: () => calls.push("reveal"),
    cancelPendingTodayReveal: () => calls.push("cancel"),
  };
  calls.length = 0;
  loadSourceCallableForAudit<(date: string) => void>(
    source,
    "handleCalendarSelectDate",
    { calendarStripRef: ref, handleSelectDate: select },
  )("2026-11-12");
  loadSourceCallableForAudit<(date: string) => void>(
    source,
    "selectNotificationDate",
    { calendarStripRef: ref, handleSelectDateRef: { current: select } },
  )("2026-11-13");
  assert.deepEqual(calls, [
    "cancel",
    "select:2026-11-12",
    "cancel",
    "select:2026-11-13",
  ]);
}
function auditNotificationPresentation(
  source: string,
  storeSource: string,
): void {
  let state: any;
  const code = ts.transpileModule(storeSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (name === "date-fns/format") return { format: () => "2026-11-13" };
      assert.equal(name, "zustand");
      return {
        create: (make: (set: any) => any) => {
          const set = (update: any) => {
            state = {
              ...state,
              ...(typeof update === "function" ? update(state) : update),
            };
          };
          state = make(set);
          return { getState: () => state };
        },
      };
    },
  });
  state.selectDate("2026-11-10");
  state.requestNotificationPresentation("2026-11-13");
  const first = state.notificationPresentationRequest;
  state.requestNotificationPresentation("2026-11-14");
  const newer = state.notificationPresentationRequest;
  assert.ok(newer.requestId > first.requestId);
  state.completeNotificationPresentation(first.requestId);
  assert.equal(
    state.notificationPresentationRequest,
    newer,
    "late foreign acknowledgement must not clear newer date intent",
  );
  state.completeNotificationPresentation(newer.requestId);
  assert.equal(state.notificationPresentationRequest, null);
  state.requestNotificationPresentation("2026-11-13");
  const selections: string[] = [],
    focus: boolean[] = [];
  const render = (resolved: string, ready: boolean) => {
    const effects: (() => void)[] = [];
    const component = loadTsxCallable<(props: any) => unknown>(
      source,
      "HomeFocusCoordinator",
      {
        useIsFocused: () => true,
        useUIStore: (selector: (s: any) => unknown) => selector(state),
        useLayoutEffect: (effect: () => void) => effects.push(effect),
      },
    );
    component({
      homeContentReady: ready,
      resolvedDateForList: resolved,
      onSelectNotificationDate: (date: string) => selections.push(date),
      onFocusChange: (value: boolean) => focus.push(value),
    });
    effects.forEach((effect) => effect());
  };
  render("2026-11-10", true);
  assert.deepEqual(
    selections,
    ["2026-11-13"],
    "mounted past-day Home must receive reminder date intent",
  );
  assert.ok(state.notificationPresentationRequest);
  render("2026-11-13", false);
  assert.ok(
    state.notificationPresentationRequest,
    "unready Home must not acknowledge requested date",
  );
  render("2026-11-13", true);
  assert.equal(state.notificationPresentationRequest, null);
  const count = selections.length;
  render("2026-11-13", true);
  assert.equal(selections.length, count);
  assert.ok(focus.every(Boolean));
}

function auditCompletedLayoutRegistration(source: string): void {
  const styles = evaluateInitializer<Record<string, unknown>>(
    source,
    "styles",
    {
      StyleSheet: { create: (value: unknown) => value },
      SLOT_HEIGHT: 65,
      SEPARATOR_RENDER_HEIGHT: 1,
    },
  );
  {
    const toggles: unknown[] = [];
    const environment = {
      styles,
      SLOT_HEIGHT: 65,
      SEPARATOR_RENDER_HEIGHT: 1,
      useTranslation: () => ({ t: (key: string) => key }),
      useVisualEffectiveMode: () => "light",
      lightTheme: { muted: "#333333" },
      useRef: (value: unknown) => ({
        current:
          value != null && typeof value === "object" && "live" in value
            ? { ...value, live: true }
            : value,
      }),
      useState: (value: unknown) => [value, () => undefined],
      useMemo: (task: () => unknown) => task(),
      useCallback: (task: unknown) => task,
      useEffect: () => undefined,
      useLayoutEffect: () => undefined,
      useSharedValue: (value: unknown) => ({ value }),
      useAnimatedStyle: (task: () => unknown) => task(),
      View: "view",
      Animated: { View: "animated-view" },
      CompletedHabitRow: "completed-row",
      CompletedSectionToggleVisual: "toggle",
      HabitItem: "item",
    };
    const render = loadTsxCallable<
      (props: Record<string, unknown>) => AuditElement
    >(source, "CompletedHabitsSectionComponent", environment);
    const item = {
      habit: { id: 41, name: "Example" },
      checkboxState: "minimum",
      currentStreak: 2,
    };
    const props = {
      items: [item],
      expanded: true,
      layoutEpoch: "day-A",
      hiddenHabitId: null,
      incomingPlaceholderIndex: null,
      preserveGapSourceIndex: null,
      rowShiftDurationMs: 0,
      isBusy: false,
      preserveHiddenSlot: false,
      onToggleLayout: (layout: unknown) => toggles.push(layout),
    };
    const tree = render(props);
    const curtain = tree.props.children[0] as AuditElement;
    const content = curtain.props.children as AuditElement;
    const row = (content.props.children as AuditElement[])[0];
    assert.equal(
      typeof curtain.props.onLayout,
      "undefined",
      "curtain layout callbacks must be absent in the native tree",
    );
    assert.equal(
      typeof content.props.onLayout,
      "undefined",
      "content layout callbacks must be absent in the native tree",
    );
    const layoutEvent = { nativeEvent: { layout: { height: 65, y: 7 } } };
    curtain.props.onLayout?.(layoutEvent);
    content.props.onLayout?.(layoutEvent);
    const renderRow = loadTsxCallable<
      (props: Record<string, unknown>) => AuditElement
    >(source, "CompletedHabitRow", environment);
    const renderedRow = renderRow(row.props);
    assert.equal(
      typeof renderedRow.props.onLayout,
      "undefined",
      "completed row layout callbacks must be absent in the native tree",
    );
    renderedRow.props.onLayout?.(layoutEvent);
    const toggleHost = tree.props.children[1] as AuditElement;
    assert.equal(
      typeof toggleHost.props.onLayout,
      "function",
      "the transfer geometry owner must remain registered",
    );
    toggleHost.props.onLayout(layoutEvent);
    assert.equal(
      toggles.length,
      1,
      "transfer toggle geometry must still reach its product owner",
    );
    const collapsed = render({
      ...props,
      expanded: false,
      layoutEpoch: "day-B",
    });
    assert.equal(
      collapsed.props.children[0].props.children.props.children,
      null,
      "collapsed completed rows must remain unmounted during a date change",
    );
    const reopened = render({ ...props, layoutEpoch: "day-B" });
    assert.equal(
      reopened.props.children[0].props.children.props.children[0].props
        .checkboxVisualEpoch,
      "day-B",
    );
  }
}

function auditTransferCommit(source: string): void {
  for (const [reason, planned, sourceKind, expected] of [
    ["overlay-ready", 180, "checkbox", 48],
    ["fallback", 180, "checkbox", 140],
    ["overlay-ready", 180, "zero-distance", 0],
    ["overlay-ready", 600, "checkbox", 430],
  ] as const) {
    const sync = createSync({
      source: sourceKind,
      plannedFlightDurationMs: planned,
      rowShiftDurationMs: planned,
      startedAtMs: 100,
      flightLaunchedAtMs: 110,
    });
    const durations: number[] = [];
    const cleared: number[] = [];
    let commits = 0;
    const pendingCommitRef: {
      current: { habitId: number; runCommit: () => void } | null;
    } = { current: null };
    const pendingCommitTimeoutRef = { current: 7 as number | null };
    pendingCommitRef.current = {
      habitId: 41,
      runCommit: () => {
        assert.equal(
          pendingCommitRef.current,
          null,
          "commit must release its queue owner before dispatch",
        );
        assert.equal(
          pendingCommitTimeoutRef.current,
          null,
          "commit must cancel fallback before dispatch",
        );
        commits += 1;
      },
    };
    const flush = loadSourceCallableForAudit<(reason: string) => void>(
      source,
      "flushPendingCommit",
      {
        pendingCommitRef,
        pendingCommitTimeoutRef,
        transferSyncRef: { current: sync },
        Date: { now: () => 150 },
        ROW_SHIFT_DURATION_MS: 62.5,
        COMMIT_TO_LAYOUT_LAG_COMPENSATION_MS: 130,
        MIN_ROW_SHIFT_REMAINING_FRACTION: 0.35,
        SHORT_FLIGHT_ROW_SHIFT_THRESHOLD_MS: 300,
        SHORT_FLIGHT_MIN_ROW_SHIFT_MS: 48,
        LONG_FLIGHT_MIN_ROW_SHIFT_MS: 72,
        SHORT_FLIGHT_MAX_LAG_AFTER_REMAINING_MS: 36,
        clearTimeout: (timer: number) => cleared.push(timer),
        updateRowShiftDuration: (duration: number) => durations.push(duration),
      },
    );
    flush(reason);
    flush(reason);
    assert.equal(
      commits,
      1,
      "a queued transfer must dispatch its durable command exactly once",
    );
    assert.deepEqual(cleared, [7]);
    assert.deepEqual(
      durations,
      [expected],
      "transfer commit must preserve remaining-flight pacing",
    );
    assert.equal(sync.commitFlushedAtMs, 150);
    assert.equal(sync.rowShiftDurationMs, expected);
  }
}

function auditTransferCompletionHold(source: string): void {
  for (const [overrides, delay] of [
    [{ source: "zero-distance", overlayBindAtMs: null }, 90],
    [{ overlayBindAtMs: 100, visualOverlayAtMs: null }, 40],
    [{ overlayBindAtMs: 100, visualOverlayAtMs: 110 }, null],
    [{ overlayBindAtMs: 20, visualOverlayAtMs: null }, null],
  ] as const) {
    const sync = createSync(overrides);
    const pendingFlightCompletionRef = {
      current: { habitId: 41 } as { habitId: number } | null,
    };
    const delayedFlightCompleteTimeoutRef = { current: null as number | null };
    const timers: { task: () => void; delay: number }[] = [];
    let finalized = 0;
    const finish = loadSourceCallableForAudit<() => void>(
      source,
      "handleFlightComplete",
      {
        Date: { now: () => 120 },
        transferSyncRef: { current: sync },
        pendingFlightCompletionRef,
        delayedFlightCompleteTimeoutRef,
        ZERO_DISTANCE_OVERLAY_WAIT_MS: 90,
        MIN_VISIBLE_FLIGHT_AFTER_BIND_MS: 60,
        clearDelayedFlightCompleteTimeout: () => undefined,
        setTimeout: (task: () => void, timeout: number) => {
          timers.push({ task, delay: timeout });
          return 1;
        },
        finalizeFlightCompletion: () => {
          finalized += 1;
        },
      },
    );
    finish();
    assert.equal(sync.flightCompletedAtMs, 120);
    assert.equal(pendingFlightCompletionRef.current, null);
    if (delay == null) {
      assert.equal(
        finalized,
        1,
        "a visibly completed transfer must release its lock",
      );
      assert.equal(timers.length, 0);
    } else {
      assert.equal(
        finalized,
        0,
        "an unpresented transfer must retain its visibility hold",
      );
      assert.equal(
        timers.length,
        1,
        "an unpresented transfer must retain its visibility hold",
      );
      assert.equal(
        timers[0].delay,
        delay,
        "transfer visibility hold must retain its established deadline",
      );
      timers[0].task();
      assert.equal(finalized, 1);
      assert.equal(delayedFlightCompleteTimeoutRef.current, null);
    }
  }
}

function auditSectionFlightLaunch(source: string): void {
  const completions: number[] = [];
  const callbacks: ((finished: boolean) => void)[] = [];
  const isFlying = { value: true };
  const progress = { value: 0 };
  let fallbackClears = 0;
  const launch = loadSourceCallableForAudit<(id: number) => void>(
    source,
    "beginFlight",
    {
      pendingHabitIdRef: { current: 41 },
      pendingDurationMsRef: { current: 180 },
      hasLaunchedRef: { current: false },
      isFlying,
      progress,
      FLIGHT_EASING: "linear",
      clearLaunchFallback: () => {
        fallbackClears += 1;
      },
      withTiming: (
        target: number,
        options: { duration: number; easing: string },
        done: (finished: boolean) => void,
      ) => {
        assert.equal(target, 1);
        assert.deepEqual({ ...options }, { duration: 180, easing: "linear" });
        callbacks.push(done);
        return target;
      },
      runOnJS: (callback: (id: number) => void) => callback,
      handleFlightComplete: (id: number) => completions.push(id),
    },
  );
  launch(42);
  assert.equal(callbacks.length, 0);
  launch(41);
  launch(41);
  assert.equal(
    callbacks.length,
    1,
    "a prepared flight must launch its native animation once",
  );
  assert.equal(fallbackClears, 1);
  callbacks[0](false);
  assert.deepEqual(completions, []);
  assert.equal(isFlying.value, true);
  callbacks[0](true);
  assert.equal(isFlying.value, false);
  assert.deepEqual(
    completions,
    [41],
    "a finished native animation must deliver its product completion callback",
  );
}

function auditReasonCommandDate(source: string): void {
  assert.match(source, /currentLocalDate=\{todayDateStr\}/,
    "the isolated reason overlay must receive date-owner publications");
  const slots: unknown[] = [];
  let cursor = 0;
  const cleanups: (() => void)[] = [];
  const target: { current: { open: (args: unknown) => void } | null } = { current: null };
  const calls: unknown[][] = [];
  let available = true;
  let today = "2026-11-15";
  let applyAccepted = true;
  const render = loadTsxCallable<(props: Record<string, unknown>, ref: unknown) => AuditElement>(
    source,
    "HomeFailureReasonController",
    {
      React: {
        forwardRef: (component: unknown) => component,
        useImperativeHandle: (ref: typeof target, create: () => NonNullable<typeof target.current>) => {
          ref.current = create();
        },
      },
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (update: unknown) => {
          slots[index] = typeof update === "function" ? update(slots[index]) : update;
        }];
      },
      useRef: (initial: unknown) => {
        const index = cursor++;
        return slots[index] ?? (slots[index] = { current: initial });
      },
      useCallback: (callback: unknown, dependencies: unknown[]) => {
        const index = cursor++;
        const previous = slots[index] as { callback: unknown; dependencies: unknown[] } | undefined;
        if (previous && previous.dependencies.length === dependencies.length &&
            previous.dependencies.every((value, item) => Object.is(value, dependencies[item]))) {
          return previous.callback;
        }
        slots[index] = { callback, dependencies };
        return callback;
      },
      useLayoutEffect: (effect: () => () => void) => {
        if (cleanups.length === 0) cleanups.push(effect());
      },
      FailureReasonDialog: "reason-dialog",
      format: () => today,
    },
  );
  const update = (sceneDate: string) => {
    cursor = 0;
    return render({
      currentLocalDate: today,
      canSubmit: loadSourceCallableForAudit<(date: string) => boolean>(source, "canSubmitFailureReason", {
        transferBusyRef: { get current() { return !available; } }, getIsTransferBusy: () => false,
        format: () => today,
      }),
      onSubmit: (...args: unknown[]) => {
        calls.push([sceneDate, ...args]);
        return applyAccepted;
      },
    }, target);
  };
  update("2026-11-13");
  target.current!.open({ habitId: 41, date: "2026-11-13", status: "failure" });
  update("2026-11-13");
  const changedScene = update("2026-11-14");
  available = false;
  assert.equal(changedScene.props.onSave("Example reason"), false,
    "a reason refused before dismissal must remain retryable");
  assert.equal(update("2026-11-14").props.visible, true,
    "a refused reason must preserve the visible draft session");
  assert.equal(calls.length, 0);
  available = true;
  const retry = update("2026-11-14");
  assert.equal(retry.props.onSave("Example reason"), true);
  assert.equal(retry.props.onSave("Example reason"), false,
    "same-turn reason delivery must have one pending command");
  const dismissed = update("2026-11-15");
  assert.equal(dismissed.props.visible, false);
  assert.equal(calls.length, 0, "a reason command must wait for physical dismissal");
  const modalSource = read("src/components/ui/AppModal.tsx");
  const lifecycleSource = read("src/components/ui/app-modal-native-lifecycle.ts");
  const pointerEvents = loadSourceCallableForAudit<(args: unknown) => string>(
    lifecycleSource, "resolveAndroidAppModalPointerEvents", {},
  );
  assert.equal(pointerEvents({ visible: false, fading: true }), "box-only",
    "a dismissing reason host must block underlying transfer input");
  const modalSteps: string[] = [];
  const finishDismiss = loadSourceCallableForAudit<(state: string, generation: number) => void>(
    modalSource, "finishAndroidFade", {
      transitionRef: { current: { generation: 7, visible: false } },
      isCurrentAndroidAppModalFadeCompletion: loadSourceCallableForAudit(
        lifecycleSource, "isCurrentAndroidAppModalFadeCompletion", {},
      ),
      androidFadeStartedRef: { current: null },
      androidFadeCompletedRef: { current: null },
      setAndroidFadeCompositingActive: () => {},
      setPortalVisibility: () => modalSteps.push("schedule-host-removal"),
      onDismissRef: { current: () => {
        modalSteps.push("apply-command");
        dismissed.props.onDismiss();
      } },
    },
  );
  finishDismiss("dismissed", 7);
  modalSteps.push("next-underlying-input");
  assert.deepEqual(modalSteps, ["schedule-host-removal", "apply-command", "next-underlying-input"],
    "physical dismissal must apply the reason in the same stack before underlying input resumes");
  assert.deepEqual(calls, [["2026-11-15", 41, "2026-11-13", "failure", "Example reason"]],
    "a reason command must keep its opening date across scene changes and post-dismiss handoff");
  cleanups.forEach((cleanup) => cleanup());
  assert.equal(calls.length, 1, "dismissal and cleanup must not duplicate the captured reason command");

  today = "2031-04-05";
  target.current!.open({ habitId: 41, date: today, status: "failure" });
  let clockSession = update(today);
  today = "2031-04-04";
  clockSession = update(today);
  assert.equal(clockSession.props.onSave("Clock reason"), false,
    "a captured date that is already future must refuse Save without dismissal");
  assert.equal(update(today).props.visible, true);
  assert.equal(typeof update(today).props.onCancel, "function",
    "clock rollback while open must retain an explicit cancel action");
  today = "2031-04-05";
  assert.equal(update(today).props.onSave("Clock reason"), true);
  today = "2031-04-04";
  update(today).props.onDismiss();
  let recovered = update(today);
  assert.equal(recovered.props.visible, true,
    "clock rollback during dismissal must restore the reason session");
  assert.equal(recovered.props.initialReason, "Clock reason",
    "post-dismiss refusal must restore the accepted reason draft");
  assert.equal(recovered.props.status, "failure");
  assert.equal(typeof recovered.props.onCancel, "function",
    "post-dismiss future recovery must expose an explicit escape");
  assert.equal((slots[0] as { date: string }).date, "2031-04-05");
  assert.equal(calls.length, 1, "a newly future command must not reach its record adapter");
  recovered.props.onDismiss();
  assert.equal(update(today).props.visible, true,
    "duplicate stale dismissal must not clear the restored session");

  const renderReason = loadTsxCallable<(props: Record<string, unknown>) => AuditElement>(
    read("src/features/habits/components/FailureReasonDialog.tsx"),
    "FailureReasonDialogSession", {
      useState: (initial: unknown) => [initial, () => {}],
      useRef: (initial: unknown) => ({ current: initial }),
      useTranslation: () => ({ t: (key: string) => key }),
      useVisualEffectiveMode: () => "light",
      Dialog: "dialog", TextInput: "input",
    },
  );
  const wrapReason = loadTsxCallable<(props: Record<string, unknown>) => AuditElement>(
    read("src/features/habits/components/FailureReasonDialog.tsx"),
    "FailureReasonDialogComponent", {
      useRetainedModalSession: (_visible: boolean, createSnapshot: () => unknown) => ({
        session: { key: 2, snapshot: createSnapshot() }, handleDismiss: () => {},
      }),
      FailureReasonDialogSession: "reason-session",
    },
  );
  const recoveredDialog = renderReason(wrapReason(recovered.props).props);
  assert.equal(recoveredDialog.props.children.props.value, "Clock reason",
    "the restored physical dialog must seed its actual TextInput with the captured reason");
  assert.equal(recoveredDialog.props.actions[0].label, "common.cancel");
  assert.equal(recoveredDialog.props.actions[0].role, "cancel");
  recoveredDialog.props.actions[0].onPress();
  update(today).props.onDismiss();
  assert.equal(update(today).props.visible, false);
  assert.equal(calls.length, 1, "explicit future cancellation must not dispatch a status command");

  today = "2031-04-05";
  target.current!.open({ habitId: 41, date: today, status: "failure" });
  update(today);
  assert.equal(update(today).props.onSave("Reversal reason"), true);
  today = "2031-04-04";
  update(today);
  target.current!.open({ habitId: 42, date: today, status: "skipped" });
  recovered = update(today);
  assert.equal(recovered.props.initialReason, "Reversal reason",
    "a refused close-open handoff must not overwrite the restored draft");
  assert.equal(recovered.props.status, "failure");
  assert.equal((slots[0] as { habitId: number }).habitId, 41);

  today = "2031-04-05";
  applyAccepted = false;
  assert.equal(update(today).props.onSave("Refused reason"), true);
  update(today).props.onDismiss();
  assert.equal(update(today).props.initialReason, "Refused reason",
    "actual transfer refusal after dismissal must restore the same draft");
  applyAccepted = true;
  assert.equal(update(today).props.onSave("Retried reason"), true);
  target.current!.open({ habitId: 42, date: today, status: "skipped" });
  assert.equal(update(today).props.initialReason, "",
    "a normal new dialog session must not inherit a previous reason");
  const normalDialog = renderReason(wrapReason(update(today).props).props);
  assert.equal(normalDialog.props.actions[0].label, "common.cancel",
    "every reason session must expose cancellation instead of submitting an empty reason");
  assert.equal(normalDialog.props.actions[0].role, "cancel");
  assert.equal(calls.filter((call) => call[4] === "Retried reason").length, 1,
    "a successful close-open handoff must dispatch once before a new session");
  assert.equal(update(today).props.onSave("Unmount reason"), true);
  update(today).props.onCancel();
  assert.equal(update(today).props.visible, false,
    "late cancellation must not reopen a submitted reason");
  today = "2031-04-04";
  cleanups.forEach((cleanup) => cleanup());
  assert.equal(update(today).props.visible, false,
    "cleanup refusal must not resurrect an unmounted reason dialog");

  for (const status of ["failure", "skipped"]) {
    today = "2031-04-05";
    const before: number = calls.length;
    target.current!.open({ habitId: 42, date: today, status });
    const cancelled = update(today);
    assert.equal(typeof cancelled.props.onCancel, "function",
      "ordinary reason sessions must expose cancellation");
    cancelled.props.onCancel();
    const hidden = update(today);
    assert.equal(hidden.props.visible, false);
    assert.equal(hidden.props.onSave("Discarded reason"), false,
      "a cancelled session must refuse a new submission");
    hidden.props.onDismiss();
    cleanups.forEach((cleanup) => cleanup());
    assert.equal(calls.length, before,
      "cancellation, dismissal and unmount must not submit a reason or status");
    target.current!.open({ habitId: 42, date: today, status });
    const saving = update(today);
    assert.equal(saving.props.initialReason, "");
    assert.equal(saving.props.onSave("Accepted reason"), true);
    saving.props.onCancel();
    update(today).props.onDismiss();
    assert.equal(calls.length, before + 1,
      "late cancellation must not discard an accepted status command");
  }

  const persisted: unknown[][] = [];
  const transferred: unknown[][] = [];
  const visibleDate = { current: "2026-11-14" };
  const pendingStatusReasonRef = { current: null as unknown };
  const transferBusyRef = { current: false };
  let transferBusy = false;
  let transferAccepted = true;
  const apply = loadSourceCallableForAudit<(...args: unknown[]) => boolean>(source, "handleFailureSubmit", {
    resolvedDateForListRef: visibleDate,
    interactiveDateForLists: visibleDate.current,
    pendingStatusReasonRef,
    transferBusyRef,
    getIsTransferBusy: () => transferBusy,
    markDay: async (...args: unknown[]) => { persisted.push(args); },
    transfer: {
      getIsTransferBusy: () => transferBusy,
      handleContextAction: (...args: unknown[]) => {
        if (transferAccepted) transferred.push(args);
        return transferAccepted;
      },
    },
  });
  assert.equal(apply(41, "2026-11-13", "failure", "Example reason"), true);
  assert.deepEqual(persisted, [[41, "2026-11-13", "failure", "Example reason"]],
    "a captured offscreen date must persist without animating the visible day");
  assert.equal(transferred.length, 0);
  assert.equal(apply(41, "2026-11-14", "skipped", null), true);
  assert.deepEqual(transferred, [[41, "skipped"]], "a same-date reason keeps the existing transfer path");
  for (const owner of ["synchronous", "rendered"]) {
    transferBusy = owner === "synchronous";
    transferBusyRef.current = owner === "rendered";
    assert.equal(apply(41, visibleDate.current, "failure", "Blocked reason"), false,
      "a busy transfer must refuse a reason without claiming acceptance");
    assert.equal(pendingStatusReasonRef.current, null,
      "a refused reason must not leak into a later unrelated record command");
  }
  transferBusy = false;
  transferBusyRef.current = false;
  transferAccepted = false;
  assert.equal(apply(41, visibleDate.current, "failure", "Blocked reason"), false);
  assert.equal(pendingStatusReasonRef.current, null,
    "actual transfer refusal must release only its own pending reason");
  assert.equal(persisted.length, 1, "refused reasons must not reach persistence");
  assert.equal(transferred.length, 1);
}

function auditContextAdmission(source: string): void {
  const menus: unknown[] = [];
  const reasons: unknown[] = [];
  let synchronousBusy = false;
  const transferBusyRef = { current: false };
  const environment = {
    listIsFuture: false,
    interactiveDateForLists: "2031-04-05",
    transferBusyRef,
    getIsTransferBusy: () => synchronousBusy,
    transfer: { getIsTransferBusy: () => synchronousBusy },
    habitMenuRef: { current: { open: (args: unknown) => menus.push(args) } },
    failureReasonRef: { current: { open: (args: unknown) => reasons.push(args) } },
    useSettingsStore: { getState: () => ({ askFailureReason: true }) },
    format: () => "2031-04-05",
  };
  const menu = loadSourceCallableForAudit<(id: number, x: number, y: number) => void>(
    source, "openContextMenu", environment,
  );
  const action = loadSourceCallableForAudit<(id: number, status: string) => void>(
    source, "handleContextAction", environment,
  );
  const canSubmit = loadSourceCallableForAudit<(date: string) => boolean>(
    source, "canSubmitFailureReason", environment,
  );
  for (const owner of ["synchronous", "rendered"]) {
    synchronousBusy = owner === "synchronous";
    transferBusyRef.current = owner === "rendered";
    menu(41, 10, 20);
    action(41, "failure");
    assert.equal(canSubmit("2031-04-05"), false, "a busy transfer must preserve the pending reason draft");
    assert.equal(menus.length, 0, "busy-at-open must not admit a context menu");
    assert.equal(reasons.length, 0, "busy-after-menu must not admit a reason dialog");
  }
  synchronousBusy = false;
  transferBusyRef.current = false;
  assert.equal(canSubmit("2031-04-05"), true);
  assert.equal(canSubmit("2031-04-06"), false,
    "reason preflight must reject a captured date that is already future");
  menu(41, 10, 20);
  action(41, "failure");
  assert.equal(menus.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(reasons)), [{ habitId: 41, date: "2031-04-05", status: "failure" }],
    "input after transfer readiness must preserve the captured date");
}

function auditCheckboxCommandFeedback(source: string): void {
  const tree = ts.createSourceFile("checkbox.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const variant of ["CheckboxCircleStatic", "CheckboxCircleAnimated"]) {
    const declaration = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === variant);
    assert.ok(declaration);
    for (const accepted of [false, true]) {
      const events: string[] = [];
      const paints: (() => void)[] = [];
      const press = loadSourceCallableForAudit<(event: unknown) => void>(
        declaration.getText(tree), "handlePress", {
          state: "unmarked", disabled: false, readOnly: false,
          onPress: () => { events.push("admission"); return accepted; },
          runAfterUiPaint: (callback: () => void) => paints.push(callback),
          useSettingsStore: { getState: () => ({ soundEnabled: true }) },
          playHabitExecutionSound: () => { events.push("sound"); return Promise.resolve(); },
          Haptics: { NotificationFeedbackType: { Success: "success" }, notificationAsync: () => {
            events.push("haptic"); return Promise.resolve();
          } },
          pressOverlay: { value: 0 }, pressScale: { value: 1 },
          cancelAnimation: () => events.push("cancel-animation"),
          withTiming: () => { events.push("animation"); return 0; },
          withSequence: () => 1,
          Easing: { out: () => null, ease: null },
        },
      );
      press({ stopPropagation: () => {} });
      assert.equal(paints.length, accepted ? 1 : 0,
        "checkbox success feedback must follow actual command admission");
      if (!accepted) assert.deepEqual(events, ["admission"],
        "refused checkbox commands must not animate or announce success");
      paints.forEach((paint) => paint());
      if (accepted) assert.deepEqual(events.slice(-2), ["sound", "haptic"]);
    }
  }
}

function auditUniqueOrderMembership(source: string): void {
  const sameIds = loadSourceCallableForAudit<(left: number[], right: number[]) => boolean>(
    source, "haveSameIdSet", {},
  );
  for (const [left, right, expected] of [
    [[], [], true],
    [[1, 2], [2, 1], true],
    [[1, 2], [1, 1], false],
    [[1, 1], [1, 2], false],
    [[1, 1], [1, 1], false],
    [[1, 2], [1, 3], false],
    [[1, 2], [1], false],
  ] as const) {
    assert.equal(sameIds([...left], [...right]), expected,
      "order membership must require a unique permutation on both sides");
  }
}

const audits = [
  () => auditContextAdmission(homeSource),
  () => auditCheckboxCommandFeedback(checkboxSource),
  () => auditUniqueOrderMembership(read("src/features/habits/utils/order.ts")),
  () => auditReasonCommandDate(homeSource),
  () => auditDateOwnerKeys(homeSource),
  () => auditRapidDateIntentReversal(homeSource),
  () => auditPhysicalCallbackRefPhases(homeSource, calendarStripSource),
  () => auditOwnerLeaseRegistration(activeListSource),
  () => auditOwnerLeaseRegistration(completedSource),
  () => auditDragSessionOwnerAdmission(activeListSource),
  () => auditOwnerGeometryCallbacks(activeListSource, completedSource),
  () => auditCompletedOwnerDisposal(completedSource),
  () => auditCheckboxAnimatedInitializers(checkboxSource),
  () => auditStaticBottomSeparator(activeListSource),
  () => auditCheckboxPresentationIdentity(itemSource),
  () => auditRowEpochComparators(activeListSource, completedSource),
  () => auditCompletedLayoutRegistration(completedSource),
  () => auditCalendarStripTodayReveal(calendarStripSource),
  () => auditHomeTodayStripWiring(homeSource),
  () => auditTransferStart(transferSource),
  () => auditOverlayCallback(transferSource),
  () => auditOverlayLayout(overlaySource),
  () => auditDropCommit(activeListSource),
  () => auditHomeReorder(homeSource),
  () =>
    auditNotificationPresentation(homeSource, read("src/stores/ui-store.ts")),
  () => auditTransferCommit(transferSource),
  () => auditTransferCompletionHold(transferSource),
  () =>
    auditSectionFlightLaunch(
      read("src/features/habits/animation/useSectionFlight.ts"),
    ),
];
for (const run of audits) run();
let mutations = 0;
for (const [source, completed] of [
  [activeListSource, false],
  [completedSource, true],
] as const) {
  auditInitialHeightSynchronization(source, completed);
  for (const [name, before, after] of [
    ["forced-read", "initialHeightRef.current === target", "false"],
    ["unchecked-seed", "initialHeightRef.current === target", "true"],
    [
      "retained-seed",
      "initialHeightRef.current = null;",
      "void initialHeightRef;",
    ],
  ] as const) {
    assertMutationKilled(
      name,
      source,
      (value) => replaceExactlyOnce(value, before, after),
      (value) => auditInitialHeightSynchronization(value, completed),
      /initial height synchronization must/,
    );
    mutations++;
  }
}
const mutationCases: [
  string,
  string,
  string | RegExp,
  string,
  (s: string) => void,
  RegExp,
][] = [
  [
    "reason-date-publication",
    homeSource,
    "currentLocalDate={todayDateStr}",
    "",
    auditReasonCommandDate,
    /date-owner publications/,
  ],
  [
    "reason-cancel",
    homeSource,
    "onCancel={cancel}",
    "onCancel={undefined}",
    auditReasonCommandDate,
    /explicit cancel/,
  ],
  [
    "reason-future-preflight",
    homeSource,
    'date <= format(new Date(), "yyyy-MM-dd") &&',
    "true &&",
    auditContextAdmission,
    /already future/,
  ],
  [
    "reason-post-dismiss-date-admission",
    homeSource,
    "canSubmitRef.current(pending.date) && onSubmitRef.current(",
    "onSubmitRef.current(",
    auditReasonCommandDate,
    /clock rollback during dismissal/,
  ],
  [
    "reason-refusal-draft",
    homeSource,
    'initialReason: pending.reason ?? "",',
    'initialReason: "",',
    auditReasonCommandDate,
    /restore the accepted reason draft/,
  ],
  [
    "reason-reversal-draft",
    homeSource,
    "if (!flushPendingSubmit()) return;",
    "flushPendingSubmit();",
    auditReasonCommandDate,
    /must not overwrite/,
  ],
  [
    "reason-cleanup-no-reopen",
    homeSource,
    "flushPendingSubmit(false);",
    "flushPendingSubmit();",
    auditReasonCommandDate,
    /must not resurrect/,
  ],
  [
    "reason-save-admission",
    homeSource,
    "if (!canSubmit(session.date))",
    "if (false)",
    auditReasonCommandDate,
    /refused before dismissal/,
  ],
  [
    "reason-refusal-cleanup",
    homeSource,
    "!accepted && pendingStatusReasonRef.current === pendingReason",
    "false",
    auditReasonCommandDate,
    /actual transfer refusal/,
  ],
  [
    "context-menu-admission",
    homeSource,
    "habitId <= 0 || listIsFuture || transferBusyRef.current || getIsTransferBusy()",
    "habitId <= 0 || listIsFuture",
    auditContextAdmission,
    /busy-at-open/,
  ],
  [
    "reason-dialog-admission",
    homeSource,
    "if (listIsFuture || transferBusyRef.current || getIsTransferBusy())",
    "if (listIsFuture)",
    auditContextAdmission,
    /busy-after-menu/,
  ],
  [
    "reason-preflight-admission",
    homeSource,
    "!transferBusyRef.current && !getIsTransferBusy()",
    "true",
    auditContextAdmission,
    /pending reason draft/,
  ],
  [
    "checkbox-feedback-admission",
    checkboxSource,
    /if \(!onPress\(\)\) return;\s*runAfterUiPaint/,
    "onPress(); runAfterUiPaint",
    auditCheckboxCommandFeedback,
    /command admission/,
  ],
  [
    "checkbox-row-admission",
    itemSource,
    "return onCheckboxPress(habitId);",
    "onCheckboxPress(habitId);",
    auditCheckboxPresentationIdentity,
    /preserve transfer admission/,
  ],
  [
    "unique-order-membership",
    read("src/features/habits/utils/order.ts"),
    " || new Set(b).size !== b.length",
    "",
    auditUniqueOrderMembership,
    /unique permutation/,
  ],
  [
    "reason-opening-date",
    homeSource,
    "date: session.date,",
    "date: \"2026-11-14\",",
    auditReasonCommandDate,
    /opening date/,
  ],
  [
    "reason-current-handler",
    homeSource,
    /onSubmitRef\.current\(\s*pending.habitId,\s*pending.date,\s*pending.status,\s*pending.reason,?\s*\);/,
    "onSubmit(pending.habitId, pending.date, pending.status, pending.reason);",
    auditReasonCommandDate,
    /opening date/,
  ],
  [
    "reason-offscreen-date",
    homeSource,
    "date !== resolvedDateForListRef.current",
    "false",
    auditReasonCommandDate,
    /offscreen date/,
  ],
  [
    "date-request-owner",
    homeSource,
    /\(pendingDateRequestRef.current != null &&\s*pendingDateRequestRef.current.toDate !== resolvedDateForList\)/,
    "false",
    auditRapidDateIntentReversal,
    /revoke queued request/,
  ],
  [
    "date-return-warm",
    homeSource,
    "setResolvedDateForList(resolvedDateForList);",
    "",
    auditRapidDateIntentReversal,
    /revoke queued warm publication/,
  ],
  [
    "drop-command",
    homeSource,
    "reorderHabits(fullOrder)",
    "Promise.resolve()",
    auditHomeReorder,
    /accepted order command/,
  ],
  [
    "active-date-key",
    homeSource,
    "key={\x60active-\x24{layoutEpoch}\x60}",
    "key={\x60active-\x24{selectedDate}\x60}",
    auditDateOwnerKeys,
    /Expected values/,
  ],
  [
    "completed-date-key",
    homeSource,
    "key={\x60completed-\x24{layoutEpoch}\x60}",
    "key={\x60completed-\x24{selectedDate}\x60}",
    auditDateOwnerKeys,
    /Expected values/,
  ],
  [
    "active-owner-dispose",
    activeListSource,
    "lease.live = false;",
    "lease.live = true;",
    auditDropCommit,
    /disposed date owner/,
  ],
  [
    "drag-owner-admission",
    activeListSource,
    /if \(!admitOwnerCallback\(\)\) \{\s*return;\s*\}\s*const ids = itemIdsRef.current;/,
    "const ids = itemIdsRef.current;",
    auditDragSessionOwnerAdmission,
    /disposed owner/,
  ],
  [
    "curtain-owner-dispose",
    completedSource,
    /lease\.live = false;\s*curtainAnimRef\.current = null;/,
    "lease.live = false; void curtainAnimRef.current;",
    auditCompletedOwnerDisposal,
    /Expected values|disposed curtain/,
  ],
  [
    "owner-layout-phase",
    activeListSource,
    "useLayoutEffect(installOwnerLease, [installOwnerLease]);",
    "useEffect(installOwnerLease, [installOwnerLease]);",
    auditOwnerLeaseRegistration,
    /layout phase/,
  ],
  [
    "calendar-input-phase",
    calendarStripSource,
    /useLayoutEffect\(\(\) => \{\s*onSelectDateRef.current = onSelectDate;\s*\}, \[onSelectDate\]\);/,
    "useEffect(() => { onSelectDateRef.current = onSelectDate; }, [onSelectDate]);",
    (value) => auditPhysicalCallbackRefPhases(homeSource, value),
    /before native input/,
  ],
  [
    "today-native-end",
    calendarStripSource,
    "scroll.scrollToEnd({ animated: false });",
    "scroll.scrollTo({ x: initialOffset, animated: false });",
    auditCalendarStripTodayReveal,
    /exact right edge|Expected values/,
  ],
  [
    "today-wiring",
    homeSource,
    "calendarStripRef.current?.revealToday();",
    "void calendarStripRef.current;",
    auditHomeTodayStripWiring,
    /Header Today/,
  ],
  [
    "same-tone-owner",
    itemSource,
    "committedCheckboxVisual.state !== checkboxState",
    "true",
    auditCheckboxPresentationIdentity,
    /Expected values/,
  ],
  [
    "different-tone-owner",
    itemSource,
    "committedCheckboxVisual.state !== checkboxState",
    "false",
    auditCheckboxPresentationIdentity,
    /Expected values/,
  ],
  [
    "static-separator",
    activeListSource,
    /rowBottomSeparator:\s*\{\s*opacity: 1,/,
    "rowBottomSeparator: { opacity: 0,",
    auditStaticBottomSeparator,
    /full opacity/,
  ],
  [
    "transfer-durable-command",
    transferSource,
    "pending.runCommit();",
    "void pending;",
    auditTransferCommit,
    /durable command exactly once/,
  ],
  [
    "transfer-visibility-hold",
    transferSource,
    "MIN_VISIBLE_FLIGHT_AFTER_BIND_MS - visibleAfterBindMs",
    "0",
    auditTransferCompletionHold,
    /visibility hold/,
  ],
  [
    "flight-completion-delivery",
    read("src/features/habits/animation/useSectionFlight.ts"),
    "runOnJS(handleFlightComplete)(habitId);",
    "void habitId;",
    auditSectionFlightLaunch,
    /product completion callback/,
  ],
];
for (const [name, source, before, after, audit, message] of mutationCases) {
  assertMutationKilled(
    name,
    source,
    (value) => replaceExactlyOnce(value, before, after),
    audit,
    message,
  );
  mutations++;
}
async function auditFutureReasonStoreRefusal(removeFutureGuard = false): Promise<void> {
  const today = format(new Date(), "yyyy-MM-dd");
  const futureDate = format(addDays(new Date(), 1), "yyyy-MM-dd");
  const habit = {
    id: 41, name: "Example habit", description: null, descriptionVisible: false,
    repeatSchedule: { type: "daily" as const }, startDate: today,
    reminderEnabled: false, reminderTime: null, displayOrder: 0,
    isArchived: false, archivedAt: null, archiveHistory: [], createdAt: 1, updatedAt: 1,
  };
  const loaded = loadHabitStoreForAudit({ habits: [habit], records: [] }, removeFutureGuard ? {
    transform: (source) => replaceExactlyOnce(source,
      'if (date > format(new Date(), "yyyy-MM-dd")) return false;', ""),
  } : {});
  const store = loaded.storeModule.useHabitStore;
  await store.getState().loadHabits();
  await store.getState().loadAllDayRecords();
  assert.equal(await store.getState().markDay(41, futureDate, "failure", "Example reason"), false,
    "the actual store must refuse a newly future reason command");
  assert.deepEqual(loaded.persistence.snapshotRecords(), [],
    "future reason refusal must not persist a record");
}
const auditDeadline = setTimeout(() => {
  console.error("Home interactions audit did not complete within 10 seconds");
  process.exitCode = 1;
}, 10_000);
void (async () => {
  await auditReasonDialogCancellation(loadTsxCallable);
  await auditFutureReasonStoreRefusal();
  await assert.rejects(() => auditFutureReasonStoreRefusal(true), {
    name: "AssertionError", message: /actual store must refuse/,
  });
  console.log(
    "Home interactions audit passed: " + (audits.length + 1) +
      " product groups, 6 height-seed mutants and " + (mutations - 6 + 1) +
      " interaction mutants.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => clearTimeout(auditDeadline));
