import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { OneShotActionGate } from "../../src/application/interaction/one-shot-action-gate";
import { resolveHabitDetailPresentationState } from "../../src/features/habit-detail/utils/presentation-state";
import {
  closeDataTransferOverlay,
  createEmptyDataTransferOverlaySlot,
  createSynchronousActionFence,
  enqueueDataTransferOverlay,
  settleDataTransferOverlayDismissal,
} from "../../src/features/habits/utils/data-transfer-overlay-slot";
import { loadSourceCallableForAudit } from "./load-source-callable-for-audit";

type Properties = Record<string, unknown>;
interface Element {
  type: unknown;
  props: Properties;
}
type Effect = () => (() => void) | void;
interface HookSlot {
  value?: unknown;
  current?: unknown;
  dependencies?: readonly unknown[];
  cleanup?: (() => void) | void;
}
interface MutableRef {
  current: unknown;
}
type Render = (props?: Properties, ref?: MutableRef) => Element;

export interface LocalizedFeedbackSources {
  archive?: string;
  detail?: string;
  transfer?: string;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createHooks() {
  const slots: HookSlot[] = [];
  let cursor = 0;
  let dirty = false;
  let effects: (() => void)[] = [];
  const same = (left?: readonly unknown[], right?: readonly unknown[]) =>
    left != null && right != null && left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      slots[index] ??= {
        value: typeof initial === "function" ? (initial as () => T)() : initial,
      };
      const set = (next: T | ((current: T) => T)) => {
        const value = typeof next === "function"
          ? (next as (current: T) => T)(slots[index].value as T)
          : next;
        if (Object.is(value, slots[index].value)) return;
        slots[index].value = value;
        dirty = true;
      };
      return [slots[index].value as T, set] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index] as { current: T };
    },
    useMemo<T>(factory: () => T, dependencies: readonly unknown[]) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].dependencies, dependencies)) {
        slots[index] = { value: factory(), dependencies };
      }
      return slots[index].value as T;
    },
    useCallback<T>(callback: T, dependencies: readonly unknown[]) {
      return hooks.useMemo(() => callback, dependencies);
    },
    useEffect(effect: Effect, dependencies?: readonly unknown[]) {
      const index = cursor++;
      if (slots[index] && same(slots[index].dependencies, dependencies)) return;
      const old = slots[index];
      slots[index] = { dependencies, cleanup: old?.cleanup };
      effects.push(() => {
        slots[index].cleanup?.();
        slots[index].cleanup = effect();
      });
    },
    useLayoutEffect(effect: Effect, dependencies?: readonly unknown[]) {
      hooks.useEffect(effect, dependencies);
    },
    useImperativeHandle(ref: MutableRef, factory: () => unknown, dependencies: readonly unknown[]) {
      hooks.useLayoutEffect(() => {
        ref.current = factory();
        return () => { ref.current = null; };
      }, dependencies);
    },
    memo: <T>(value: T) => value,
    forwardRef: <T>(value: T) => value,
  };
  return {
    hooks,
    render(render: Render, props: Properties = {}, ref?: MutableRef): Element {
      let result: Element;
      let passes = 0;
      do {
        assert.ok(passes++ < 30, "feedback rendering must settle");
        cursor = 0;
        effects = [];
        dirty = false;
        result = render(props, ref);
        for (const effect of effects) effect();
      } while (dirty);
      return result;
    },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}

function findElement(tree: unknown, predicate: (element: Element) => boolean): Element | null {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
  } else if (tree != null && typeof tree === "object" && "props" in tree) {
    const element = tree as Element;
    return predicate(element) ? element : findElement(element.props.children, predicate);
  }
  return null;
}
function element(tree: unknown, type: string, predicate: (value: Element) => boolean = () => true): Element {
  const result = findElement(tree, (value) => value.type === type && predicate(value));
  assert.ok(result, `${type} must be present`);
  return result;
}
function hasText(tree: unknown, text: string): boolean {
  return findElement(tree, (value) => value.props.children === text) != null;
}
function callback<T>(value: unknown): T {
  assert.equal(typeof value, "function");
  return value as T;
}
const jsx = (type: unknown, props: Properties) => ({ type, props });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: "Fragment" };

function createEnvironment() {
  const hooks = createHooks();
  let language = "en";
  const translators = new Map<string, (key: string) => string>();
  const translator = (locale: string) => {
    if (!translators.has(locale)) translators.set(locale, (key) => `${locale}:${key}`);
    return translators.get(locale)!;
  };
  const router = { push() {}, back() {}, replace() {} };
  const navigation = () => ({ status: "dispatched" });
  const environment: Properties = {
    ...hooks.hooks,
    exports: {},
    React: hooks.hooks,
    useTranslation: () => ({ t: translator(language) }),
    useVisualEffectiveMode: () => "dark",
    useVisualColorScheme: () => "orange",
    useRouter: () => router,
    useNavigationIntentGate: () => navigation,
    getAccentScheme: () => ({ base: "#C75C2D", pale: "#F4D7C6" }),
    darkTheme: { background: "#222222", muted: "#AAAAAA", menuSurface: "#202020" },
    lightTheme: { background: "#FFFFFF", muted: "#666666", surfaceElevated: "#FAFAFA" },
    console: { error() {} },
    require: (name: string) => {
      assert.equal(name, "react/jsx-runtime");
      return jsxRuntime;
    },
    MaterialIcons: "MaterialIcons",
    Stack: { Screen: "StackScreen" },
  };
  for (const type of [
    "ScreenWrapper", "Header", "InlineErrorBanner", "Dialog", "ArchiveCard",
    "ActivityIndicator", "Pressable", "Text", "View", "FlatList",
    "InlineDescription", "ProgressStats", "EditRows", "MonthCalendar",
    "HabitDetailMenuController", "HabitDetailFormOverlayController", "HabitDetailStatusOverlayController",
  ]) environment[type] = type;
  return {
    hooks, environment, translator,
    changeLanguage(next: string) { language = next; },
    currentTranslator: () => translator(language),
    currentLanguage: () => language,
  };
}

async function settle() {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

async function auditArchive(source: string) {
  {
    const context = createEnvironment();
    const request = deferred<void>();
    let loads = 0;
    const state = {
      allHabitsLoaded: false,
      archivedHabits: [],
      loadHabits: () => { loads += 1; return request.promise; },
      restoreHabits: async () => {},
      deleteHabits: async () => {},
    };
    const store = Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state });
    const render = loadSourceCallableForAudit<Render>(source, "ArchiveScreen", {
      ...context.environment, useHabitStore: store,
      getArchivedHabitsForState: (value: typeof state) => value.archivedHabits,
      ARCHIVE_LIST_CONTENT_STYLE: {}, archiveHabitKeyExtractor: () => "entry",
    }, true);
    context.hooks.render(render);
    assert.equal(loads, 1);
    context.changeLanguage("uk");
    context.hooks.render(render);
    assert.equal(loads, 1, "changing language must not reload the archive");
    request.reject(new Error("Read unavailable"));
    await settle();
    let tree = context.hooks.render(render);
    assert.ok(hasText(tree, "uk:archive.loadError"), "late archive load failure must use the displayed language");
    context.changeLanguage("en");
    tree = context.hooks.render(render);
    assert.ok(hasText(tree, "en:archive.loadError"), "visible archive load feedback must follow language changes");
    assert.equal(loads, 1, "translating an archive error must not start another read");
    context.hooks.unmount();
  }
  {
    const context = createEnvironment();
    const request = deferred<void>();
    let restores = 0;
    const state = {
      allHabitsLoaded: true,
      archivedHabits: [{ id: 17 }],
      loadHabits: async () => {},
      restoreHabits: () => { restores += 1; return request.promise; },
      deleteHabits: async () => {},
    };
    const store = Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state });
    const render = loadSourceCallableForAudit<Render>(source, "ArchiveScreen", {
      ...context.environment, useHabitStore: store,
      getArchivedHabitsForState: (value: typeof state) => value.archivedHabits,
      ARCHIVE_LIST_CONTENT_STYLE: {}, archiveHabitKeyExtractor: () => "entry",
    }, true);
    const first = context.hooks.render(render);
    const row = callback<(input: Properties) => Element>(element(first, "FlatList").props.renderItem)({ item: state.archivedHabits[0] });
    const pending = callback<(id: number) => Promise<void>>(row.props.onRestore)(17);
    context.changeLanguage("uk");
    context.hooks.render(render);
    request.reject(new Error("Write unavailable"));
    await pending;
    let tree = context.hooks.render(render);
    assert.equal(element(tree, "InlineErrorBanner").props.message, "uk:archive.actionError", "late archive mutation failure must use the displayed language");
    context.changeLanguage("en");
    tree = context.hooks.render(render);
    assert.equal(element(tree, "InlineErrorBanner").props.message, "en:archive.actionError", "visible archive mutation feedback must follow language changes");
    assert.equal(restores, 1);
    context.hooks.unmount();
  }
}

async function auditDetail(source: string) {
  const context = createEnvironment();
  const request = deferred<void>();
  let updates = 0;
  let reloads = 0;
  const habit: Properties = {
    id: 17, name: "Sample habit", description: "Stored description", descriptionVisible: true,
    isArchived: false, startDate: "2032-04-19", repeatSchedule: { type: "daily" },
    reminderEnabled: false, reminderTime: null,
  };
  const state = {
    updateHabit: () => { updates += 1; return request.promise; },
    renameHabit: async () => {}, archiveHabit: async () => {}, deleteHabit: async () => {},
    markDay: async () => true, unmarkDay: async () => true,
  };
  const detail = {
    habit, records: [], stats: { current: 0, best: 0, total: 0 }, isContentReady: true, error: null,
    reload: async () => { reloads += 1; },
    patchHabit: (patch: Properties) => Object.assign(habit, patch),
  };
  const render = loadSourceCallableForAudit<Render>(source, "HabitDetailScreenContent", {
    ...context.environment, useHabitStore: (select: (value: typeof state) => unknown) => select(state),
    useHabitDetail: () => detail, resolveHabitDetailPresentationState, OneShotActionGate,
    mixHexColor: (base: string) => base,
    areRepeatSchedulesEqual: () => { throw new Error("Unexpected schedule operation"); },
  }, true);
  const first = context.hooks.render(render, { habitId: 17 });
  assert.equal(callback<(text: string) => boolean>(element(first, "InlineDescription").props.onSave)("Changed description"), true);
  context.changeLanguage("uk");
  context.hooks.render(render, { habitId: 17 });
  assert.equal(updates, 1);
  assert.equal(reloads, 0, "changing language must not reload habit detail");
  request.reject(new Error("Write unavailable"));
  await settle();
  let tree = context.hooks.render(render, { habitId: 17 });
  assert.equal(element(tree, "InlineErrorBanner").props.message, "uk:detail.actionError", "late detail failure must use the displayed language");
  assert.equal(element(tree, "HabitDetailMenuController").props.actionError, "uk:detail.actionError", "detail overlays must receive the same translated failure as the screen");
  context.changeLanguage("en");
  tree = context.hooks.render(render, { habitId: 17 });
  assert.equal(element(tree, "InlineErrorBanner").props.message, "en:detail.actionError", "visible detail failure must follow language changes");
  assert.equal(updates, 1);
  assert.equal(reloads, 1, "language changes must not repeat failure recovery I/O");
  callback<() => void>(element(tree, "HabitDetailMenuController").props.onClearActionError)();
  tree = context.hooks.render(render, { habitId: 17 });
  assert.equal(findElement(tree, (value) => value.type === "InlineErrorBanner"), null);
  context.hooks.unmount();
}

function transferHarness(source: string, input: {
  picker?: () => Promise<unknown>;
  apply?: () => Promise<unknown>;
  normalize?: (text: string) => unknown;
} = {}) {
  const context = createEnvironment();
  const shared: Properties = {
    ...context.environment,
    closeDataTransferOverlay, createEmptyDataTransferOverlaySlot, createSynchronousActionFence,
    enqueueDataTransferOverlay, settleDataTransferOverlayDismissal,
    IMPORT_PRELOAD_DAY_RADIUS: 1,
    i18n: { getFixedT: (locale: string) => context.translator(locale) },
    useSettingsStore: { getState: () => ({ language: context.currentLanguage() }) },
    exportAllData: async () => {},
    selectDataTransferImportFile: input.picker ?? (async () => ({ status: "selected", text: "valid" })),
    getDataTransferImportFileFailure: () => null,
    normalizeImportData: input.normalize ?? (() => ({ habits: [] })),
    previewNormalizedImportData: () => ({ habitsCount: 0, archivedHabitsCount: 0, dayRecordsCount: 0, notesCount: 0 }),
    importNormalizedData: input.apply ?? (async () => ({ success: true })),
    useHabitStore: { getState: () => { throw new Error("Unexpected import publication"); } },
    loadSettingsFromCommittedImport: () => { throw new Error("Unexpected settings publication"); },
  };
  shared.currentTransferTranslator = loadSourceCallableForAudit(source, "currentTransferTranslator", shared);
  shared.createStatusRequest = loadSourceCallableForAudit(source, "createStatusRequest", shared);
  shared.isVisibleOverlay = loadSourceCallableForAudit(source, "isVisibleOverlay", shared);
  shared.slotContainsStatusForImport = loadSourceCallableForAudit(source, "slotContainsStatusForImport", shared);
  const render = loadSourceCallableForAudit<Render>(source, "HomeDataTransferOverlayController", shared, true);
  const ref: MutableRef = { current: null };
  const update = () => context.hooks.render(render, { selectedDate: "2032-04-19" }, ref);
  update();
  return {
    ...context, update,
    openImport() { (ref.current as { openImport(): void }).openImport(); return update(); },
  };
}

function visibleDialog(tree: unknown): Element {
  return element(tree, "Dialog", (value) => value.props.visible === true);
}
function pressAction(dialog: Element, index: number): void {
  const actions = dialog.props.actions as { onPress(): void }[];
  actions[index].onPress();
}

async function auditTransfer(source: string) {
  for (const mode of ["invalid", "picker"] as const) {
    const picker = deferred<unknown>();
    const context = transferHarness(source, {
      picker: () => picker.promise,
      normalize: () => { throw new Error("Invalid input"); },
    });
    const first = context.openImport();
    const originalDialog = visibleDialog(first);
    pressAction(originalDialog, 1);
    context.update();
    context.changeLanguage("uk");
    context.update();
    if (mode === "invalid") picker.resolve({ status: "selected", text: "invalid" });
    else picker.reject(new Error("Picker unavailable"));
    await settle();
    callback<() => void>(originalDialog.props.onDismiss)();
    const status = visibleDialog(context.update());
    assert.equal(status.props.title, "uk:import.errorTitle");
    assert.equal(status.props.message, mode === "invalid" ? "uk:import.errorMessage" : "uk:import.actionErrorMessage", `${mode} import failure must use its own meaning in the latest language`);
    context.hooks.unmount();
  }
  for (const mode of ["result", "throw"] as const) {
    const request = deferred<unknown>();
    let applications = 0;
    const context = transferHarness(source, {
      apply: () => { applications += 1; return request.promise; },
    });
    const pickerDialog = visibleDialog(context.openImport());
    pressAction(pickerDialog, 1);
    await settle();
    callback<() => void>(pickerDialog.props.onDismiss)();
    const preview = visibleDialog(context.update());
    pressAction(preview, 1);
    context.update();
    pressAction(preview, 1);
    context.update();
    context.changeLanguage("uk");
    context.update();
    assert.equal(applications, 1);
    if (mode === "result") request.resolve({ success: false, committed: false, error: "Write unavailable" });
    else request.reject(new Error("Write unavailable"));
    await settle();
    let dialog = visibleDialog(context.update());
    assert.ok(String(dialog.props.message).endsWith("\n\nuk:import.actionErrorMessage"), `${mode} apply failure must use the displayed language`);
    context.changeLanguage("en");
    dialog = visibleDialog(context.update());
    assert.ok(String(dialog.props.message).endsWith("\n\nen:import.actionErrorMessage"), "visible pending import feedback must follow language changes");
    assert.equal(applications, 1, "translating import feedback must not apply the file again");
    context.hooks.unmount();
  }
}

function auditImportFence(source: string) {
  const tree = ts.createSourceFile("controller.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bodies: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useLayoutEffect") {
      const body = node.arguments[0]?.getText(tree);
      if (body?.includes("pendingImportApplyTokenRef")) bodies.push(body);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(bodies.length, 1, "one committed effect must release accepted import ownership");
  const slotContainsStatusForImport = loadSourceCallableForAudit(source, "slotContainsStatusForImport", {});
  for (const terminal of ["none", "error", "status", "queued-status", "foreign-status"] as const) {
    const fence = createSynchronousActionFence();
    const owner = fence.tryAcquire();
    assert.ok(owner != null);
    const pending = { current: owner as number | null };
    const empty = createEmptyDataTransferOverlaySlot<{
      kind: string;
      importRequestToken?: number;
    }>();
    const slot = terminal === "status" || terminal === "foreign-status"
      ? enqueueDataTransferOverlay(empty, {
          kind: "status",
          importRequestToken: terminal === "status" ? owner : owner + 1,
        })
      : terminal === "queued-status"
        ? enqueueDataTransferOverlay(
            closeDataTransferOverlay(enqueueDataTransferOverlay(empty, { kind: "import-preview" }), "import-preview"),
            { kind: "status", importRequestToken: owner },
          )
      : empty;
    const commit = (isImporting: boolean, pendingImportError: boolean) =>
      loadSourceCallableForAudit<() => void>(`const commit = ${bodies[0]}`, "commit", {
        applyImportFence: fence, pendingImportApplyTokenRef: pending,
        isImporting, pendingImportError, overlaySlot: slot, slotContainsStatusForImport,
      })();
    commit(true, terminal === "error");
    assert.equal(fence.getOwner(), owner, "busy import cannot release its accepted fence");
    commit(false, terminal === "error");
    const retained = terminal === "none" || terminal === "foreign-status";
    assert.equal(
      fence.getOwner(), retained ? owner : null,
      retained
        ? "an import without matching terminal feedback must retain ownership"
        : "terminal import feedback must release accepted ownership",
    );
    assert.equal(pending.current, retained ? owner : null);
    if (!retained) assert.ok(fence.tryAcquire() != null, "terminal feedback must permit the next import intent");
  }
}

export async function auditLocalizedFeedback(sources: LocalizedFeedbackSources = {}): Promise<void> {
  const deadline = deferred<never>();
  const timer = setTimeout(() => deadline.reject(new Error("Localized feedback audit did not settle")), 10_000);
  try {
    await Promise.race([
      (async () => {
        const archive = sources.archive ?? readFileSync("app/archive.tsx", "utf8");
        const detail = sources.detail ?? readFileSync("app/habit/[id].tsx", "utf8");
        const transfer = sources.transfer ?? readFileSync("src/features/habits/components/HomeDataTransferOverlayController.tsx", "utf8");
        await auditArchive(archive);
        await auditDetail(detail);
        await auditTransfer(transfer);
        auditImportFence(transfer);
      })(),
      deadline.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
