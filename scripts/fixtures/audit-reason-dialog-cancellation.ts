import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OneShotActionGate } from "../../src/application/interaction/one-shot-action-gate";

interface Element {
  type: unknown;
  props: Record<string, any>;
}
type Loader = <T>(source: string, name: string, environment: Record<string, unknown>) => T;
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

class Hooks {
  private slots: any[] = [];
  private cursor = 0;
  readonly cleanups: (() => void)[] = [];
  readonly environment = {
    useState: (initial: unknown) => {
      const index = this.cursor++;
      if (!(index in this.slots)) this.slots[index] = initial;
      return [this.slots[index], (next: any) => {
        this.slots[index] = typeof next === "function" ? next(this.slots[index]) : next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = this.cursor++;
      return this.slots[index] ?? (this.slots[index] = { current: initial });
    },
    useCallback: (callback: unknown) => callback,
    useImperativeHandle: (ref: { current: unknown }, create: () => unknown) => { ref.current = create(); },
    useLayoutEffect: (setup: () => () => void) => {
      const index = this.cursor++;
      if (index in this.slots) return;
      this.slots[index] = true;
      this.cleanups.push(setup());
    },
  };
  render<T>(callback: () => T): T {
    this.cursor = 0;
    return callback();
  }
}

async function auditDialog(load: Loader, source: string): Promise<void> {
  const renderSurface = load<(props: Record<string, unknown>) => Element>(
    read("src/components/ui/Dialog.tsx"), "Dialog", {
      useWindowDimensions: () => ({ width: 393, height: 800 }),
      useVisualColorScheme: () => "orange",
      useVisualEffectiveMode: () => "dark",
      getAccentScheme: () => ({ base: "#FF5A2A" }),
      darkTheme: {}, lightTheme: {}, scrimColor: "rgba(0,0,0,0.6)",
      sizes: { dialogWidth: 320, dialogPadding: 20 }, radii: { dialog: 16 }, borders: { hairline: 0.5 },
      AppModal: "modal", Pressable: "pressable", View: "view", Text: "text", ScrollView: "scroll",
    },
  );
  for (const status of ["failure", "skipped"]) {
    for (const theme of ["dark", "light"]) {
      for (const gesture of ["button", "scrim", "back"]) {
        const hooks = new Hooks();
        let cancels = 0;
        const saves: string[] = [];
        const render = load<(props: Record<string, unknown>) => Element>(source, "FailureReasonDialogSession", {
          ...hooks.environment,
          useTranslation: () => ({ t: (key: string) => key }),
          useVisualEffectiveMode: () => theme,
          Dialog: "dialog", TextInput: "input",
        });
        const props = { visible: true, status, initialReason: "Unsaved reason", onDismiss: () => {},
          onCancel: () => { cancels++; }, onSave: (reason: string) => { saves.push(reason); return true; } };
        const dialog = hooks.render(() => render(props));
        assert.equal(dialog.props.actions.length, 2);
        assert.deepEqual(Array.from(dialog.props.actions, (action: any) => action.label),
          ["common.cancel", "failureDialog.save"]);
        assert.equal(dialog.props.actions[0].role, "cancel");
        const surface = renderSurface(dialog.props);
        const scrim = surface.props.children;
        let stopped = false;
        scrim.props.children.props.onPress({ stopPropagation: () => { stopped = true; } });
        assert.equal(stopped, true, "pressing inside the card must not cancel the dialog");
        assert.equal(cancels, 0);
        if (gesture === "button") dialog.props.actions[0].onPress();
        else if (gesture === "scrim") scrim.props.onPress();
        else assert.equal(surface.props.onRequestClose(), true);
        dialog.props.actions[0].onPress();
        await dialog.props.actions[1].onPress();
        assert.equal(cancels, 1, "a cancellation gesture must be delivered once");
        assert.deepEqual(saves, [], "cancel and late Save must not submit the discarded draft");
      }
    }
  }
  for (const initialReason of ["  Accepted reason  ", "   "]) {
    const hooks = new Hooks();
    const saves: string[] = [];
    let cancels = 0;
    let allow = false;
    let fail = false;
    const render = load<(props: Record<string, unknown>) => Element>(source, "FailureReasonDialogSession", {
      ...hooks.environment, useTranslation: () => ({ t: (key: string) => key }),
      useVisualEffectiveMode: () => "dark", Dialog: "dialog", TextInput: "input",
      console: { error: () => {} },
    });
    const props = { visible: true, status: "failure", initialReason, onDismiss: () => {},
      onCancel: () => { cancels++; }, onSave: (reason: string) => {
        saves.push(reason);
        if (fail) throw new Error("Write unavailable");
        return allow;
      } };
    let dialog = hooks.render(() => render(props));
    await dialog.props.actions[1].onPress();
    dialog = hooks.render(() => render(props));
    assert.equal(dialog.props.actions[1].disabled, false, "a refused save must remain retryable");
    fail = true;
    await dialog.props.actions[1].onPress();
    dialog = hooks.render(() => render(props));
    assert.equal(dialog.props.actions[0].disabled, false, "a failed save must remain cancellable");
    fail = false;
    allow = true;
    const saving = dialog.props.actions[1].onPress();
    dialog.props.actions[0].onPress();
    await dialog.props.actions[1].onPress();
    await saving;
    assert.equal(cancels, 0, "late cancellation must not replace an accepted save");
    assert.deepEqual(saves, [initialReason.trim(), initialReason.trim(), initialReason.trim()],
      "Save must trim reasons, allow empty reasons, and suppress duplicate delivery");
  }
}

function auditDetail(load: Loader, source: string): void {
  for (const status of ["failure", "skipped"]) {
    const hooks = new Hooks();
    const calls: unknown[] = [];
    const target: { current: any } = { current: null };
    const render = load<(props: Record<string, unknown>, ref: unknown) => Element>(
      source, "HabitDetailStatusOverlayControllerComponent", {
        ...hooks.environment, OneShotActionGate,
        useSettingsStore: { getState: () => ({ askFailureReason: true, askSkipReason: true }) },
        MemoizedCalendarDayMenu: "menu", FailureReasonDialog: "reason",
      },
    );
    const update = () => hooks.render(() => render({ onApplyStatus: (command: unknown) => calls.push(command) }, target));
    update();
    const open = () => {
      target.current.openDayMenu({ date: "2030-06-04", x: 10, y: 20 });
      const menu = update().props.children[0];
      menu.props[status === "failure" ? "onFailure" : "onSkip"]();
      const dialog = update().props.children[1];
      assert.equal(dialog.props.visible, true);
      return dialog;
    };
    const cancelled = open();
    assert.equal(typeof cancelled.props.onCancel, "function", "the calendar reason dialog must support cancellation");
    cancelled.props.onCancel();
    cancelled.props.onCancel();
    assert.equal(cancelled.props.onSave("Discarded reason"), false);
    const hidden = update().props.children[1];
    assert.equal(hidden.props.visible, false);
    hidden.props.onDismiss();
    target.current.flushPendingCommandBeforeOwnerUnmount();
    assert.deepEqual(calls, [], "calendar reason cancellation must not mutate a day or create a reason note");
    const saved = open();
    assert.equal(saved.props.onSave("Accepted reason"), true);
    saved.props.onCancel();
    assert.equal(saved.props.onSave("Duplicate reason"), false);
    assert.deepEqual(calls, [], "accepted calendar reasons must wait for physical dismissal");
    update().props.children[1].props.onDismiss();
    target.current.flushPendingCommandBeforeOwnerUnmount();
    hooks.cleanups.forEach((cleanup) => cleanup());
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(calls[0]), JSON.stringify({
      date: "2030-06-04", status, reason: "Accepted reason", afterReasonDismiss: true,
    }), "calendar Save must deliver the captured status exactly once");
  }
}

export async function auditReasonDialogCancellation(load: Loader): Promise<void> {
  const dialog = read("src/features/habits/components/FailureReasonDialog.tsx");
  const detail = read("src/features/habit-detail/components/HabitDetailStatusOverlayController.tsx");
  await auditDialog(load, dialog);
  auditDetail(load, detail);
  for (const [before, after, expected] of [
    ['role: "cancel",', "role: undefined,", /cancel/],
    ["onPress: handleCancel,", "onPress: handleSave,", /cancellation gesture/],
    ["    isSubmittingRef.current = true;\n    onCancel();", "    onCancel();", /cancellation gesture/],
  ] as const) {
    assert.equal(dialog.split(before).length, 2, "each dialog mutation must have one source target");
    await assert.rejects(() => auditDialog(load, dialog.replace(before, after)), expected);
  }
  const target = "onCancel={cancelFailureReason}";
  assert.equal(detail.split(target).length, 2);
  assert.throws(() => auditDetail(load, detail.replace(target, "onCancel={() => submitFailureReason(\"\")}")),
    /calendar reason cancellation/);
  console.log("Reason dialog audit passed: button, scrim, Back, save retries and calendar handoff; 4 mutations detected.");
}
