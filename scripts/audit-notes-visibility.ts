import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  getNoteComposerBottomPadding,
  getNoteKeyboardLayoutMetrics as getLiveNoteKeyboardLayoutMetrics,
  getReportedKeyboardOverlap as getLiveReportedKeyboardOverlap,
} from "../src/features/notes/utils/keyboard-layout";
import { auditNoteEditorLifecycle } from "./fixtures/audit-note-editor-lifecycle";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import { assertNoteEditorViewportLayout } from "./audit-note-editor-viewport";
import { mergeRecoveredDraft } from "../src/utils/recovered-draft";

interface Element {
  type: unknown;
  props: Record<string, any>;
}
interface Slot {
  value?: any;
  current?: any;
  dependencies?: unknown[];
  cleanup?: (() => void) | void;
}
interface Sources {
  noteCard?: string;
  route?: string;
  visibility?: string;
  description?: string;
  rename?: string;
  keyboardLayout?: string;
  noteInput?: string;
}
const read = (path: string) => readFileSync(path, "utf8");
const sourcePaths = {
  route: "app/habit/[id]/notes.tsx",
  visibility: "src/features/notes/utils/editor-visibility.ts",
  description: "src/features/habit-detail/components/InlineDescription.tsx",
  rename: "src/features/habit-detail/components/RenameDialog.tsx",
};

function find(tree: unknown, predicate: (element: Element) => boolean): Element | null {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const result = find(child, predicate);
      if (result) return result;
    }
  } else if (tree != null && typeof tree === "object" && "props" in tree) {
    const element = tree as Element;
    return predicate(element) ? element : find(element.props.children, predicate);
  }
  return null;
}

function mountComponent(source: string, exportName: string, props: Record<string, any>, initialDescriptionLines = 3) {
  const slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  let effects: (() => void)[] = [];
  let accent = "#1276B8";
  let dismissals = 0;
  const forwardedRef = { current: null as { restoreDraft(recovery: { sequence: number; text: string }): boolean } | null };
  const dependenciesEqual = (left?: unknown[], right?: unknown[]) =>
    left != null && right != null && left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const react = {
    memo: (component: unknown) => component,
    forwardRef: (component: (...args: any[]) => unknown) => (value: unknown) => component(value, forwardedRef),
    useState(initial: any) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (value: any) => {
        const next = typeof value === "function" ? value(slots[index].value) : value;
        if (!Object.is(slots[index].value, next)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(initial: any) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useMemo(factory: () => any, dependencies: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !dependenciesEqual(slots[index].dependencies, dependencies)) {
        slots[index] = { value: factory(), dependencies };
      }
      return slots[index].value;
    },
    useCallback(callback: unknown, dependencies: unknown[]) { return react.useMemo(() => callback, dependencies); },
    useEffect(setup: () => (() => void) | void, dependencies?: unknown[]) {
      const index = cursor++;
      if (!slots[index] || !dependenciesEqual(slots[index].dependencies, dependencies)) {
        const previous = slots[index];
        slots[index] = { dependencies, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = setup(); });
      }
    },
    useLayoutEffect(setup: () => (() => void) | void, dependencies?: unknown[]) { react.useEffect(setup, dependencies); },
    useImperativeHandle(ref: { current: unknown } | null, create: () => unknown) { if (ref) ref.current = create(); },
  };
  const jsx = (type: unknown, value: Record<string, unknown>) => ({ type, props: value });
  const mocks: Record<string, unknown> = {
    react,
    "nativewind/jsx-runtime": { jsx, jsxs: jsx },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable",
      Keyboard: { dismiss: () => { dismissals++; } }, PanResponder: { create: () => ({ panHandlers: {} }) },
    },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@expo/vector-icons/MaterialIcons": "MaterialIcons",
    "@expo/vector-icons/FontAwesome6": "FontAwesome6",
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
    "@/components/ScreenPreferencesBoundary": {
      useVisualEffectiveMode: () => "dark", useVisualColorScheme: () => "blue",
    },
    "@/theme/colors": {
      getAccentScheme: () => ({ base: accent }),
      darkTheme: { border: "#555555" }, lightTheme: { border: "#DDDDDD", surfaceElevated: "#FFFFFF" },
    },
    "@/composition/settings": { readPersistedDescriptionVisibleLines: () => initialDescriptionLines, persistDescriptionVisibleLines: async () => ({ status: "saved" }) },
    "@/application/settings/habit-description-lines-setting": {
      DESCRIPTION_LINES_MIN: 1, DESCRIPTION_LINES_MAX: 8,
      clampDescriptionVisibleLines: (value: number) => Math.max(1, Math.min(8, Math.round(value))),
    },
    "@/utils/recovered-draft": { mergeRecoveredDraft },
    "@/components/ui/Dialog": { Dialog: "Dialog" },
    "@/hooks/useRetainedModalSession": { useRetainedModalSession: () => ({ session: null }) },
    "@/theme/tokens": { sizes: { sendButton: 36 } },
    "@/features/notes/utils/keyboard-layout": { getNoteComposerBottomPadding: () => 6 },
    "@/features/notes/utils/composer-height": { getNoteComposerContentHeight: () => 38 },
  };
  const code = ts.transpileModule(source, {
    fileName: "component.tsx",
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as Record<string, (value: unknown) => Element> };
  new Function("require", "module", "exports", "requestAnimationFrame", "cancelAnimationFrame", code)(
    (name: string) => { assert.ok(name in mocks, `unexpected dependency: ${name}`); return mocks[name]; },
    module, module.exports, () => 1, () => {},
  );
  let tree: Element;
  const render = () => {
    let attempts = 0;
    do {
      assert.ok(++attempts < 20, "component updates must settle");
      cursor = 0; dirty = false; effects = [];
      tree = module.exports[exportName](props);
      for (const effect of effects) effect();
    } while (dirty);
    return tree;
  };
  render();
  return {
    render, props,
    input: () => { const input = find(tree, (element) => element.type === "TextInput"); assert.ok(input); return input; },
    dialog: () => { const dialog = find(tree, (element) => element.type === "Dialog"); assert.ok(dialog); return dialog; },
    setAccent: (value: string) => { accent = value; render(); },
    dismissals: () => dismissals,
    handle: () => forwardedRef.current,
    unmount: () => { for (const slot of slots) slot.cleanup?.(); },
  };
}

export function auditNotesKeyboardLayout(overrides: Sources = {}): void {
  const route = overrides.route ?? read(sourcePaths.route);
  assertNoteEditorViewportLayout(route);
  const keyboardLayout = overrides.keyboardLayout ?? read("src/features/notes/utils/keyboard-layout.ts");
  const finiteNonNegative = loadSourceCallableForAudit<(value: number) => number>(keyboardLayout, "finiteNonNegative", {});
  const getNoteKeyboardLayoutMetrics = loadSourceCallableForAudit<typeof getLiveNoteKeyboardLayoutMetrics>(keyboardLayout, "getNoteKeyboardLayoutMetrics", { finiteNonNegative });
  const getReportedKeyboardOverlap = loadSourceCallableForAudit<typeof getLiveReportedKeyboardOverlap>(keyboardLayout, "getReportedKeyboardOverlap", { finiteNonNegative });
  const routeTree = ts.createSourceFile("notes.tsx", route, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expression = (value: ts.Expression) => ts.transpileModule(`(${value.getText(routeTree)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText.trim().replace(/;$/, "");
  const initializer = (name: string) => {
    const values: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.name.getText(routeTree) === name && node.initializer) values.push(node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(routeTree);
    assert.equal(values.length, 1, `the route must retain one ${name} initializer`);
    return expression(values[0]);
  };
  const callExpression = (name: string) => {
    const values: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) values.push(node);
      ts.forEachChild(node, visit);
    };
    visit(routeTree);
    assert.equal(values.length, 1, `the route must retain one ${name} call`);
    return expression(values[0]);
  };
  const keyboardOwner = new Function("Platform", "Constants", "ExecutionEnvironment", `return ${initializer("nativeKeyboardLayoutOwner")};`) as
    (platform: { OS: string }, constants: { executionEnvironment: string }, environments: { StoreClient: string }) => boolean;
  const reportedOverlap = new Function("eventHeight", "overlapFromScreenY", "Platform", "nativeKeyboardLayoutOwner", "getReportedKeyboardOverlap", `return ${initializer("selectedOverlap")};`) as
    (eventHeight: number, screenOverlap: number, platform: { OS: string }, nativeOwner: boolean, getOverlap: typeof getReportedKeyboardOverlap) => number;
  const routeKeyboardMetrics = new Function("maximumRootLayoutHeightRef", "rootLayoutHeight", "keyboardOverlap", "insets", "nativeKeyboardLayoutOwner", "getNoteKeyboardLayoutMetrics", "measuredRootBottom", "keyboardTop", `return ${callExpression("getNoteKeyboardLayoutMetrics")};`) as
    (maximum: { current: number }, current: number, overlap: number, insets: { bottom: number }, nativeOwner: boolean, getMetrics: typeof getNoteKeyboardLayoutMetrics, rootBottom?: number | null, keyboardTop?: number | null) => ReturnType<typeof getNoteKeyboardLayoutMetrics>;
  for (const executionEnvironment of ["storeClient", "standalone"]) {
    const platform = { OS: "android" };
    const nativeLayoutOwner = keyboardOwner(platform, { executionEnvironment }, { StoreClient: "storeClient" });
    assert.equal(nativeLayoutOwner, false, "Android must account for actual root resize, independently of its host");
    const keyboardOverlap = reportedOverlap(272, 320, platform, nativeLayoutOwner, getReportedKeyboardOverlap);
    assert.equal(keyboardOverlap, 320, "Android must include the physical keyboard overlap when the event excludes navigation space");
    for (const [currentLayoutHeight, systemResizeInset, viewportKeyboardLift, composerKeyboardLift] of [
      [800, 0, 320, 272],
      [480, 320, 0, 0],
      [600, 200, 120, 72],
    ]) {
      const metrics = routeKeyboardMetrics({ current: 800 }, currentLayoutHeight, keyboardOverlap, { bottom: 48 }, nativeLayoutOwner, getNoteKeyboardLayoutMetrics);
      assert.deepEqual({ ...metrics }, { keyboardVisible: true, systemResizeInset, viewportKeyboardLift, composerKeyboardLift }, "unresized, full and partial Android resize must add only the uncovered viewport area");
      assert.equal(getNoteComposerBottomPadding({ bottomInset: 48, extraKeyboardLift: metrics.composerKeyboardLift, keyboardVisible: true }), 48 + composerKeyboardLift + 6, "composer geometry must preserve its existing six dp gap");
    }
    assert.equal(reportedOverlap(0, 320, platform, nativeLayoutOwner, getReportedKeyboardOverlap), 320, "screen coordinates must cover an omitted Android event height");
  }
  const iosPlatform = { OS: "ios" };
  const iosOwner = keyboardOwner(iosPlatform, { executionEnvironment: "standalone" }, { StoreClient: "storeClient" });
  assert.equal(iosOwner, true, "iOS must retain its KeyboardAvoidingView padding owner");
  assert.equal(reportedOverlap(272, 320, iosPlatform, iosOwner, getReportedKeyboardOverlap), 320, "iOS overlap selection must remain unchanged");
  assert.deepEqual({ ...routeKeyboardMetrics({ current: 800 }, 800, 320, { bottom: 34 }, iosOwner, getNoteKeyboardLayoutMetrics) }, {
    keyboardVisible: true, systemResizeInset: 320, viewportKeyboardLift: 0, composerKeyboardLift: 0,
  }, "iOS padding must not acquire an Android manual lift");
  for (const [maximum, current, overlap, rootBottom, keyboardTop, bottomInset, expectedLift] of [
    [840, 840, 328, 840, 560, 0, 280],
    [840, 560, 328, 560, 560, 0, 0],
    [840, 650, 328, 650, 560, 0, 90],
    [720, 720, 360, 720, 360, 48, 360],
    [800, 800, 400, 832, 560, 24, 272],
    [800, 640, 400, 672, 560, 24, 112],
    [800, 528, 400, 560, 560, 24, 0],
    [800, 500, 400, 532, 560, 24, 0],
    [840, 840, 80, 840, 560, 0, 280],
  ]) {
    const metrics = routeKeyboardMetrics({ current: maximum }, current, overlap, { bottom: bottomInset }, false, getNoteKeyboardLayoutMetrics, rootBottom, keyboardTop);
    assert.equal(metrics.viewportKeyboardLift, expectedLift, "measured current root bounds must own excluded-navigation, overlay, partial-resize and shifted-origin geometry");
    assert.equal(metrics.composerKeyboardLift, Math.max(0, expectedLift - bottomInset), "measured root geometry must deduct safe area only once for the composer");
  }
  for (const rootBottom of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const metrics = routeKeyboardMetrics({ current: 840 }, 560, 328, { bottom: 0 }, false, getNoteKeyboardLayoutMetrics, rootBottom, 560);
    assert.equal(metrics.viewportKeyboardLift, 48, "a cold or invalid root measurement must retain the measured-resize fallback, not claim known physical geometry");
  }
  for (const keyboardTop of [null, undefined, Number.NaN]) {
    assert.equal(routeKeyboardMetrics({ current: 840 }, 560, 328, { bottom: 0 }, false, getNoteKeyboardLayoutMetrics, 560, keyboardTop).viewportKeyboardLift, 48, "invalid keyboard coordinates must retain the unmeasured fallback");
  }
  assert.equal(routeKeyboardMetrics({ current: 800 }, 800, 320, { bottom: 34 }, true, getNoteKeyboardLayoutMetrics, 900, 100).viewportKeyboardLift, 0, "measured Android root bounds must not override iOS padding");
  assert.equal(routeKeyboardMetrics({ current: 800 }, 800, 0, { bottom: 0 }, false, getNoteKeyboardLayoutMetrics, 800, 600).viewportKeyboardLift, 0, "a hidden keyboard must never add a root-bound lift");

  const rootOwner = { live: true, target: null as any, requestId: 0, originY: null as number | null, layoutWidth: null as number | null, layoutY: null as number | null };
  let rootBottom: number | null = null;
  let rootHeight = 800;
  let rootWrites = 0;
  const measurements: ((...values: number[]) => void)[] = [];
  const rootTarget = () => ({ measure: (callback: (...values: number[]) => void) => measurements.push(callback) });
  const rootA = rootTarget();
  const rootB = rootTarget();
  const rootPlatform = { OS: "android" };
  const setMeasuredRootBottom = (value: number | null) => { rootBottom = value; rootWrites++; };
  const measureRoot = loadSourceCallableForAudit<() => void>(route, "measureNoteRoot", { Platform: rootPlatform, rootMeasurementRef: { current: rootOwner }, setMeasuredRootBottom });
  const rootLayout = loadSourceCallableForAudit<(event: unknown) => void>(route, "handleRootLayout", {
    Platform: rootPlatform,
    rootMeasurementRef: { current: rootOwner }, setMeasuredRootBottom,
    isPageMeasurable: loadSourceCallableForAudit(route, "isPageMeasurable", {}),
    maximumRootLayoutHeightRef: { current: 800 }, setRootLayoutHeight: (update: (height: number) => number) => { rootHeight = update(rootHeight); }, measureNoteRoot: measureRoot,
  });
  const layout = (target: unknown, height: number, width = 360, y = 0) => rootLayout({ target, currentTarget: null, nativeEvent: { layout: { height, width, y } } });
  const resolveMeasurement = (index: number, height: number, y: number) => measurements[index](0, 0, 360, height, 0, y);
  layout(42, 800);
  assert.equal(measurements.length, 0, "a host without public measurement methods must retain the fallback");
  layout(rootA, 800);
  assert.equal(rootBottom, null, "first layout cannot invent an absolute root origin");
  assert.equal(measurements.length, 1, "the persisted event target must expose the physical root host");
  resolveMeasurement(0, 0, 32);
  resolveMeasurement(0, 800, Number.NaN);
  assert.equal(rootBottom, null, "invalid native measurements must not become root coordinates");
  resolveMeasurement(0, 800, 32);
  assert.equal(rootBottom, 832, "the persisted event target must measure root bounds after currentTarget is cleared");
  layout(rootA, 650);
  assert.equal(rootBottom, 682, "a known-origin resize must update its bottom with the current height before measurement returns");
  layout(rootA, 640);
  resolveMeasurement(1, 650, 900);
  assert.equal(rootBottom, 672, "a stale same-host measurement must not restore old geometry");
  resolveMeasurement(2, 640, 32);
  assert.equal(rootBottom, 672);
  layout(rootB, 600);
  assert.equal(rootBottom, null, "a different native host must not inherit the prior origin");
  resolveMeasurement(2, 640, 900);
  assert.equal(rootBottom, null, "late callbacks from a detached host must be ignored");
  resolveMeasurement(3, 600, 44);
  assert.equal(rootBottom, 644);
  layout(rootB, 600, 640);
  assert.equal(rootBottom, null, "a changed layout width must invalidate the previous origin");
  resolveMeasurement(4, 600, 16);
  assert.equal(rootBottom, 616);
  layout(rootB, 600, 640, 10);
  assert.equal(rootBottom, null, "a changed local position must not retain the previous origin");
  resolveMeasurement(5, 600, 26);
  assert.equal(rootBottom, 626);
  const dimensionsEnvironment = { previousScreen: { width: 640, height: 800 }, owner: rootOwner, setMeasuredRootBottom, measureNoteRoot: measureRoot };
  const screenChanged = loadSourceCallableForAudit<(event: unknown) => void>(route, "handleScreenDimensionsChange", dimensionsEnvironment);
  const beforeDimensions = measurements.length;
  screenChanged({ screen: { width: 640, height: 800 } });
  assert.equal(measurements.length, beforeDimensions, "window-only keyboard changes must not reset the screen geometry");
  screenChanged({ screen: { width: 800, height: 640 } });
  assert.equal(rootBottom, null, "rotation must invalidate the prior physical root bounds");
  assert.equal(rootOwner.originY, null, "rotation must also revoke the reusable root origin");
  assert.equal(measurements.length, beforeDimensions + 1, "rotation must schedule one fresh root measurement");
  screenChanged({ screen: { width: 800, height: 640 } });
  assert.equal(measurements.length, beforeDimensions + 1, "an unchanged rotated screen must not repeat measurement work");
  resolveMeasurement(measurements.length - 1, 600, 20);
  assert.equal(rootBottom, 620);
  measureRoot();
  const beforeUnmount = rootWrites;
  rootOwner.live = false;
  rootOwner.requestId += 1;
  resolveMeasurement(measurements.length - 1, 600, 900);
  assert.equal(rootWrites, beforeUnmount, "an unmounted route must not accept native measurement callbacks");
  const beforeDetached = measurements.length;
  measureRoot();
  assert.equal(measurements.length, beforeDetached, "a disposed root must not start native measurements");
  layout(rootA, 800);
  screenChanged({ screen: { width: 640, height: 800 } });
  assert.equal(rootWrites, beforeUnmount, "late layout and rotation callbacks must not update a disposed route");
  const showCallbacks: ts.Expression[] = [];
  const findKeyboardShow = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(routeTree) === "Keyboard" && node.expression.name.text === "addListener" &&
      node.arguments[0]?.getText(routeTree) === "showEvent") showCallbacks.push(node.arguments[1]);
    ts.forEachChild(node, findKeyboardShow);
  };
  findKeyboardShow(routeTree);
  assert.equal(showCallbacks.length, 1);
  let reportedTop = 0;
  let reportedHeight = 0;
  let reveals = 0;
  const showEnvironment = {
    Dimensions: { get: () => ({ height: 900 }) }, getReportedKeyboardOverlap,
    keyboardTopRef: { current: null as number | null },
    setKeyboardTop: (value: number) => { reportedTop = value; },
    setKeyboardOverlap: (value: number) => { reportedHeight = value; },
    measureNoteRoot: measureRoot, scheduleEditorReveal: () => { reveals++; },
  };
  const showKeyboard = new Function(...Object.keys(showEnvironment), `return ${expression(showCallbacks[0])};`)(...Object.values(showEnvironment));
  rootOwner.live = true;
  rootOwner.target = null;
  rootOwner.originY = null;
  setMeasuredRootBottom(null);
  const beforeColdKeyboard = measurements.length;
  showKeyboard({ endCoordinates: { height: 252, screenY: 600 } });
  assert.equal(reportedTop, 600);
  assert.equal(reportedHeight, 300);
  assert.equal(rootBottom, null, "a keyboard event before first layout must not fabricate root geometry");
  assert.equal(measurements.length, beforeColdKeyboard);
  layout(rootA, 800);
  resolveMeasurement(measurements.length - 1, 800, 32);
  const beforeShownRefresh = measurements.length;
  showKeyboard({ endCoordinates: { height: 252, screenY: 600 } });
  assert.equal(measurements.length, beforeShownRefresh + 1, "keyboard show must refresh the current physical root measurement");
  assert.equal(reveals, 2);
  rootPlatform.OS = "ios";
  const beforeIosMeasurements = measurements.length;
  const beforeIosWrites = rootWrites;
  measureRoot();
  layout(rootA, 700);
  assert.equal(measurements.length, beforeIosMeasurements, "iOS must not start the Android root measurements");
  assert.equal(rootWrites, beforeIosWrites, "iOS layout must not add the unused Android geometry state");
  assert.equal(rootHeight, 700, "iOS must retain its original root-layout update");
  const rootEffects: ts.Expression[] = [];
  const findRootEffect = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" &&
      node.arguments[0]?.getText(routeTree).includes("const handleScreenDimensionsChange")) rootEffects.push(node.arguments[0]);
    ts.forEachChild(node, findRootEffect);
  };
  findRootEffect(routeTree);
  assert.equal(rootEffects.length, 1);
  let dimensionListeners = 0;
  let removedListeners = 0;
  const effectEnvironment = {
    Platform: rootPlatform, rootMeasurementRef: { current: rootOwner }, measureNoteRoot: measureRoot, setMeasuredRootBottom,
    Dimensions: { get: () => ({ width: 360, height: 800 }), addEventListener: () => { dimensionListeners++; return { remove: () => { removedListeners++; } }; } },
  };
  const mountRootEffect = new Function(...Object.keys(effectEnvironment), `return ${expression(rootEffects[0])};`)(...Object.values(effectEnvironment));
  assert.equal(mountRootEffect(), undefined);
  assert.equal(dimensionListeners, 0, "iOS must not install the unused Android dimensions observer");
  rootPlatform.OS = "android";
  const disposeRootEffect = mountRootEffect();
  assert.equal(dimensionListeners, 1);
  const pendingAtDispose = measurements.length - 1;
  const writesAtDispose = rootWrites;
  disposeRootEffect();
  assert.equal(rootOwner.live, false);
  assert.equal(removedListeners, 1, "root measurement cleanup must remove its sole dimensions listener");
  resolveMeasurement(pendingAtDispose, 700, 900);
  assert.equal(rootWrites, writesAtDispose, "actual effect cleanup must invalidate an in-flight native measurement");
  const disposeSecondMount = mountRootEffect();
  assert.equal(rootOwner.live, true, "a repeated effect setup must restore the same physical host owner");
  disposeSecondMount();
  assert.equal(removedListeners, 2);
}

export function auditNotesVisibility(overrides: Sources = {}): void {
  auditNotesKeyboardLayout(overrides);
  const route = overrides.route ?? read(sourcePaths.route);
  const visibility = overrides.visibility ?? read(sourcePaths.visibility);
  const getDecision = loadSourceCallableForAudit<(...args: any[]) => any>(visibility, "getNoteEditorVisibilityDecision", {
    NOTE_EDITOR_KEYBOARD_GAP_DP: 12, NOTE_EDITOR_VISIBILITY_TOLERANCE_DP: 0.5,
  });
  const getKey = loadSourceCallableForAudit<(...args: any[]) => string>(route, "getEditorGeometryKey", {});
  const metric = { length: 80, lineCount: 4, heightBucket: 1600, selectionAtEnd: false };
  assert.notEqual(
    getKey({ targets: { noteId: 7 }, metrics: metric }, 1),
    getKey({ targets: { noteId: 7 }, metrics: { ...metric, selectionAtEnd: true } }, 1),
    "moving the caret to the end must invalidate a completed interior geometry request",
  );
  const geometry = { viewportHeight: 360, viewportPageY: 100, editorHeight: 1600, editorPageY: 100, actionsHeight: 32, actionsPageY: 1708, keyboardTop: 460 };
  const interior = getDecision({ ...geometry, selectionAtEnd: false });
  assert.equal(interior.visibilityMode, "native-caret");
  assert.equal(interior.scrollDelta, 0, "an interior caret must not be replaced by the distant footer target");
  const end = getDecision({ ...geometry, selectionAtEnd: true });
  assert.equal(end.visibilityMode, "actions-and-editor-viewport");
  assert.equal(end.scrollDelta, 1292, "end editing must retain the exact measured footer gap");
  for (const selectionAtEnd of [true, false]) {
    const short = getDecision({ ...geometry, editorHeight: 80, editorPageY: 400, actionsPageY: 490, selectionAtEnd });
    assert.equal(short.visibilityMode, "full-editor");
    assert.equal(short.scrollDelta, 74, "a short editor and its footer must remain visible for any selection");
  }
  function routeScroll(selectionAtEnd: boolean, editorHeight = 1600) {
    const commands: number[] = [];
    const frames = new Map<number, () => void>();
    let frame = 0;
    const measure = (height: number, pageY: number) => ({ measure: (callback: (...args: number[]) => void) => callback(0, 0, 300, height, 0, pageY) });
    const entry = {
      requestId: 1,
      metrics: { ...metric, selectionAtEnd },
      targets: { noteId: 7, requestId: 1, getRequestId: () => 1, editor: measure(editorHeight, editorHeight === 1600 ? 100 : 400), actions: measure(32, editorHeight === 1600 ? 1708 : 490) },
    };
    const execute = loadSourceCallableForAudit<(value: unknown) => void>(route, "scheduleEditorGeometry", {
      hasNativeNoteEditorViewport: false,
      activeEditorSaveRef: { current: { noteId: 7 } }, activeEditorGeometryRef: { current: null }, keyboardTopRef: { current: 460 },
      isScrollDragActiveRef: { current: false }, isMomentumScrollActiveRef: { current: false }, observedScrollGenerationRef: { current: 0 },
      clearEditorRevealFrame: () => {}, editorGeometryEnvironmentEpochRef: { current: 1 }, getEditorGeometryKey: getKey,
      completedEditorGeometryKeyRef: { current: null }, editorGeometryFramesRef: { current: new Map() }, pendingEditorCorrectionRef: { current: null },
      getMonotonicNow: () => 100, EDITOR_VISIBILITY_MAX_FRAMES: 12, EDITOR_VISIBILITY_MAX_DURATION_MS: 250,
      EDITOR_VISIBILITY_TOLERANCE_DP: 0.5, clearTopScrollSettleTimer: () => {}, scrollOffsetRef: { current: 0 },
      getNoteEditorVisibilityDecision: getDecision,
      noteListRef: { current: { getNativeScrollRef: () => measure(360, 100), scrollToOffset: ({ offset }: { offset: number }) => commands.push(offset) } },
      isPageMeasurable: loadSourceCallableForAudit(route, "isPageMeasurable", {}),
      requestAnimationFrame: (callback: () => void) => { frames.set(++frame, callback); return frame; },
      cancelAnimationFrame: (id: number) => frames.delete(id), setTimeout: () => 1, clearTimeout: () => {},
    });
    execute(entry);
    if (!selectionAtEnd && editorHeight === 1600) {
      assert.equal(frame, 0, "native caret ownership must stop the custom convergence loop immediately");
    }
    for (let attempt = 0; frames.size > 0 && attempt < 20; attempt++) {
      const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback();
    }
    assert.equal(frames.size, 0, "visibility work must remain bounded");
    return commands;
  }
  assert.deepEqual(routeScroll(false), [], "the actual route must not scroll an oversized interior editor to its footer");
  assert.deepEqual(routeScroll(true), [1292], "the actual route must preserve one end-editor correction");
  assert.deepEqual(routeScroll(false, 80), [74], "the actual route must preserve short-editor correction");

  const descriptionSaves: string[] = [];
  let saveDescription: (() => void) | null = null;
  const description = mountComponent(overrides.description ?? read(sourcePaths.description), "InlineDescription", {
    habitId: 7, description: "Opening paragraph\nClosing paragraph", visible: true,
    onSave: (value: string) => { descriptionSaves.push(value); return true; },
    registerSaveHandler: (handler: (() => void) | null) => { saveDescription = handler; },
  });
  assert.deepEqual(description.input().props.selection, { start: 0, end: 0 }, "a nonediting description must begin at its first character");
  description.input().props.onFocus(); description.render();
  assert.equal(description.input().props.selection, undefined, "editing must release native selection completely");
  description.input().props.onChange({ nativeEvent: { text: "An edited paragraph" } }); description.render();
  assert.equal(description.input().props.selection, undefined, "typing must never lock the description caret");
  assert.ok(saveDescription); (saveDescription as () => void)(); description.render();
  assert.deepEqual(descriptionSaves, ["An edited paragraph"]);
  assert.equal(description.input().props.selection, undefined, "saving must not reset a previously chosen native position");
  assert.equal(description.dismissals(), 1);
  description.setAccent("#6B45A8");
  assert.equal(description.input().props.selectionColor, "#6B45A8");
  assert.equal(description.input().props.cursorColor, "#6B45A8");
  description.unmount();
  const recoveredDescription = mountComponent(overrides.description ?? read(sourcePaths.description), "InlineDescription", {
    habitId: 8, description: "Stored paragraph", visible: true,
    onSave: () => true, recoveryDraft: { sequence: 1, text: "Recovered paragraph" },
  });
  assert.equal(recoveredDescription.input().props.selection, undefined, "recovery must release the initial preview position before editing");
  recoveredDescription.unmount();
  for (const lines of [1, 2, 3]) {
    const preview = mountComponent(overrides.description ?? read(sourcePaths.description), "InlineDescription", {
      habitId: 9, description: "Opening paragraph\nClosing paragraph", visible: true, onSave: () => true,
    }, lines);
    const height = Math.max(44, lines * 22 + 20);
    assert.equal(preview.input().props.style.height, height, "preview clipping must preserve the configured field height");
    assert.equal(preview.input().props.style.paddingTop, 10, "preview clipping must not move the first glyph down");
    assert.equal(preview.input().props.style.paddingBottom, lines === 1 ? 12 : 10, "the minimum-height remainder must not expose a partial second line");
    preview.input().props.onFocus(); preview.render();
    assert.equal(preview.input().props.style.height, height);
    assert.equal(preview.input().props.style.paddingBottom, 10, "editing must retain the original native content viewport");
    preview.unmount();
  }

  let cancellations = 0;
  const renamed: string[] = [];
  const rename = mountComponent(`${overrides.rename ?? read(sourcePaths.rename)}\nexport const AuditRenameSession = RenameDialogSession;`, "AuditRenameSession", {
    visible: true, currentName: "Read a chapter", onCancel: () => { cancellations++; },
    onSave: (value: string) => renamed.push(value), onDismiss: () => {},
  });
  rename.input().props.onChange({ nativeEvent: { text: "   " } }); rename.render();
  let [cancel, save] = rename.dialog().props.actions;
  assert.equal(save.disabled, true, "an empty name must disable only Save");
  assert.equal(cancel.disabled, false, "an empty name must leave cancellation available");
  assert.equal(cancel.role, "cancel", "scrim and Back must retain the shared cancellation action");
  save.onPress(); assert.deepEqual(renamed, []);
  cancel.onPress(); assert.equal(cancellations, 1);
  rename.input().props.onChange({ nativeEvent: { text: "  Evening walk  " } }); rename.render();
  [, save] = rename.dialog().props.actions;
  assert.equal(save.disabled, false); save.onPress(); assert.deepEqual(renamed, ["Evening walk"]);
  rename.props.busy = true; rename.render();
  rename.dialog().props.actions[1].onPress(); assert.deepEqual(renamed, ["Evening walk"], "a busy dialog must not submit twice");
  rename.setAccent("#6B45A8");
  assert.equal(rename.input().props.selectionColor, "#6B45A8");
  assert.equal(rename.input().props.cursorColor, "#6B45A8");
  rename.unmount();
  const composer = mountComponent(overrides.noteInput ?? read("src/features/notes/components/NoteInput.tsx"), "NoteInput", { onSend: () => true, hidden: true, keyboardVisible: false, extraKeyboardLift: 0 });
  assert.equal(composer.input().props.selectionColor, "#1276B8");
  assert.equal(composer.input().props.cursorColor, "#1276B8");
  const send = find(composer.render(), (element) => element.type === "Pressable" && element.props.accessibilityLabel === "notes.send");
  assert.ok(send);
  assert.ok(send.props.style.width + 2 * send.props.hitSlop >= 44);
  assert.ok(send.props.style.height + 2 * send.props.hitSlop >= 44);
  let composerFocuses = 0;
  composer.input().props.ref.current = { focus: () => { composerFocuses++; } };
  assert.equal(composer.handle()!.restoreDraft({ sequence: 1, text: "Unclaimed composer paragraph" }), false,
    "hidden composer recovery must refuse delivery without consuming its sequence");
  assert.equal(composerFocuses, 0, "hidden composer recovery must never steal native focus");
  composer.props.hidden = false; composer.render();
  assert.equal(composer.input().props.value, "");
  assert.equal(composer.handle()!.restoreDraft({ sequence: 1, text: "Unclaimed composer paragraph" }), true);
  composer.render();
  assert.equal(composer.input().props.value, "Unclaimed composer paragraph");
  assert.equal(composerFocuses, 1);
  assert.equal(composer.handle()!.restoreDraft({ sequence: 1, text: "Unclaimed composer paragraph" }), true);
  composer.render();
  assert.equal(composer.input().props.value, "Unclaimed composer paragraph", "a repeated claimed composer recovery must not append duplicate text");
  assert.equal(composerFocuses, 1, "a repeated recovery must not refocus the composer");
  composer.unmount();
  auditNoteEditorLifecycle({ noteCard: overrides.noteCard, route });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  auditNotesVisibility();
  const noteInput = read("src/features/notes/components/NoteInput.tsx");
  assert.ok(noteInput.includes("hitSlop={3}"));
  assert.throws(() => auditNotesVisibility({ noteInput: noteInput.replace("hitSlop={3}", "hitSlop={0}") }), { name: "AssertionError" });
  console.log("Notes visibility and editing audit passed.");
}
