import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NoteEditorSession } from "../../src/features/notes/utils/note-editor-session";
import { loadSourceCallableForAudit } from "./load-source-callable-for-audit";

interface Action { type: string }
interface Element { props: { visible: boolean; actions: { onPress(): void }[] } }

function auditGuard(source: string): void {
  for (const enabled of [false, true]) {
    for (const hasComposerDraft of [false, true]) {
      for (const hasEditorDraft of [false, true]) {
        let pending: Action | null = null;
        let prevented = false;
        let prevent!: (event: { data: { action: Action } }) => void;
        const dispatched: Action[] = [];
        const editorSession = { subscribe() {}, hasUnsavedChanges: () => hasEditorDraft };
        const render = loadSourceCallableForAudit<(props: object) => Element>(source, "UnsavedNotesGuard", {
          exports: {},
          useTranslation: () => ({ t: (key: string) => key }),
          useNavigation: () => ({ dispatch: (action: Action) => dispatched.push(action) }),
          useSyncExternalStore: (_subscribe: unknown, read: () => boolean) => read(),
          useState: () => [pending, (update: Action | null | ((current: Action | null) => Action | null)) => {
            pending = typeof update === "function" ? update(pending) : update;
          }],
          usePreventRemove: (value: boolean, callback: typeof prevent) => { prevented = value; prevent = callback; },
          Dialog: "Dialog",
          require: () => ({ jsx: (_type: unknown, props: Element["props"]) => ({ props }) }),
        }, true);
        const props = { editorSession, hasComposerDraft, enabled };
        assert.equal(render(props).props.visible, false);
        assert.equal(prevented, enabled && (hasComposerDraft || hasEditorDraft));
        if (!prevented) continue;
        const first = { type: "GO_BACK" };
        prevent({ data: { action: first } });
        prevent({ data: { action: { type: "POP" } } });
        let dialog = render(props);
        assert.equal(dialog.props.visible, true);
        dialog.props.actions[0].onPress();
        assert.equal(render(props).props.visible, false);
        assert.equal(dispatched.length, 0, "Cancel must keep the draft and current screen");
        prevent({ data: { action: first } });
        dialog = render(props);
        dialog.props.actions[1].onPress();
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0], first, "Discard must continue the original navigation intent exactly once");
        assert.equal(render(props).props.visible, false);
      }
    }
  }
}

export function auditUnsavedNotesGuard(): void {
  const source = readFileSync("src/features/notes/components/UnsavedNotesGuard.tsx", "utf8");
  auditGuard(source);
  for (const [target, replacement] of [
    ["enabled && (hasComposerDraft || hasEditorDraft)", "enabled && hasEditorDraft"],
    ["enabled && (hasComposerDraft || hasEditorDraft)", "hasComposerDraft || hasEditorDraft"],
    ["onPress: () => setLeaveAction(null)", 'onPress: () => navigation.dispatch({ type: "GO_BACK" })'],
    ["if (action) navigation.dispatch(action);", "if (false) navigation.dispatch(action);"],
  ]) {
    assert.ok(source.includes(target));
    assert.throws(() => auditGuard(source.replace(target, replacement)), { name: "AssertionError" });
  }

  const session = new NoteEditorSession();
  let notifications = 0;
  const unsubscribe = session.subscribe(() => notifications++);
  session.begin({ clientMutationId: "note:1", noteId: 1, text: "Saved", baseText: "Saved", sourceText: "Saved", recoverySequence: 0, viewportHeight: 20 });
  assert.equal(session.hasUnsavedChanges(), false);
  session.update("note:1", { text: "Changed" });
  assert.equal(session.hasUnsavedChanges(), true);
  assert.equal(notifications, 1);
  session.update("note:1", { text: "More text", viewportHeight: 40 });
  assert.equal(notifications, 1, "ordinary typing and geometry must not repeatedly publish a dirty flag");
  session.finish("another-note");
  assert.equal(session.hasUnsavedChanges(), true);
  session.update("note:1", { text: " Saved " });
  assert.equal(session.hasUnsavedChanges(), false);
  assert.equal(notifications, 2);
  session.update("note:1", { text: "" });
  assert.equal(session.hasUnsavedChanges(), true, "erasing an existing note is still an unsaved change");
  session.reconcile([]);
  assert.equal(session.hasUnsavedChanges(), false);
  assert.equal(notifications, 4);
  unsubscribe();
  session.begin({ clientMutationId: "note:2", noteId: 2, text: "Draft", baseText: "Saved", sourceText: "Saved", recoverySequence: 0, viewportHeight: 20 });
  assert.equal(notifications, 4);
  session.begin({ clientMutationId: "note:3", noteId: 3, text: "Recovered", baseText: "Recovered", sourceText: "Stored", recoverySequence: 1, viewportHeight: 20 });
  assert.equal(session.hasUnsavedChanges(), true, "recovery ancestry is not the displayed source snapshot");
  session.update("note:3", { text: "Stored" });
  assert.equal(session.hasUnsavedChanges(), false, "returning to the displayed source must clear the warning");
}
