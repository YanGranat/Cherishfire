import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { NoteEditorSession } from "../../src/features/notes/utils/note-editor-session";
import { getNoteEditorContentHeight } from "../../src/features/notes/utils/editor-visibility";
import { mergeRecoveredDraft } from "../../src/utils/recovered-draft";
import type { NotesSessionNote, NotesSessionSnapshot } from "../../src/application/notes/notes-session";
import type { NoteEditorCaretMetrics } from "../../src/platform/note-editor-metrics";
import { loadSourceCallableForAudit } from "./load-source-callable-for-audit";

interface Element {
  type: unknown;
  props: Record<string, any>;
}
interface HookSlot {
  value?: any;
  dependencies?: unknown[];
  cleanup?: (() => void) | void;
  setup?: () => (() => void) | void;
  current?: any;
}
class Hooks {
  readonly slots: HookSlot[] = [];
  cursor = 0;
  effects: (() => void)[] = [];
  updates = 0;
  dirty = false;

  unmount(): void {
    for (const slot of this.slots) slot.cleanup?.();
  }

  replayEffects(): void {
    this.unmount();
    for (const slot of this.slots) {
      if (slot.setup) slot.cleanup = slot.setup();
    }
  }
}
const sameDependencies = (left?: unknown[], right?: unknown[]) =>
  left != null && right != null && left.length === right.length &&
  left.every((value, index) => Object.is(value, right[index]));

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
function requiredElement(tree: unknown, predicate: (element: Element) => boolean): Element {
  const element = findElement(tree, predicate);
  assert.ok(element, "the requested native element must be mounted");
  return element;
}
function note(id: number, text = "Stored text"): NotesSessionNote {
  return {
    id, habitId: 1, clientMutationId: `note:${id}`, text,
    date: "2026-03-04", createdAt: 1, updatedAt: 1,
    isFailureReason: false, reasonType: null,
  };
}

interface LifecycleSources {
  noteCard?: string;
  route?: string;
}

function createLifecycleHarness(sources: LifecycleSources = {}) {
  const noteCardSource = sources.noteCard ?? readFileSync("src/features/notes/components/NoteCard.tsx", "utf8");
  const routeSource = sources.route ?? readFileSync("app/habit/[id]/notes.tsx", "utf8");
  let current = new Hooks();
  const react = {
    memo: (value: unknown) => value,
    useState(initial: any) {
      const hooks = current, key = hooks.cursor++;
      hooks.slots[key] ??= { value: typeof initial === "function" ? initial() : initial };
      return [hooks.slots[key].value, (value: any) => {
        const next = typeof value === "function" ? value(hooks.slots[key].value) : value;
        if (!Object.is(next, hooks.slots[key].value)) {
          hooks.slots[key].value = next;
          hooks.updates++;
          hooks.dirty = true;
        }
      }];
    },
    useRef(initial: any) {
      const key = current.cursor++;
      current.slots[key] ??= { current: initial };
      return current.slots[key];
    },
    useMemo(factory: () => any, dependencies: unknown[]) {
      const key = current.cursor++;
      if (!current.slots[key] || !sameDependencies(current.slots[key].dependencies, dependencies)) {
        current.slots[key] = { value: factory(), dependencies };
      }
      return current.slots[key].value;
    },
    useCallback(callback: unknown, dependencies: unknown[]) {
      return react.useMemo(() => callback, dependencies);
    },
    useEffect(effect: () => (() => void) | void, dependencies?: unknown[]) {
      const hooks = current, key = hooks.cursor++;
      if (!hooks.slots[key] || !sameDependencies(hooks.slots[key].dependencies, dependencies)) {
        const old = hooks.slots[key];
        hooks.slots[key] = { dependencies, cleanup: old?.cleanup, setup: effect };
        hooks.effects.push(() => {
          hooks.slots[key].cleanup?.();
          hooks.slots[key].cleanup = effect();
        });
      }
    },
    useLayoutEffect(effect: () => (() => void) | void, dependencies?: unknown[]) {
      react.useEffect(effect, dependencies);
    },
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const nativeCaret = {
    available: false,
    tag: null as number | null,
    result: null as NoteEditorCaretMetrics | null,
    calls: [] as { tag: number; eventCount: number | null; expectedText: string | null }[],
  };
  const mocks: Record<string, unknown> = {
    react,
    "nativewind/jsx-runtime": { jsx, jsxs: jsx },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable", Platform: { OS: "android" }, findNodeHandle: () => nativeCaret.tag },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/theme/colors": { getAccentScheme: () => ({ base: "#1276B8" }), lightTheme: { surfaceElevated: "#FFFFFF" }, semantic: { failure: "#FF0000" } },
    "@/components/ScreenPreferencesBoundary": { useVisualLanguage: () => "en", useVisualEffectiveMode: () => "light", useVisualColorScheme: () => "blue" },
    "@/utils/date": { formatLocalizedDate: (value: string) => value },
    "@/theme/tokens": { radii: { listCard: 8 } },
    "@/utils/recovered-draft": { mergeRecoveredDraft },
    "@/features/notes/utils/editor-visibility": { getNoteEditorContentHeight },
    "@/platform/note-editor-metrics": {
      get hasNoteEditorCaretMetrics() { return nativeCaret.available; },
      readNoteEditorCaretMetrics: async (tag: number, eventCount: number | null, expectedText: string | null = null) => {
        nativeCaret.calls.push({ tag, eventCount, expectedText });
        return nativeCaret.result;
      },
    },
  };
  const code = ts.transpileModule(noteCardSource, {
    fileName: "NoteCard.tsx",
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} as { NoteCard: (props: any) => Element } };
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  new Function("require", "module", "exports", "requestAnimationFrame", "cancelAnimationFrame", code)(
    (name: string) => {
      assert.ok(name in mocks, `unexpected component dependency: ${name}`);
      return mocks[name];
    }, module, module.exports,
    (callback: () => void) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    (id: number) => frames.delete(id),
  );
  function createRoute(initialNotes: NotesSessionNote[], editorSession = new NoteEditorSession()) {
    let notes = initialNotes;
    let saveAccepted = true;
    const saves: [number, string][] = [];
    const saveAttempts: [number, string][] = [];
    const recoveries: [number, number][] = [];
    const geometry: {
      selectionAtEnd: boolean; requestId: number; targets: any;
      contentRevision: number; selectionStart: number | null; selectionEnd: number | null;
      length: number; lineCount: number; heightBucket: number;
    }[] = [];
    const activeEditorSaveRef = { current: null as any };
    const activeEditorNoteIdRef = { current: null as number | null };
    const activeEditorTargetRef = { current: null };
    const activeEditorGeometryRef = { current: null };
    const completedEditorGeometryKeyRef = { current: null };
    const pendingEditorCorrectionRef = { current: null };
    let editingIds = new Set<number>();
    let dismissals = 0;
    let composerReleasePending = false;
    const environment = {
      editorSession,
      notesSession: { getSnapshot: () => ({ notes, generation: editorSession.generation }) },
      activeEditorSaveRef, activeEditorNoteIdRef, activeEditorTargetRef,
      activeEditorGeometryRef, completedEditorGeometryKeyRef, pendingEditorCorrectionRef,
      editorHandoffInProgressRef: { current: false },
      shouldScrollToNewNoteRef: { current: false },
      keyboardVisibleRef: { current: true },
      clearTopScrollSettleTimer: () => {}, clearEditorRevealFrame: () => {},
      clearEditorGeometryFrames: () => {},
      setComposerReleasePending: (value: boolean) => { composerReleasePending = value; },
      Keyboard: { dismiss: () => { dismissals++; } },
      setEditingNoteIds: (update: (current: Set<number>) => Set<number>) => { editingIds = update(editingIds); },
      handleSave: (id: number, text: string) => {
        saveAttempts.push([id, text]);
        if (!saveAccepted) return false;
        saves.push([id, text]);
        notes = notes.map((item) => item.id === id ? { ...item, text } : item);
        return true;
      },
      handleNoteEditingChange: null as any,
    };
    const onEditingChange = loadSourceCallableForAudit<(...args: any[]) => boolean>(routeSource, "handleNoteEditingChange", environment);
    environment.handleNoteEditingChange = onEditingChange;
    const onEditorUnmount = loadSourceCallableForAudit<(...args: any[]) => void>(routeSource, "handleNoteEditorUnmount", environment);
    return {
      editorSession, saves, geometry, onEditingChange, onEditorUnmount, recoveries,
      getNote: (id: number) => { const value = notes.find((item) => item.id === id); assert.ok(value); return value; },
      getEditingIds: () => [...editingIds], getDismissals: () => dismissals,
      getPhysicalOwner: () => activeEditorSaveRef.current?.owner,
      getSaveAttempts: () => saveAttempts,
      getComposerReleasePending: () => composerReleasePending,
      setKeyboardVisible: (visible: boolean) => { environment.keyboardVisibleRef.current = visible; },
      setSaveAccepted: (value: boolean) => { saveAccepted = value; },
      setNotes: (value: NotesSessionNote[]) => { notes = value; },
      onSave: environment.handleSave,
    };
  }
  function mount(route: ReturnType<typeof createRoute>, id: number, recoveryDraft?: { sequence: number; text: string }) {
    const hooks = new Hooks();
    const props = {
      note: route.getNote(id), editorSession: route.editorSession,
      onSave: route.onSave, onDelete: () => {},
      onEditingChange: route.onEditingChange, onEditorUnmount: route.onEditorUnmount,
      onEditorGeometry: (requestId: number, targets: any, metrics: Omit<(typeof route.geometry)[number], "requestId" | "targets">) => {
        route.geometry.push({ ...metrics, requestId, targets });
      },
      recoveryDraft,
      onRecoveryApplied: (noteId: number, sequence: number) => route.recoveries.push([noteId, sequence]),
    };
    let tree: Element;
    const render = () => {
      let count = 0;
      do {
        assert.ok(++count < 20, "the editor lifecycle must settle");
        current = hooks; hooks.cursor = 0; hooks.effects = []; hooks.dirty = false;
        tree = module.exports.NoteCard(props);
        for (const effect of hooks.effects) effect();
      } while (hooks.dirty);
      return tree;
    };
    render();
    return {
      hooks, props, render,
      input: () => requiredElement(tree, (element) => element.type === "TextInput"),
      isEditing: () => findElement(tree, (element) => element.type === "TextInput") != null,
      edit: () => { requiredElement(tree, (element) => element.props.accessibilityLabel === "notes.edit").props.onPress(); render(); },
      saveAction: () => requiredElement(tree, (element) => element.props.accessibilityLabel === "common.save"),
      save: () => { requiredElement(tree, (element) => element.props.accessibilityLabel === "common.save").props.onPress(); render(); },
      type: (text: string) => { requiredElement(tree, (element) => element.type === "TextInput").props.onChange({ nativeEvent: { text } }); },
      unmount: () => hooks.unmount(),
    };
  }

  return {
    routeSource, createRoute, mount, frames, react, nativeCaret,
    selectHooks: (hooks: Hooks) => { current = hooks; },
    flushFrames: () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

function auditNotesRecoveryDelivery(routeSource: string): void {
  const tree = ts.createSourceFile("notes.tsx", routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let cursorInitializer = "";
  let recoveryEffect = "";
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "lastProcessedPresentationChangeRef") {
      cursorInitializer = node.initializer!.getText(tree);
    }
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useLayoutEffect" &&
      node.arguments[0]?.getText(tree).includes("for (const change of notesSnapshot.presentationChanges)")) {
      assert.equal(recoveryEffect, "", "the route must have one recovery delivery owner");
      recoveryEffect = node.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(cursorInitializer && recoveryEffect);
  for (const source of ["create", "update", "delete"] as const) {
    const stored = note(1);
    const snapshot: Pick<NotesSessionSnapshot, "generation" | "presentationChanges"> = {
      generation: 4,
      presentationChanges: [{ sequence: 1, kind: "rollback", source, clientMutationId: stored.clientMutationId,
        noteId: stored.id, expectedPresent: source !== "create", expectedText: source === "create" ? null : stored.text,
        expectedUpdatedAt: source === "create" ? null : stored.updatedAt, recoveryText: "Unclaimed paragraph" },
      { sequence: 100, kind: "created", source: "create", clientMutationId: "later-note", noteId: 2,
        expectedPresent: true, expectedText: "Later paragraph", expectedUpdatedAt: 2, recoveryText: null }],
    };
    const acknowledged: [number, number][] = [];
    let currentSnapshot = snapshot;
    let visible = false;
    const composerRecoveries: { sequence: number; text: string }[] = [];
    let recoveryMap = new Map<number, { sequence: number; text: string }>();
    const environment = {
      notesSnapshot: snapshot,
      noteList: source === "create" ? [] : [stored],
      useRef: (current: number) => ({ current }),
      lastProcessedPresentationChangeRef: { current: 0 },
      noteInputRef: { current: { restoreDraft: (value: { sequence: number; text: string }) => {
        if (!visible) return false;
        composerRecoveries.push(value); return true;
      } } },
      setNoteRecoveryDrafts: (update: (value: typeof recoveryMap) => typeof recoveryMap) => { recoveryMap = update(recoveryMap); },
      notesSession: { getSnapshot: () => currentSnapshot, acknowledgeRecovery: (generation: number, sequence: number) => {
        if (generation !== snapshot.generation || sequence !== 1) return false;
        acknowledged.push([generation, sequence]);
        currentSnapshot = { ...snapshot, presentationChanges: snapshot.presentationChanges.map((change) =>
          change.sequence === sequence ? { ...change, recoveryText: null } : change) };
        return true;
      } },
    };
    environment.lastProcessedPresentationChangeRef = loadSourceCallableForAudit<() => { current: number }>(
      `function initialize() { return ${cursorInitializer}; }`, "initialize", environment,
    )();
    assert.equal(environment.lastProcessedPresentationChangeRef.current, 100);
    const deliver = loadSourceCallableForAudit<() => void>(`const deliver = ${recoveryEffect}`, "deliver", environment);
    deliver();
    assert.equal(environment.lastProcessedPresentationChangeRef.current, 100, "replayed recovery must not regress the ordinary event cursor");
    assert.deepEqual(acknowledged, [], "a hidden composer or virtualized card must leave recovery unclaimed");
    if (source === "create") {
      assert.equal(composerRecoveries.length, 0);
      visible = true; deliver();
      assert.equal(composerRecoveries.length, 1, "a reopened route must restore an unclaimed create older than its initial event cursor");
      assert.deepEqual(acknowledged, [[4, 1]], "composer recovery must ACK only after the actual owner accepts it");
    } else {
      assert.equal(recoveryMap.get(stored.id)?.text, "Unclaimed paragraph", "reopened card recovery must not be skipped by the ordinary event cursor");
      const applied = loadSourceCallableForAudit<(id: number, sequence: number) => void>(routeSource, "handleRecoveryApplied", environment);
      applied(stored.id, 2);
      assert.equal(recoveryMap.size, 1, "a refused or mismatched recovery ACK must not clear a newer route draft");
      applied(stored.id, 1);
      assert.equal(recoveryMap.size, 0, "actual card application must clear the route recovery map to prevent later resurrection");
      assert.deepEqual(acknowledged, [[4, 1]]);
      deliver();
      assert.equal(recoveryMap.size, 0, "a parent layout-effect with a stale snapshot must not resurrect recovery acknowledged by its child");
    }
  }
}

export function auditNoteEditorLifecycle(sources: LifecycleSources = {}): void {
  const { routeSource, createRoute, mount, frames, react, selectHooks } = createLifecycleHarness(sources);
  auditNotesRecoveryDelivery(routeSource);

  {
    const text = "Opening paragraph\nClosing paragraph";
    const route = createRoute([note(1, text)]);
    const card = mount(route, 1); card.edit();
    const input = card.input();
    const selections: [number, number][] = [];
    input.props.ref.current = {
      setSelection: (start: number, end: number) => selections.push([start, end]),
      setSelectionRange: () => { assert.fail("a native selection method must take precedence over the web fallback"); },
      isFocused: () => true, focus: () => {},
    };
    input.props.onFocus();
    assert.deepEqual(selections, [[text.length, text.length]], "Edit must explicitly place the initial native caret at the end");
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, true, "initial Edit must retain its footer target without a native selection event");
    input.props.onFocus();
    assert.equal(selections.length, 1, "the initial native selection command must run only once");
    card.type(`${text}!`);
    input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 20 } } });
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, true, "end typing must not depend on a repeated native selection event");
    card.type(`${text}!\nAnother paragraph`);
    input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 80 } } });
    card.render();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, true, "Enter at the explicit end must keep the footer visible");
    const seed = card.input().props.defaultValue;
    input.props.onPressIn(); input.props.onFocus();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "a later editor press must release the initial end intent");
    assert.equal(selections.length, 1, "a later focus must never reset the user's native caret");
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } });
    card.type(`OpXening paragraph\nClosing paragraph!\nAnother paragraph`);
    input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 100 } } }); card.render();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "interior typing must not inherit an earlier end intent");
    assert.equal(card.input().props.defaultValue, seed, "initial positioning must not turn the editor into controlled text");
    card.unmount();
  }
  {
    const text = "Opening paragraph\nClosing paragraph";
    const route = createRoute([note(1, text)]);
    const card = mount(route, 1); card.edit();
    const input = card.input();
    const selections: [number, number][] = [];
    const webHost = {
      setSelection: undefined,
      setSelectionRange(start: number, end: number) {
        assert.equal(this, webHost, "web selection must retain its DOM host receiver");
        selections.push([start, end]);
      },
      isFocused: () => true, focus: () => {},
    };
    input.props.ref.current = webHost;
    assert.doesNotThrow(() => input.props.onFocus());
    assert.deepEqual(selections, [[text.length, text.length]], "a web editor must use its supported selection-range method");
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, true);
    input.props.onFocus();
    assert.equal(selections.length, 1, "the web selection command must remain one-shot");
    input.props.onPressIn(); input.props.onFocus();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "web interior refocus must release the initial end intent");
    assert.equal(selections.length, 1);
    card.unmount();
  }
  for (const unsupported of [
    { isFocused: () => true, focus: () => {} },
    { setSelection: false, setSelectionRange: "unsupported", isFocused: () => true, focus: () => {} },
  ]) {
    const route = createRoute([note(1, "A paragraph")]);
    const card = mount(route, 1); card.edit();
    const input = card.input(); input.props.ref.current = unsupported;
    assert.doesNotThrow(() => input.props.onFocus(), "an unsupported host must not crash on focus");
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "an unsupported command must not invent an end selection");
    input.props.onFocus();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false);
    card.unmount();
  }
  {
    const route = createRoute([note(1, "First paragraph\nFinal paragraph")]);
    const card = mount(route, 1); card.edit();
    let input = card.input();
    assert.equal(input.props.selection, undefined, "native selection must remain uncontrolled");
    assert.equal(input.props.selectionColor, "#1276B8");
    assert.equal(input.props.cursorColor, "#1276B8");
    input.props.onFocus();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "focus must not assume that the caret is at the end");
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 31, end: 31 } } });
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, true, "a native end selection may reveal the footer");
    input.props.onSelectionChange({ nativeEvent: { selection: { start: -1, end: -1 } } });
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "an unavailable native selection must release an old end target");
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 31, end: 31 } } });
    const endRequest = route.geometry.at(-1)!;
    input.props.onPressIn();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "a fresh native press must invalidate the previous caret target");
    assert.notEqual(endRequest.requestId, endRequest.targets.getRequestId(), "a new caret target must supersede an in-flight end correction");
    input.props.onFocus();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "focus before a selection event must retain native caret ownership");
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } });
    input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 80 } } });
    card.render();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "layout changes must not turn an interior caret into an end target");
    input = card.input();
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 31, end: 31 } } });
    input.props.onBlur();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, false, "blur must release selection trust");
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 31, end: 31 } } });
    input.props.onFocus();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, true, "a selection event before focus must not be discarded");
    card.type("First paragraph\nFinal paragraph!");
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 32, end: 32 } } });
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, true, "end typing must retain footer visibility");
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 33, end: 33 } } });
    card.type("First paragraph\nFinal paragraph!!");
    input.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 100 } } });
    card.render();
    assert.equal(route.geometry.at(-1)?.selectionAtEnd, true, "selection before a text event must retain the native end index");
    card.save();
    const count = route.geometry.length;
    input.props.onSelectionChange({ nativeEvent: { selection: { start: 1, end: 1 } } });
    input.props.onPressIn();
    assert.equal(route.geometry.length, count, "callbacks from a finished native editor must not request another reveal");
    card.unmount();
  }
  {
    const route = createRoute([note(1)]);
    const first = mount(route, 1); first.edit();
    assert.equal(first.input().props.nativeID, "note-editor-end:note:1",
      "explicit Edit must identify its initial end-placement intent to the native viewport");
    const firstActions = requiredElement(first.render(), (element) => element.props.nativeID === "note-editor-actions:note:1");
    assert.equal(firstActions.props.collapsable, false, "native action-row geometry must retain its host view");
    const updates = first.hooks.updates;
    first.type("Unsaved text\nSecond line");
    assert.equal(first.hooks.updates, updates, "ordinary typing must not render controlled text");
    first.input().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 60 } } });
    const retainedHeight = route.editorSession.getActiveDraft()?.viewportHeight;
    assert.equal(retainedHeight, 60, "the draft owner must retain the latest measured native text height");
    first.unmount();
    assert.equal(route.saves.length, 0, "virtualization must not autosave a draft");
    assert.deepEqual(route.getEditingIds(), [1], "virtualization must retain the logical editor");
    const second = mount(route, 1);
    assert.equal(second.input().props.nativeID, "note-editor:note:1",
      "a restored logical draft must not inherit an earlier explicit end-placement marker");
    assert.equal(second.input().props.defaultValue, "Unsaved text\nSecond line", "a remounted row must restore the exact unsaved draft");
    assert.equal(second.input().props.value, undefined, "the native editor must remain uncontrolled");
    assert.equal(second.input().props.style.at(-1).height, Number(retainedHeight) + 20, "the intrinsic editor height must survive virtualization");
    second.save();
    assert.deepEqual(route.saves, [[1, "Unsaved text\nSecond line"]]);
    assert.equal(route.editorSession.getActiveDraft(), null);
    assert.deepEqual(route.getEditingIds(), []);
    assert.equal(route.getDismissals(), 1);
    second.unmount();
    assert.equal(mount(route, 1).isEditing(), false, "an explicitly finished draft must not reopen");
  }
  {
    const route = createRoute([note(1)]);
    const card = mount(route, 1); card.edit();
    const initialSeed = card.input().props.defaultValue;
    card.type("Stored text\nD");
    card.input().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 60 } } });
    card.render();
    const geometryInput = card.input();
    assert.equal(geometryInput.props.defaultValue, initialSeed, "a geometry render must not republish the mutable draft as native text");
    card.type("Stored text\nDra");
    card.input().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 80 } } });
    card.render();
    assert.equal(card.input().props.defaultValue, initialSeed, "later native changes must retain the same physical input seed");
    card.type("Stored text\nDraft retained");
    assert.equal(route.editorSession.getActiveDraft()?.text, "Stored text\nDraft retained");
    card.save();
    assert.deepEqual(route.saves, [[1, "Stored text\nDraft retained"]], "Save must read the live draft rather than the immutable mount seed");
    card.props.note = route.getNote(1);
    card.render();
    card.edit();
    assert.equal(card.input().props.defaultValue, "Stored text\nDraft retained", "a newly mounted input must receive the latest saved text");
    card.unmount();
  }
  {
    const route = createRoute([note(1)]);
    const card = mount(route, 1, { sequence: 1, text: "Recovered before edit" });
    assert.equal(card.input().props.defaultValue, "Recovered before edit", "recovery that opens a closed editor must seed its new native input");
    assert.equal(route.editorSession.getActiveDraft()?.baseText, "Recovered before edit");
    assert.equal(route.editorSession.hasUnsavedChanges(), true,
      "a recovered closed editor must retain unsaved changes against its displayed source");
    assert.equal(route.editorSession.getActiveDraft()?.sourceText, "Stored text");
    assert.deepEqual(route.recoveries, [[1, 1]], "a closed recovery must be acknowledged only after the logical editor owns its text");
    card.type("Recovered before edit\nContinued");
    card.input().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 60 } } });
    card.render();
    assert.equal(card.input().props.defaultValue, "Recovered before edit");
    card.save();
    assert.deepEqual(route.saves, [[1, "Recovered before edit\nContinued"]]);
    card.unmount();
  }
  {
    const route = createRoute([note(1), note(2)]);
    const first = mount(route, 1); first.edit(); first.type("");
    const second = mount(route, 2, { sequence: 7, text: "Rejected editor paragraph" });
    assert.equal(second.isEditing(), false);
    assert.deepEqual(route.recoveries, [], "a refused editor handoff must not acknowledge or consume recovery");
    assert.equal(route.editorSession.getDraft("note:2"), null);
    first.type("Accepted first paragraph");
    second.edit();
    assert.equal(route.editorSession.getActiveDraft()?.text, "Rejected editor paragraph",
      "a later accepted Edit must retry recovery that a blank editor previously refused");
    assert.deepEqual(route.recoveries, [[2, 7]], "recovery must be acknowledged after its later accepted editor entry");
    first.unmount(); second.unmount();
  }
  for (const detached of [false, true]) {
    for (const continued of ["Pending text", "Pending text\nContinued", "", "Stored text"]) {
      const route = createRoute([note(1, "Pending text")]);
      let card = mount(route, 1); card.edit();
      assert.equal(route.editorSession.hasUnsavedChanges(), false);
      card.type(continued);
      if (detached) card.unmount();
      route.setNotes([note(1)]);
      if (detached) {
        card = mount(route, 1, { sequence: 1, text: "Pending text" });
      } else {
        card.props.note = route.getNote(1);
        card.props.recoveryDraft = { sequence: 1, text: "Pending text" };
        card.render();
      }
      assert.equal(route.editorSession.getActiveDraft()?.text, continued,
        "recovery must preserve edits derived from the failed optimistic text, including an explicit blank");
      assert.equal(route.editorSession.getActiveDraft()?.baseText, "Pending text",
        "recovery ancestry must remain separate from the current displayed source");
      assert.equal(route.editorSession.getActiveDraft()?.sourceText, "Stored text",
        "an active recovered editor must compare against the rolled-back displayed source");
      assert.equal(route.editorSession.hasUnsavedChanges(), continued.trim() !== "Stored text",
        "recovery must report only text different from the displayed source as unsaved");
      card.unmount();
      const restored = mount(route, 1, { sequence: 1, text: "Pending text" });
      assert.equal(restored.input().props.defaultValue, continued);
      assert.equal(route.editorSession.getActiveDraft()?.baseText, "Pending text");
      assert.equal(route.editorSession.getActiveDraft()?.sourceText, "Stored text");
      assert.equal(route.editorSession.hasUnsavedChanges(), continued.trim() !== "Stored text",
        "virtualization must retain the recovered editor's dirty baseline and ancestry independently");
      restored.type("Stored text");
      assert.equal(route.editorSession.hasUnsavedChanges(), false,
        "returning to the displayed source must clear dirty state without saving");
      restored.unmount();
    }
  }
  {
    const route = createRoute([note(1)]);
    const card = mount(route, 1); card.edit(); card.type("Published update");
    assert.equal(route.editorSession.hasUnsavedChanges(), true);
    route.setNotes([note(1, "Published update")]);
    card.props.note = route.getNote(1); card.render();
    assert.equal(route.editorSession.hasUnsavedChanges(), false,
      "an editor matching a newer displayed source must not warn about unsaved changes");
    assert.equal(route.editorSession.getActiveDraft()?.baseText, "Stored text");
    card.unmount();
  }
  {
    const route = createRoute([note(1), note(2)]);
    const first = mount(route, 1); first.edit(); first.type("Edited A"); first.unmount();
    const second = mount(route, 2); second.edit();
    assert.deepEqual(route.saves, [[1, "Edited A"]], "handoff must save the detached editor exactly once");
    assert.deepEqual(route.getEditingIds(), [2]);
    assert.equal(mount(route, 1).isEditing(), false, "a saved detached editor must not steal focus when remounted");
    second.unmount();
  }
  {
    const route = createRoute([note(1), note(2)]);
    const first = mount(route, 1); first.edit(); first.type("Retained A");
    const previousOwner = route.getPhysicalOwner(); first.unmount();
    const restored = mount(route, 1);
    assert.equal(route.onEditingChange(1, false, undefined, previousOwner), false);
    assert.deepEqual(route.getEditingIds(), [1], "a stale finish event must not remove the current logical editor");
    first.unmount();
    first.type("Late native event");
    assert.equal(route.editorSession.getActiveDraft()?.text, "Retained A", "detached native input must not overwrite the current draft");
    restored.hooks.replayEffects();
    first.unmount();
    const second = mount(route, 2); second.edit(); restored.render();
    assert.equal(restored.isEditing(), false, "effect replay must restore the mounted editor's handoff callback");
    assert.deepEqual(route.saves, [[1, "Retained A"]]);
    assert.deepEqual(route.getEditingIds(), [2]);
    restored.unmount(); second.unmount();
  }
  {
    const route = createRoute([note(1), note(2)]);
    const first = mount(route, 1); first.edit(); first.type(""); first.unmount();
    const second = mount(route, 2); second.edit();
    assert.equal(second.isEditing(), false, "an empty detached draft must block handoff");
    assert.deepEqual(route.getEditingIds(), [1]);
    assert.equal(mount(route, 1).input().props.defaultValue, "");
    assert.equal(route.saves.length, 0);
  }
  {
    const pending = { ...note(-7), clientMutationId: "optimistic:1:7" };
    const route = createRoute([pending]);
    const first = mount(route, -7); first.edit(); first.type("Continued draft");
    const initialSeed = first.input().props.defaultValue;
    let recoveredNativeText: string | undefined;
    first.input().props.ref.current = {
      setNativeProps: ({ text }: { text: string }) => { recoveredNativeText = text; },
      focus: () => {},
    };
    first.props.recoveryDraft = { sequence: 3, text: "Failed update" }; first.render();
    const expected = route.editorSession.getActiveDraft()?.text;
    assert.equal(expected, "Failed update\n\nContinued draft");
    assert.equal(recoveredNativeText, expected, "active recovery must explicitly update the native editor");
    assert.equal(first.input().props.defaultValue, initialSeed, "recovery must not change the mounted input's initial value");
    first.unmount();
    const second = mount(route, -7, { sequence: 3, text: "Failed update" });
    assert.equal(second.input().props.defaultValue, expected, "recovery must not be merged twice after remount");
    assert.equal(route.editorSession.getActiveDraft()?.text, expected, "a replayed recovery must leave the canonical draft unchanged");
    second.unmount();
    route.editorSession.reconcile([]);
    assert.equal(route.editorSession.getActiveDraft(), null, "removed notes must revoke their drafts");
    assert.equal(mount(route, -7).isEditing(), false);
    const replacement = createRoute([pending]);
    assert.equal(mount(replacement, -7).isEditing(), false, "a replacement route must not inherit another route's draft");
  }
  {
    const route = createRoute([note(1)]);
    route.setKeyboardVisible(false);
    const card = mount(route, 1); card.edit();
    assert.equal(card.saveAction().props.disabled, false, "editing must expose an enabled Save action inside its card");
    let focusCalls = 0, blurCalls = 0;
    card.input().props.ref.current = {
      isFocused: () => false,
      focus: () => { focusCalls++; },
      blur: () => { blurCalls++; },
    };
    const pendingCallbacks = [...frames.values()];
    assert.ok(pendingCallbacks.length > 0, "editing must have a pending focus fallback to challenge");
    card.saveAction().props.onPress();
    assert.equal(blurCalls, 1, "Save must release native focus before waiting for a render");
    assert.equal(route.getDismissals(), 1, "Save before keyboard show must still dismiss the pending keyboard");
    assert.equal(route.getComposerReleasePending(), false, "an unopened keyboard must not hold the composer indefinitely");
    assert.equal(route.saves.length, 0, "unchanged Save must not add a persistence command");
    for (const callback of pendingCallbacks) callback();
    assert.equal(focusCalls, 0, "a captured focus callback must not refocus a synchronously finished editor");
    card.render();
    assert.equal(card.isEditing(), false);
    card.unmount();
  }
  {
    const route = createRoute([note(1), note(2)]);
    const first = mount(route, 1); first.edit(); first.type("Updated first entry");
    let firstBlurCalls = 0;
    first.input().props.ref.current = {
      isFocused: () => true, focus: () => {}, blur: () => { firstBlurCalls++; },
    };
    const previousAction = first.saveAction().props.onPress;
    const second = mount(route, 2); second.edit();
    assert.deepEqual(route.saves, [[1, "Updated first entry"]]);
    assert.equal(firstBlurCalls, 0, "editor handoff must not explicitly blur the previous native input");
    assert.equal(route.getDismissals(), 0, "editor handoff must not dismiss the keyboard");
    previousAction();
    assert.deepEqual(route.saves, [[1, "Updated first entry"]], "a finished card action must not save the next editor");
    second.type("Current second entry");
    second.save();
    assert.deepEqual(route.saves, [[1, "Updated first entry"], [2, "Current second entry"]]);
    assert.equal(route.getDismissals(), 1);
    assert.equal(route.getComposerReleasePending(), true, "a visible keyboard must hold the composer until it hides");
    first.unmount(); second.unmount();
  }
  {
    const route = createRoute([note(1)]);
    const card = mount(route, 1); card.edit(); card.type("Latest unsaved content"); card.unmount();
    const previousAction = card.saveAction().props.onPress;
    assert.equal(route.getPhysicalOwner(), undefined);
    previousAction();
    assert.equal(route.saves.length, 0, "a detached card action must not save through its disposed native owner");
    const restored = mount(route, 1); restored.save();
    assert.deepEqual(route.saves, [[1, "Latest unsaved content"]], "a remounted card must save its retained logical editor exactly once");
    assert.equal(route.editorSession.getActiveDraft(), null);
    assert.deepEqual(route.getEditingIds(), []);
    previousAction();
    assert.equal(route.saves.length, 1, "a detached action must not duplicate a later remounted save");
    restored.unmount();
    assert.equal(mount(route, 1).isEditing(), false);
  }
  {
    const route = createRoute([note(1)]);
    const card = mount(route, 1); card.edit(); card.unmount();
    const restored = mount(route, 1); restored.save();
    assert.equal(route.saves.length, 0, "an unchanged detached editor must close without a write");
    assert.equal(route.editorSession.getActiveDraft(), null);
    assert.deepEqual(route.getEditingIds(), []);
    restored.unmount();
  }
  {
    const route = createRoute([note(1)]);
    const card = mount(route, 1); card.edit(); card.type(" \n\t "); card.unmount();
    const restored = mount(route, 1);
    assert.equal(restored.saveAction().props.disabled, true, "a blank remounted draft must disable its card Save");
    assert.deepEqual(restored.saveAction().props.accessibilityState, { disabled: true });
    restored.save();
    assert.equal(route.saves.length, 0);
    assert.equal(route.editorSession.getActiveDraft()?.text, " \n\t ", "blank Save must retain the exact draft");
    assert.deepEqual(route.getEditingIds(), [1], "blank Save must not dismiss the logical editor");
    assert.equal(route.getDismissals(), 0);
    restored.unmount();
  }
  {
    const route = createRoute([note(1)]);
    const card = mount(route, 1); card.edit();
    const initialUpdates = card.hooks.updates;
    card.type(""); card.render();
    assert.equal(card.saveAction().props.disabled, true, "clearing a card must disable Save");
    assert.equal(card.hooks.updates, initialUpdates + 1, "clearing must publish one availability transition");
    card.type(" \n"); card.render();
    assert.equal(card.hooks.updates, initialUpdates + 1, "typing more whitespace must not publish the same availability again");
    card.type("Restored nonempty draft"); card.render();
    assert.equal(card.saveAction().props.disabled, false, "refilling a card must enable Save");
    assert.equal(card.hooks.updates, initialUpdates + 2);
    card.type("Restored nonempty draft continued");
    assert.equal(card.hooks.updates, initialUpdates + 2, "ordinary nonempty typing must remain ref-backed");
    card.save();
    assert.deepEqual(route.saves, [[1, "Restored nonempty draft continued"]]);
    card.unmount();
  }
  for (const detached of [false, true]) {
    const route = createRoute([note(1)]);
    let card = mount(route, 1); card.edit(); card.type("Retryable editor text");
    if (detached) { card.unmount(); card = mount(route, 1); }
    route.setSaveAccepted(false);
    card.save();
    assert.equal(route.saves.length, 0);
    assert.equal(route.getSaveAttempts().length, 1);
    assert.equal(route.editorSession.getActiveDraft()?.text, "Retryable editor text", "rejected Save must retain the latest logical draft");
    assert.deepEqual(route.getEditingIds(), [1]);
    assert.equal(route.getDismissals(), 0, "rejected Save must not dismiss the keyboard");
    route.setSaveAccepted(true);
    card.save();
    assert.deepEqual(route.saves, [[1, "Retryable editor text"]]);
    assert.equal(route.editorSession.getActiveDraft(), null);
    card.unmount();
  }
  {
    const route = createRoute([note(1)]);
    const card = mount(route, 1); card.edit();
    card.type("Visible native draft");
    route.setNotes([note(1, "Newer stored projection")]);
    card.props.note = route.getNote(1); card.render();
    card.save();
    assert.deepEqual(route.saves, [[1, "Visible native draft"]], "the mounted command must read the live editor rather than a newer stored projection");
    card.unmount();
  }
  {
    const pending = { ...note(-13), clientMutationId: "optimistic:1:13" };
    const route = createRoute([pending]);
    const card = mount(route, -13); card.edit(); card.type("Updated temporary entry");
    card.save();
    assert.deepEqual(route.saves, [[-13, "Updated temporary entry"]], "card Save must admit a stable negative UI identity");
    card.unmount();
  }
  assert.match(routeSource, /key=\{`\$\{editorSession\.generation\}:\$\{item\.clientMutationId\}`\}/,
    "a reused persisted identity in another dataset must receive a new native editor");
  const editorStateStart = routeSource.indexOf("const [editorSession, setEditorSession]");
  const editorStateEnd = routeSource.indexOf("const habitExists", editorStateStart);
  assert.ok(editorStateStart >= 0 && editorStateEnd > editorStateStart);
  const editorSnapshot = { generation: 1 };
  const renderEditorOwner = loadSourceCallableForAudit<() => NoteEditorSession>(
    `function editorOwner() { ${routeSource.slice(editorStateStart, editorStateEnd)} return editorSession; }`,
    "editorOwner", {
      useState: react.useState, useRef: react.useRef, useLayoutEffect: react.useLayoutEffect,
      notesSnapshot: editorSnapshot, NoteEditorSession,
    },
  );
  const editorHooks = new Hooks();
  const editorRender = () => {
    let value: NoteEditorSession;
    do {
      selectHooks(editorHooks); editorHooks.cursor = 0; editorHooks.dirty = false;
      value = renderEditorOwner();
    } while (editorHooks.dirty);
    return value;
  };
  const initialOwner = editorRender();
  assert.equal(editorRender(), initialOwner, "ordinary renders must retain one semantic editor owner");
  initialOwner.begin({ clientMutationId: "note:1", noteId: 1, text: "Previous draft", baseText: "Stored", sourceText: "Stored", recoverySequence: 0, viewportHeight: 20 });
  const previousDatasetCard = mount(createRoute([note(1)], initialOwner), 1);
  assert.equal(previousDatasetCard.input().props.defaultValue, "Previous draft");
  previousDatasetCard.unmount();
  editorSnapshot.generation++;
  const replacedOwner = editorRender();
  assert.notEqual(replacedOwner, initialOwner);
  assert.equal(replacedOwner.generation, 2);
  assert.equal(replacedOwner.getActiveDraft(), null, "same-route generation replacement must revoke the previous logical editor");
  const replacementCard = mount(createRoute([note(1, "Replacement text")], replacedOwner), 1);
  assert.equal(replacementCard.isEditing(), false);
  replacementCard.edit();
  assert.equal(replacementCard.input().props.defaultValue, "Replacement text", "a generation remount must seed from the replacement dataset, not the previous draft");
  replacementCard.unmount();
  const recoveryStateStart = routeSource.indexOf("const [noteRecoveryDrafts, setNoteRecoveryDrafts]");
  const recoveryStateEnd = routeSource.indexOf("const shouldScrollToNewNoteRef", recoveryStateStart);
  assert.ok(recoveryStateStart >= 0 && recoveryStateEnd > recoveryStateStart);
  const snapshot = { generation: 1 };
  const renderRecoveryOwner = loadSourceCallableForAudit<() => {
    noteRecoveryDrafts: Map<number, { sequence: number; text: string }>;
    setNoteRecoveryDrafts: (drafts: Map<number, { sequence: number; text: string }>) => void;
  }>(`function recoveryOwner() { ${routeSource.slice(recoveryStateStart, recoveryStateEnd)}
    return { noteRecoveryDrafts, setNoteRecoveryDrafts }; }`, "recoveryOwner", {
    useState: react.useState,
    notesSnapshot: snapshot,
  });
  const recoveryHooks = new Hooks();
  const recoveryRender = () => {
    let value: ReturnType<typeof renderRecoveryOwner>;
    do {
      selectHooks(recoveryHooks); recoveryHooks.cursor = 0; recoveryHooks.dirty = false;
      value = renderRecoveryOwner();
    } while (recoveryHooks.dirty);
    return value;
  };
  let recovery = recoveryRender();
  recovery.setNoteRecoveryDrafts(new Map([[1, { sequence: 1, text: "Previous dataset" }]]));
  assert.equal(recoveryRender().noteRecoveryDrafts.size, 1);
  snapshot.generation++;
  recovery = recoveryRender();
  assert.equal(recovery.noteRecoveryDrafts.size, 0, "same-route dataset replacement must discard recovery text before rendering reused note IDs");
}

export async function auditNoteEditorRecoveryGeometry(sources: LifecycleSources = {}): Promise<void> {
  const harness = createLifecycleHarness(sources);
  const { createRoute, mount, nativeCaret, flushFrames } = harness;
  nativeCaret.available = true;
  nativeCaret.tag = 77;
  const metrics = (textLength: number, selection = 2): NoteEditorCaretMetrics => ({
    top: 0, bottom: 20, hostWidth: 240, hostHeight: 40,
    textLength, selectionStart: selection, selectionEnd: selection,
  });
  {
    const route = createRoute([note(1, "Entry one")]);
    const card = mount(route, 1); card.edit();
    let nativeText = "Entry one";
    let previousGeometry: (typeof route.geometry)[number];
    card.input().props.ref.current = {
      isFocused: () => true, focus: () => {}, blur: () => {}, setSelection: () => {},
      setNativeProps: ({ text }: { text: string }) => {
        assert.notEqual(previousGeometry.targets.getRequestId(), previousGeometry.requestId,
          "recovery must revoke the previous geometry before native text replacement");
        nativeText = text;
        nativeCaret.result = metrics(text.length);
      },
    };
    try {
      card.input().props.onFocus();
      card.input().props.onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } });
      previousGeometry = route.geometry.at(-1)!;
      nativeCaret.result = metrics(nativeText.length);
      assert.deepEqual(await previousGeometry.targets.readCaretMetrics(), nativeCaret.result,
        "the original geometry must have a valid native query before recovery");
      const previousQuery = previousGeometry.targets.readCaretMetrics();
      card.props.recoveryDraft = { sequence: 1, text: "Entry two" };
      card.render();
      assert.equal(nativeText, "Entry two");
      assert.equal(route.editorSession.getActiveDraft()?.text, "Entry two");
      flushFrames();
      const recovered = route.geometry.at(-1)!;
      assert.notEqual(recovered.requestId, previousGeometry.requestId,
        "same-length recovery must publish a new geometry request without native size or selection events");
      assert.equal(recovered.length, previousGeometry.length);
      assert.equal(recovered.heightBucket, previousGeometry.heightBucket);
      assert.ok(recovered.contentRevision > previousGeometry.contentRevision,
        "same-length recovery must advance the content revision");
      assert.equal(recovered.selectionStart, null);
      assert.equal(recovered.selectionEnd, null);
      assert.equal(await previousQuery, null, "recovery must reject an in-flight query for the replaced text");
      const acknowledged = nativeCaret.result;
      nativeCaret.result = null;
      assert.equal(await recovered.targets.readCaretMetrics(), null);
      assert.deepEqual(nativeCaret.calls.at(-1), { tag: 77, eventCount: 0, expectedText: "Entry two" },
        "a recovery query must require the exact pending native text until acknowledgement");
      nativeCaret.result = { ...metrics(nativeText.length), top: 1, bottom: 21 };
      assert.equal(await recovered.targets.readCaretMetrics(), null,
        "a clipped measurement must not acknowledge the pending native text");
      nativeCaret.result = acknowledged;
      assert.deepEqual(await recovered.targets.readCaretMetrics(), nativeCaret.result,
        "recovery must publish a geometry whose actual native query is usable");
      assert.deepEqual(nativeCaret.calls.at(-1), { tag: 77, eventCount: 0, expectedText: "Entry two" },
        "a rejected native query must not clear the pending text requirement");
      assert.deepEqual(await recovered.targets.readCaretMetrics(), nativeCaret.result);
      assert.deepEqual(nativeCaret.calls.at(-1), { tag: 77, eventCount: 0, expectedText: null },
        "a fresh successful native acknowledgement must clear the pending text requirement");
      nativeCaret.result = { ...metrics(nativeText.length), top: 1, bottom: 21 };
      assert.equal(await recovered.targets.readCaretMetrics(), null,
        "a caret inside the clipped spare line must not become a scroll target before measured growth");
      card.input().props.onContentSizeChange({ nativeEvent: { contentSize: { height: 40 } } });
      card.render();
      const grown = route.geometry.at(-1)!;
      assert.deepEqual(await grown.targets.readCaretMetrics(), nativeCaret.result,
        "the same caret must become usable once the measured editor viewport includes it");
    } finally {
      card.unmount();
    }
  }
  {
    const route = createRoute([note(2, "Alpha one")]);
    const card = mount(route, 2); card.edit();
    card.input().props.ref.current = {
      isFocused: () => true, focus: () => {}, blur: () => {}, setSelection: () => {},
    };
    try {
      card.input().props.onFocus();
      card.input().props.onSelectionChange({ nativeEvent: { selection: { start: 2, end: 2 } } });
      const beforeTyping = route.geometry.at(-1)!;
      nativeCaret.result = metrics(beforeTyping.length);
      const previousQuery = beforeTyping.targets.readCaretMetrics();
      card.input().props.onChange({ nativeEvent: { text: "Alpha two", eventCount: 4 } });
      flushFrames();
      const typed = route.geometry.at(-1)!;
      assert.equal(typed.length, beforeTyping.length);
      assert.equal(typed.heightBucket, beforeTyping.heightBucket);
      assert.ok(typed.contentRevision > beforeTyping.contentRevision,
        "a same-length native edit must publish its current content revision");
      assert.notEqual(typed.requestId, beforeTyping.requestId);
      assert.equal(await previousQuery, null, "same-length typing must revoke a query from the previous text");
      assert.deepEqual(await typed.targets.readCaretMetrics(), nativeCaret.result,
        "same-length typing must publish a usable native query without a content-size event");
      assert.deepEqual(nativeCaret.calls.at(-1), { tag: 77, eventCount: 4, expectedText: null },
        "the native query must use the latest native text event count");
      const typedQuery = typed.targets.readCaretMetrics();
      nativeCaret.result = metrics(typed.length, 3);
      card.input().props.onSelectionChange({ nativeEvent: { selection: { start: 3, end: 3 } } });
      const selected = route.geometry.at(-1)!;
      assert.notEqual(selected.requestId, typed.requestId,
        "moving between two interior selections must publish a new geometry request");
      assert.equal(selected.contentRevision, typed.contentRevision);
      assert.equal(selected.selectionStart, 3);
      assert.equal(selected.selectionEnd, 3);
      assert.equal(await typedQuery, null, "a changed selection must revoke the previous native query");
      assert.deepEqual(await selected.targets.readCaretMetrics(), nativeCaret.result,
        "the latest interior selection must retain a valid native query");
    } finally {
      card.unmount();
    }
  }
}

export async function auditNoteEditorRecoveryGeometryMutations(): Promise<number> {
  const route = readFileSync("app/habit/[id]/notes.tsx", "utf8").replace(/\r\n/g, "\n");
  const noteCard = readFileSync("src/features/notes/components/NoteCard.tsx", "utf8").replace(/\r\n/g, "\n");
  const replaceOnce = (source: string, from: string, to: string) => {
    assert.equal(source.split(from).length, 2, "each recovery mutation must target one current source region");
    return source.replace(from, to);
  };
  await auditNoteEditorRecoveryGeometry({ route, noteCard });
  const trials = [
    {
      noteCard: replaceOnce(noteCard, "      queueEditorGeometry(editorViewportHeightRef.current);\n      inputRef.current?.setNativeProps", "      inputRef.current?.setNativeProps"),
      expected: "recovery must revoke the previous geometry before native text replacement",
    },
    {
      noteCard: replaceOnce(noteCard, "        if (!editorOwner.live || !editingRef.current) return;\n        publishEditorGeometry();", "        if (!editorOwner.live || !editingRef.current) return;"),
      expected: "same-length recovery must publish a new geometry request without native size or selection events",
    },
    {
      noteCard: replaceOnce(noteCard, "    draftTextRef.current = nextDraft;\n    updateDraftAvailability(nextDraft);\n    contentRevisionRef.current += 1;", "    draftTextRef.current = nextDraft;\n    updateDraftAvailability(nextDraft);"),
      expected: "same-length recovery must advance the content revision",
    },
    {
      noteCard: replaceOnce(noteCard, "    if (previous?.start === next?.start && previous?.end === next?.end) return;", "    if ((previous?.start === draftTextRef.current.length && previous?.end === draftTextRef.current.length) === (next?.start === draftTextRef.current.length && next?.end === draftTextRef.current.length)) return;"),
      expected: "moving between two interior selections must publish a new geometry request",
    },
    {
      noteCard: replaceOnce(noteCard, "tag, nativeEventCountRef.current, pendingNativeTextRef.current,", "tag, nativeEventCountRef.current, null,"),
      expected: "a recovery query must require the exact pending native text until acknowledgement",
    },
    {
      noteCard: replaceOnce(noteCard, '(Platform.OS === "android" && result.bottom > editorViewportHeightRef.current + 0.5)', "false"),
      expected: "a clipped measurement must not acknowledge the pending native text",
    },
  ];
  for (const trial of trials) {
    await assert.rejects(auditNoteEditorRecoveryGeometry({ route, noteCard: trial.noteCard }), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.includes(trial.expected),
    `the recovery mutation must violate its intended behavior: ${trial.expected}`);
  }
  return trials.length;
}

export function auditNoteEditorLifecycleMutations(): number {
  const route = readFileSync("app/habit/[id]/notes.tsx", "utf8").replace(/\r\n/g, "\n");
  const noteCard = readFileSync("src/features/notes/components/NoteCard.tsx", "utf8").replace(/\r\n/g, "\n");
  const replaceOnce = (source: string, from: string, to: string) => {
    assert.equal(source.split(from).length, 2, "each lifecycle mutation must target one current source region");
    return source.replace(from, to);
  };
  auditNoteEditorLifecycle({ route, noteCard });
  const trials = [
    {
      source: { noteCard: replaceOnce(noteCard, "disabled={editing && !hasDraftText}", "disabled={false}") },
      expected: "a blank remounted draft must disable its card Save",
    },
    {
      source: { noteCard: replaceOnce(noteCard, "    if (hasDraftTextRef.current === next) return;\n    hasDraftTextRef.current = next;\n    setHasDraftText(next);", "    hasDraftTextRef.current = next;\n    setHasDraftText(text as unknown as boolean);") },
      expected: "ordinary typing must not render controlled text",
    },
    {
      source: { noteCard: replaceOnce(noteCard, "const trimmed = draftTextRef.current.trim();", "const trimmed = editorInitialText.trim();") },
      expected: "Save must read the live draft rather than the immutable mount seed",
    },
    {
      source: { noteCard: replaceOnce(noteCard, "      if (!editorOwner.live || !editingRef.current) return;\n      if (!inputRef.current?.isFocused())", "      if (!inputRef.current?.isFocused())") },
      expected: "a captured focus callback must not refocus a synchronously finished editor",
    },
    {
      source: { noteCard: replaceOnce(noteCard, "        baseText: initialDraft,\n        sourceText: note.text,", "        baseText: initialDraft,\n        sourceText: initialDraft,") },
      expected: "a recovered closed editor must retain unsaved changes against its displayed source",
    },
    {
      source: { noteCard: replaceOnce(replaceOnce(noteCard,
        "      editorSession.update(note.clientMutationId, { sourceText: note.text });",
        "      void note.text;"),
      "      text: nextDraft,\n      sourceText: note.text,",
      "      text: nextDraft,") },
      expected: "an active recovered editor must compare against the rolled-back displayed source",
    },
    {
      source: { noteCard: replaceOnce(noteCard, "      if (!enterEditing(nextDraft)) return;", "      enterEditing(nextDraft);") },
      expected: "a refused editor handoff must not acknowledge or consume recovery",
    },
    {
      source: { route: replaceOnce(route,
        "if (!unclaimedRecovery && change.sequence <= lastProcessedPresentationChangeRef.current)",
        "if (change.sequence <= lastProcessedPresentationChangeRef.current)") },
      expected: "a reopened route must restore an unclaimed create older than its initial event cursor",
    },
    {
      source: { route: replaceOnce(route,
        "if (current.get(noteId)?.sequence !== sequence) return current;\n        const next = new Map(current);\n        next.delete(noteId);",
        "if (current.get(noteId)?.sequence !== sequence) return current;\n        const next = new Map(current);") },
      expected: "actual card application must clear the route recovery map to prevent later resurrection",
    },
    {
      source: { route: replaceOnce(route, " && unclaimedSequences.has(change.sequence)", "") },
      expected: "a parent layout-effect with a stale snapshot must not resurrect recovery acknowledged by its child",
    },
  ];
  for (const trial of trials) {
    assert.throws(() => auditNoteEditorLifecycle({ route: trial.source.route ?? route, noteCard: trial.source.noteCard ?? noteCard }), (error: unknown) =>
      error instanceof assert.AssertionError && error.message.includes(trial.expected),
    `the lifecycle mutation must violate its intended behavior: ${trial.expected}`);
  }
  return trials.length;
}
