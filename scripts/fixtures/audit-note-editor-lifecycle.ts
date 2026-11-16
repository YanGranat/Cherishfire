import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { NoteEditorSession } from "../../src/features/notes/utils/note-editor-session";
import { getNoteEditorContentHeight } from "../../src/features/notes/utils/editor-visibility";
import { mergeRecoveredDraft } from "../../src/utils/recovered-draft";
import type { NotesSessionNote } from "../../src/application/notes/notes-session";
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

export function auditNoteEditorLifecycle(sources: {
  noteCard?: string;
  route?: string;
} = {}): void {
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
  const mocks: Record<string, unknown> = {
    react,
    "nativewind/jsx-runtime": { jsx, jsxs: jsx },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable", Platform: { OS: "android" } },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/theme/colors": { lightTheme: { surfaceElevated: "#FFFFFF" }, semantic: { failure: "#FF0000" } },
    "@/components/ScreenPreferencesBoundary": { useVisualLanguage: () => "en", useVisualEffectiveMode: () => "light" },
    "@/utils/date": { formatLocalizedDate: (value: string) => value },
    "@/theme/tokens": { radii: { listCard: 8 } },
    "@/utils/recovered-draft": { mergeRecoveredDraft },
    "@/features/notes/utils/editor-visibility": { getNoteEditorContentHeight },
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
    const saves: [number, string][] = [];
    const activeEditorSaveRef = { current: null as any };
    const activeEditorNoteIdRef = { current: null as number | null };
    const activeEditorTargetRef = { current: null };
    const activeEditorGeometryRef = { current: null };
    const completedEditorGeometryKeyRef = { current: null };
    const pendingEditorCorrectionRef = { current: null };
    let editingIds = new Set<number>();
    let dismissals = 0;
    const environment = {
      editorSession,
      notesSession: { getSnapshot: () => ({ notes }) },
      activeEditorSaveRef, activeEditorNoteIdRef, activeEditorTargetRef,
      activeEditorGeometryRef, completedEditorGeometryKeyRef, pendingEditorCorrectionRef,
      editorHandoffInProgressRef: { current: false },
      shouldScrollToNewNoteRef: { current: false },
      keyboardVisibleRef: { current: true },
      clearTopScrollSettleTimer: () => {}, clearEditorRevealFrame: () => {},
      clearEditorGeometryFrames: () => {}, setComposerReleasePending: () => {},
      Keyboard: { dismiss: () => { dismissals++; } },
      setEditingNoteIds: (update: (current: Set<number>) => Set<number>) => { editingIds = update(editingIds); },
      handleSave: (id: number, text: string) => {
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
      editorSession, saves, onEditingChange, onEditorUnmount,
      getNote: (id: number) => { const value = notes.find((item) => item.id === id); assert.ok(value); return value; },
      getEditingIds: () => [...editingIds], getDismissals: () => dismissals,
      getPhysicalOwner: () => activeEditorSaveRef.current?.owner,
      onSave: environment.handleSave,
    };
  }
  function mount(route: ReturnType<typeof createRoute>, id: number, recoveryDraft?: { sequence: number; text: string }) {
    const hooks = new Hooks();
    const props = {
      note: route.getNote(id), editorSession: route.editorSession,
      onSave: route.onSave, onDelete: () => {},
      onEditingChange: route.onEditingChange, onEditorUnmount: route.onEditorUnmount,
      recoveryDraft,
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
      save: () => { requiredElement(tree, (element) => element.props.accessibilityLabel === "common.save").props.onPress(); render(); },
      type: (text: string) => { requiredElement(tree, (element) => element.type === "TextInput").props.onChange({ nativeEvent: { text } }); },
      unmount: () => hooks.unmount(),
    };
  }

  {
    const route = createRoute([note(1)]);
    const first = mount(route, 1); first.edit();
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
  assert.match(routeSource, /key=\{`\$\{editorSession\.generation\}:\$\{item\.clientMutationId\}`\}/,
    "a reused persisted identity in another dataset must receive a new native editor");
  const editorStateStart = routeSource.indexOf("const [editorSession, setEditorSession]");
  const editorStateEnd = routeSource.indexOf("const habitExists", editorStateStart);
  assert.ok(editorStateStart >= 0 && editorStateEnd > editorStateStart);
  const editorSnapshot = { generation: 1 };
  const renderEditorOwner = loadSourceCallableForAudit<() => NoteEditorSession>(
    `function editorOwner() { ${routeSource.slice(editorStateStart, editorStateEnd)} return editorSession; }`,
    "editorOwner", { useState: react.useState, notesSnapshot: editorSnapshot, NoteEditorSession },
  );
  const editorHooks = new Hooks();
  const editorRender = () => {
    let value: NoteEditorSession;
    do {
      current = editorHooks; current.cursor = 0; current.dirty = false;
      value = renderEditorOwner();
    } while (current.dirty);
    return value;
  };
  const initialOwner = editorRender();
  assert.equal(editorRender(), initialOwner, "ordinary renders must retain one semantic editor owner");
  initialOwner.begin({ clientMutationId: "note:1", noteId: 1, text: "Previous draft", baseText: "Stored", recoverySequence: 0, viewportHeight: 20 });
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
      current = recoveryHooks; current.cursor = 0; current.dirty = false;
      value = renderRecoveryOwner();
    } while (current.dirty);
    return value;
  };
  let recovery = recoveryRender();
  recovery.setNoteRecoveryDrafts(new Map([[1, { sequence: 1, text: "Previous dataset" }]]));
  assert.equal(recoveryRender().noteRecoveryDrafts.size, 1);
  snapshot.generation++;
  recovery = recoveryRender();
  assert.equal(recovery.noteRecoveryDrafts.size, 0, "same-route dataset replacement must discard recovery text before rendering reused note IDs");
}
