import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { getColorPaletteHeight, getDialogViewportHeight } from "../src/components/ui/dialog-layout";
import { darkTheme, lightTheme } from "../src/theme/colors";
import { borders, radii, sizes } from "../src/theme/tokens";

interface Element { type: unknown; props: Record<string, any> }
interface Effect { dependencies?: readonly unknown[]; cleanup?: () => void }
const flattenStyle = (value: any): Record<string, any> => Array.isArray(value)
  ? Object.assign({}, ...value.map(flattenStyle)) : value ?? {};
const hosts = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(hosts)
  : node && typeof node === "object" && "props" in node
    ? [node as Element, ...hosts((node as Element).props.children)] : [];

function loadModule(source: string, mocks: Record<string, unknown>): Record<string, any> {
  const compiled = ts.transpileModule(source.replace(/^\/\*\* @jsxImportSource nativewind \*\/\r?\n/, ""), {
    fileName: "component.tsx", compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  runInNewContext(compiled, { module, exports: module.exports, require: (name: string) => {
    assert.ok(name in mocks, `unexpected module dependency: ${name}`);
    return mocks[name];
  } });
  return module.exports;
}

function dialogFixture(source: string, os: "android" | "ios" | "web", initiallyOpen = false, initialScreenY?: number | null) {
  let window = { width: 390, height: 760 };
  let frame = { height: 760, screenY: 0 };
  let keyboardY: number | null = initialScreenY === undefined ? initiallyOpen ? 410 : null : initialScreenY;
  const listeners = new Map<string, Set<(event: any) => void>>();
  const slots: unknown[] = [];
  const effects = new Map<number, Effect>();
  let index = 0;
  let dirty = false;
  let pendingLayout: (() => void)[] = [];
  let pendingPassive: (() => void)[] = [];
  let tree: Element;
  let props: Record<string, any>;
  let measuredAvailable = -1;
  let deferredMeasurements = false;
  let stateWrites = 0;
  const preferenceChecks: { resolve: (value: boolean) => void; reject: (reason: Error) => void }[] = [];
  const measurementRequests: (((...args: number[]) => void) | null)[] = [];
  const createMeasuredRoot = () => ({ measureInWindow: (callback: (...args: number[]) => void) => {
    if (deferredMeasurements) measurementRequests.push(callback);
    else callback(0, frame.screenY, window.width, frame.height);
  } });
  let measure = createMeasuredRoot();
  const scheduleEffect = (passive: boolean, callback: () => (() => void) | void, dependencies?: readonly unknown[]) => {
    const current = index++;
    const previous = effects.get(current);
    if (previous && dependencies && previous.dependencies?.length === dependencies.length
      && dependencies.every((value, entry) => Object.is(value, previous.dependencies![entry]))) return;
    const run = () => {
      previous?.cleanup?.();
      const cleanup = callback();
      effects.set(current, { dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined });
    };
    (passive ? pendingPassive : pendingLayout).push(run);
  };
  const react = {
    createElement: (type: unknown, values: object | null, ...children: unknown[]) => ({ type, props: { ...values, children } }),
    useState: (initial: unknown) => {
      const current = index++;
      if (!(current in slots)) slots[current] = typeof initial === "function" ? initial() : initial;
      return [slots[current], (value: unknown) => {
        const next = typeof value === "function" ? value(slots[current]) : value;
        if (!Object.is(next, slots[current])) { slots[current] = next; dirty = true; stateWrites++; }
      }];
    },
    useRef: (initial: unknown) => {
      const current = index++;
      return slots[current] ?? (slots[current] = { current: initial });
    },
    useLayoutEffect: (callback: () => (() => void) | void, dependencies?: readonly unknown[]) => scheduleEffect(false, callback, dependencies),
    useEffect: (callback: () => (() => void) | void, dependencies?: readonly unknown[]) => scheduleEffect(true, callback, dependencies),
  };
  const keyboard = {
    ...(os === "web" ? {} : { metrics: () => keyboardY == null ? undefined : { screenY: keyboardY } }),
    addListener: (name: string, callback: (event: any) => void) => {
      const callbacks = listeners.get(name) ?? new Set();
      callbacks.add(callback);
      listeners.set(name, callbacks);
      return { remove: () => callbacks.delete(callback) };
    },
  };
  const { Dialog } = loadModule(source, {
    react,
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView",
      useWindowDimensions: () => window, Keyboard: keyboard, Platform: { OS: os },
      AccessibilityInfo: { prefersCrossFadeTransitions: () => new Promise<boolean>((resolve, reject) => {
        preferenceChecks.push({ resolve, reject });
      }) } },
    "@expo/vector-icons/MaterialIcons": "MaterialIcons",
    "@/theme/tokens": { sizes, radii, borders },
    "@/components/ScreenPreferencesBoundary": { useVisualColorScheme: () => "orange", useVisualEffectiveMode: () => "dark" },
    "@/theme/colors": { darkTheme, lightTheme, scrimColor: "#00000080", getAccentScheme: () => ({ base: "#4D6FAF" }) },
    "@/components/ui/AppModal": { AppModal: "AppModal" },
    "./dialog-layout": { getDialogViewportHeight },
  });
  const render = (nextProps = props) => {
    props = nextProps;
    index = 0;
    dirty = false;
    pendingLayout = [];
    pendingPassive = [];
    tree = Dialog(props);
    for (const node of hosts(tree)) if (node.props.ref) node.props.ref.current = measure;
    return tree;
  };
  const settleLayout = () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const callbacks = pendingLayout;
      pendingLayout = [];
      callbacks.forEach((callback) => callback());
      if (!dirty) return;
      render();
    }
    assert.fail("dialog layout must settle without a render loop");
  };
  return {
    render, settleLayout,
    settlePassive: () => { const callbacks = pendingPassive; pendingPassive = []; callbacks.forEach((callback) => callback()); if (dirty) { render(); settleLayout(); } },
    get tree() { return tree; },
    get props() { return props; },
    get available() { return measuredAvailable; },
    get stateWrites() { return stateWrites; },
    get preferenceCheckCount() { return preferenceChecks.length; },
    baseProps: { visible: true, title: "Confirm change", actions: [],
      onAvailableHeightChange: (height: number) => { measuredAvailable = height; } },
    setFrame: (nextFrame: typeof frame, nextWindow = window) => { frame = nextFrame; window = nextWindow; },
    measure: () => { const request = measurementRequests.length; hosts(tree).find((node) => node.props.ref)?.props.onLayout(); settleLayout(); return request; },
    deferMeasurements: () => { deferredMeasurements = true; },
    replaceRoot: () => { measure = createMeasuredRoot(); },
    deliverMeasurement: (request: number, result: typeof frame) => {
      const callback = measurementRequests[request];
      assert.ok(callback, "a deferred measurement must have one pending callback");
      measurementRequests[request] = null;
      callback(0, result.screenY, window.width, result.height);
      if (dirty) { render(); settleLayout(); }
    },
    physicalDismiss: () => {
      tree.props.onDismiss();
      measure = createMeasuredRoot();
      if (dirty) { render(); settleLayout(); }
    },
    setMetrics: (value: number | null) => { keyboardY = value; },
    emit: (name: string, value: number | null) => {
      if (name === "keyboardDidShow") keyboardY = value;
      else if (name === "keyboardDidHide") keyboardY = null;
      for (const callback of listeners.get(name) ?? []) callback({ endCoordinates: { screenY: value } });
      if (dirty) { render(); settleLayout(); }
    },
    captured: (name: string) => [...(listeners.get(name) ?? [])],
    resolveCrossFade: async (request: number, value: boolean) => {
      assert.ok(preferenceChecks[request], "a preference resolution must have a pending request");
      preferenceChecks[request].resolve(value);
      await Promise.resolve();
      if (dirty) { render(); settleLayout(); }
    },
    rejectCrossFade: async (request: number) => {
      assert.ok(preferenceChecks[request], "a preference rejection must have a pending request");
      preferenceChecks[request].reject(new Error("Preference unavailable"));
      await Promise.resolve();
      if (dirty) { render(); settleLayout(); }
    },
    subscriberCount: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
    unmount: () => { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); },
  };
}

const dialogSource = readFileSync("src/components/ui/Dialog.tsx", "utf8");
const nativeSource = readFileSync("src/theme/native-appearance.ts", "utf8");
const colorSource = readFileSync("src/features/settings/components/CustomColorDialog.tsx", "utf8");

function auditColorSession(source: string): void {
  let keyboardVisible = false;
  let windowHeight = 760;
  let index = 0;
  const slots: unknown[] = [];
  const react = {
    createElement: (type: unknown, props: object | null, ...children: unknown[]) => ({ type, props: { ...props, children } }),
    memo: (component: unknown) => component,
    useCallback: (callback: unknown) => callback,
    useMemo: (callback: () => unknown) => callback(),
    useRef: (initial: unknown) => {
      const current = index++;
      return slots[current] ?? (slots[current] = { current: initial });
    },
    useState: (initial: unknown) => {
      const current = index++;
      if (!(current in slots)) slots[current] = typeof initial === "function" ? initial() : initial;
      return [slots[current], (value: unknown) => {
        slots[current] = typeof value === "function" ? value(slots[current]) : value;
      }];
    },
  };
  const { CustomColorDialogSession } = loadModule(`${source}\nexport { CustomColorDialogSession };`, {
    react,
    "react-native": {
      View: "View", Text: "Text", TextInput: "TextInput", Keyboard: { isVisible: () => keyboardVisible },
      PanResponder: { create: (callbacks: object) => ({ panHandlers: callbacks }) },
      StyleSheet: { create: (styles: object) => styles },
      useWindowDimensions: () => ({ width: 390, height: windowHeight }),
    },
    "expo-linear-gradient": { LinearGradient: "LinearGradient" },
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@/components/ui/Dialog": { Dialog: "Dialog" },
    "@/components/overlays/DropdownMenu": { DropdownMenu: "DropdownMenu" },
    "@/components/ScreenPreferencesBoundary": { useVisualEffectiveMode: () => "dark", useVisualColorScheme: () => "orange" },
    "@/theme/colors": { darkTheme, lightTheme, getAccentScheme: () => ({ base: "#4D6FAF" }),
      normalizeHexColor: (value: string) => /^#[0-9A-F]{6}$/i.test(value) ? value.toUpperCase() : null },
    "@/components/ui/dialog-layout": { getColorPaletteHeight },
    "@/theme/tokens": { radii, sizes },
    "@/hooks/useRetainedModalSession": {},
  });
  const props = { visible: true, existingColors: [], onCancel() {}, onSubmit: () => true, onDismiss() {} };
  const render = () => { index = 0; return CustomColorDialogSession(props) as Element; };
  const dialog = (tree: Element) => hosts(tree).find((node) => node.type === "Dialog")!;
  const height = (tree: Element) => hosts(tree).find((node) => typeof node.type === "function" && node.type.name === "SaturationValueControl")!.props.height;
  const layout = (tree: Element, measuredHeight: number) => dialog(tree).props.onContentLayout({ nativeEvent: { layout: { height: measuredHeight } } });
  let tree = render();
  assert.equal(height(tree), 176);
  layout(tree, 452);
  keyboardVisible = true;
  dialog(tree).props.onAvailableHeightChange(360);
  tree = render();
  assert.equal(height(tree), 84, "the measured natural height must determine the keyboard deficit");
  layout(tree, 360);
  tree = render();
  assert.equal(height(tree), 84, "constrained card measurements must not become the natural baseline");
  dialog(tree).props.onAvailableHeightChange(240);
  tree = render();
  assert.equal(height(tree), 64);
  keyboardVisible = false;
  layout(tree, 340);
  windowHeight = 900;
  dialog(tree).props.onAvailableHeightChange(windowHeight - 48);
  tree = render();
  assert.equal(height(tree), 176);
  keyboardVisible = true;
  dialog(tree).props.onAvailableHeightChange(360);
  tree = render();
  assert.equal(height(tree), 84, "a keyboard-hide measurement must add back the currently compressed palette");
  keyboardVisible = false;
  dialog(tree).props.onAvailableHeightChange(windowHeight - 48);
  tree = render();
  layout(tree, 470);
  keyboardVisible = true;
  dialog(tree).props.onAvailableHeightChange(390);
  tree = render();
  assert.equal(height(tree), 96, "a later unconstrained measurement must replace the prior natural height");
  const input = hosts(tree).find((node) => node.type === "TextInput")!;
  assert.equal(input.props.value, "#3B82F6");
  assert.equal(input.props.cursorColor, "#4D6FAF");
  assert.equal(input.props.selectionColor, "#4D6FAF");
  slots.length = 0;
  keyboardVisible = true;
  tree = render();
  dialog(tree).props.onAvailableHeightChange(350);
  tree = render();
  assert.equal(height(tree), 108, "first-open keyboard compression must use the default natural estimate until measured");
  layout(tree, 350);
  tree = render();
  assert.equal(height(tree), 108);
  keyboardVisible = false;
  dialog(tree).props.onAvailableHeightChange(712);
  tree = render(); layout(tree, 452);
  keyboardVisible = true;
  dialog(tree).props.onAvailableHeightChange(350);
  tree = render();
  assert.equal(height(tree), 74, "after a keyboard-free measurement the exact estimate must survive the next opening");
}

function viewport(tree: Element): number {
  const node = hosts(tree).find((element) => element.type === "View" && element.props.pointerEvents === "box-none");
  assert.ok(node);
  return flattenStyle(node.props.style).height;
}

function auditDialog(source: string): void {
  for (const os of ["android", "ios"] as const) {
    const fixture = dialogFixture(source, os, true);
    let cancelled = 0;
    const props = { ...fixture.baseProps, actions: [
      { label: "Cancel", role: "cancel", onPress: () => cancelled++ },
      { label: "Apply the selected change", onPress() {} },
    ] };
    assert.equal(viewport(fixture.render(props)), 410, "an already open keyboard must constrain the initial tree");
    fixture.settleLayout();
    assert.equal(fixture.available, 362);
    assert.equal(fixture.subscriberCount(), os === "ios" ? 4 : 2);
    fixture.setFrame({ height: 730, screenY: 30 });
    fixture.measure();
    assert.equal(viewport(fixture.tree), 380, "screen coordinates must be translated to the root origin");
    fixture.setFrame({ height: 380, screenY: 30 });
    fixture.measure();
    assert.equal(viewport(fixture.tree), 380, "a resized root must not subtract the IME height again");
    fixture.setFrame({ height: 500, screenY: 12 }, { width: 680, height: 512 });
    fixture.render(); fixture.settleLayout(); fixture.measure();
    assert.equal(viewport(fixture.tree), 398, "rotation and root-origin changes must replace the prior measurement");
    const show = os === "ios" ? "keyboardWillChangeFrame" : "keyboardDidShow";
    const hide = os === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    fixture.emit(hide, null);
    assert.equal(viewport(fixture.tree), 500);
    assert.equal(fixture.available, 452);
    fixture.emit(show, 350);
    assert.equal(viewport(fixture.tree), 338);
    const lateShow = fixture.captured(show);
    const lateHide = fixture.captured(hide);
    fixture.render({ ...props, visible: false }); fixture.settleLayout();
    const departing = viewport(fixture.tree);
    lateShow.forEach((callback) => callback({ endCoordinates: { screenY: 100 } }));
    lateHide.forEach((callback) => callback({}));
    fixture.render(); fixture.settleLayout();
    assert.equal(viewport(fixture.tree), departing, "queued keyboard events must not move a departing dialog");
    assert.equal(fixture.subscriberCount(), 0);
    fixture.setMetrics(280);
    fixture.render(props); fixture.settleLayout();
    assert.equal(viewport(fixture.tree), 268, "reopening must refresh current keyboard metrics during layout");
    assert.equal(fixture.tree.props.onRequestClose(), true);
    const scrim = hosts(fixture.tree).find((node) => node.type === "Pressable" && node.props.ref)!;
    scrim.props.onPress();
    assert.equal(cancelled, 2);
    let stopped = false;
    const card = hosts(fixture.tree).find((node) => node.type === "Pressable" && !node.props.ref && node.props.onLayout !== undefined)
      ?? hosts(fixture.tree).filter((node) => node.type === "Pressable")[1];
    card.props.onPress({ stopPropagation: () => { stopped = true; } });
    assert.equal(stopped, true);
    const footer = hosts(fixture.tree).find((node) => node.type === "View" && String(node.props.className).includes("justify-end gap-sm"))!;
    assert.equal(flattenStyle(footer.props.style).flexWrap, "wrap");
    for (const action of hosts(footer).filter((node) => node.type === "Pressable")) {
      assert.equal(flattenStyle(action.props.style).maxWidth, "100%");
    }
    fixture.render({ ...props, actions: [{ ...props.actions[0], disabled: true }] }); fixture.settleLayout();
    assert.equal(fixture.tree.props.onRequestClose(), false);
    hosts(fixture.tree).find((node) => node.type === "Pressable" && node.props.ref)!.props.onPress();
    assert.equal(cancelled, 2);
    fixture.unmount();
    assert.equal(fixture.subscriberCount(), 0);
  }
  auditKeyboardReopen(source);
}

function auditKeyboardReopen(source: string): void {
  const hidden = dialogFixture(source, "android", true);
  hidden.render({ ...hidden.baseProps, visible: false }); hidden.settleLayout();
  assert.equal(hidden.subscriberCount(), 0);
  hidden.render(hidden.baseProps); hidden.settleLayout();
  assert.equal(viewport(hidden.tree), 410, "reopening must refresh keyboard metrics before passive effects");
  hidden.unmount();
}

function auditTerminalKeyboardEvents(source: string): void {
  const hiding = dialogFixture(source, "ios", true);
  hiding.render(hiding.baseProps); hiding.settleLayout();
  assert.equal(viewport(hiding.tree), 410);
  hiding.emit("keyboardDidHide", null);
  assert.equal(viewport(hiding.tree), 760, "terminal hide must reconcile an opening after the will-hide event");
  hiding.emit("keyboardDidShow", 360);
  assert.equal(viewport(hiding.tree), 360, "terminal show must reconcile an opening after the will-show event");
  const lateHide = hiding.captured("keyboardDidHide");
  hiding.render({ ...hiding.baseProps, visible: false }); hiding.settleLayout();
  const departing = viewport(hiding.tree);
  lateHide.forEach((callback) => callback({}));
  hiding.render(); hiding.settleLayout();
  assert.equal(viewport(hiding.tree), departing, "a terminal event must not move a departing dialog");
  assert.equal(hiding.subscriberCount(), 0, "closing must remove both will and terminal subscriptions");
  hiding.render(hiding.baseProps); hiding.settleLayout();
  assert.equal(viewport(hiding.tree), 360, "reopening during a native transition must read its current metrics");
  hiding.emit("keyboardDidHide", null);
  assert.equal(viewport(hiding.tree), 760, "terminal hide must also reconcile a reopened dialog");
  hiding.unmount();
  assert.equal(hiding.subscriberCount(), 0);
}

async function auditCrossFadeKeyboard(source: string): Promise<void> {
  for (const preference of [true, false]) {
    const initial = dialogFixture(source, "ios", true, 0);
    assert.equal(viewport(initial.render(initial.baseProps)), 760,
      "an unresolved initial iOS zero frame must not collapse the first tree");
    initial.settleLayout();
    assert.equal(initial.preferenceCheckCount, 1);
    await initial.resolveCrossFade(0, preference);
    assert.equal(viewport(initial.tree), preference ? 760 : 0,
      "the resolved cross-fade preference must distinguish the iOS zero-frame contract");
    initial.unmount();
  }
  const ordinary = dialogFixture(source, "ios");
  ordinary.render(ordinary.baseProps); ordinary.settleLayout();
  ordinary.emit("keyboardWillChangeFrame", 350);
  assert.equal(viewport(ordinary.tree), 350);
  assert.equal(ordinary.preferenceCheckCount, 0, "ordinary frames must not query accessibility preferences");
  ordinary.emit("keyboardWillChangeFrame", 0);
  assert.equal(viewport(ordinary.tree), 350, "a pending preference must retain the last resolved frame");
  ordinary.emit("keyboardWillChangeFrame", 390);
  await ordinary.resolveCrossFade(0, false);
  assert.equal(viewport(ordinary.tree), 390, "a newer keyboard frame must invalidate a pending preference");
  ordinary.emit("keyboardWillChangeFrame", 0);
  ordinary.emit("keyboardWillChangeFrame", 0);
  await ordinary.resolveCrossFade(2, true);
  await ordinary.resolveCrossFade(1, false);
  assert.equal(viewport(ordinary.tree), 760, "the latest preference request must win over an older resolution");
  ordinary.emit("keyboardWillChangeFrame", 0);
  ordinary.emit("keyboardWillHide", null);
  await ordinary.resolveCrossFade(3, false);
  assert.equal(viewport(ordinary.tree), 760, "a hide event must invalidate the pending zero frame");
  ordinary.emit("keyboardWillChangeFrame", 0);
  ordinary.emit("keyboardDidHide", null);
  await ordinary.resolveCrossFade(4, false);
  assert.equal(viewport(ordinary.tree), 760, "a terminal hide must invalidate the pending zero frame");
  ordinary.emit("keyboardWillChangeFrame", 0);
  ordinary.render({ ...ordinary.baseProps, visible: false }); ordinary.settleLayout();
  const writesAtClose = ordinary.stateWrites;
  await ordinary.resolveCrossFade(5, false);
  assert.equal(ordinary.stateWrites, writesAtClose, "closing must revoke a pending preference result");
  ordinary.render(ordinary.baseProps); ordinary.settleLayout();
  const oldShow = ordinary.captured("keyboardWillChangeFrame");
  ordinary.render({ ...ordinary.baseProps, visible: false }); ordinary.settleLayout();
  ordinary.render(ordinary.baseProps); ordinary.settleLayout();
  ordinary.emit("keyboardWillChangeFrame", 320);
  const requestsBeforeLateEvent = ordinary.preferenceCheckCount;
  oldShow.forEach((callback) => callback({ endCoordinates: { screenY: 0 } }));
  ordinary.render(); ordinary.settleLayout();
  assert.equal(ordinary.preferenceCheckCount, requestsBeforeLateEvent, "a retired listener must not start a new preference request after reopen");
  assert.equal(viewport(ordinary.tree), 320);
  ordinary.emit("keyboardWillChangeFrame", 0);
  const lastRequest = ordinary.preferenceCheckCount - 1;
  ordinary.unmount();
  const writesAtUnmount = ordinary.stateWrites;
  await ordinary.resolveCrossFade(lastRequest, false);
  assert.equal(ordinary.stateWrites, writesAtUnmount, "unmount must revoke a pending preference result");
  assert.equal(ordinary.subscriberCount(), 0);

  const failed = dialogFixture(source, "ios", true, 0);
  failed.render(failed.baseProps); failed.settleLayout();
  await failed.rejectCrossFade(0);
  assert.equal(viewport(failed.tree), 0, "a rejected preference read must retain the reported native frame");
  failed.unmount();

  const dismissed = dialogFixture(source, "ios", true, 0);
  dismissed.render(dismissed.baseProps); dismissed.settleLayout();
  dismissed.render({ ...dismissed.baseProps, visible: false }); dismissed.settleLayout();
  dismissed.physicalDismiss();
  assert.equal(viewport(dismissed.render(dismissed.baseProps)), 760,
    "a zero-frame dismissal snapshot must not collapse the first reopened tree");
  dismissed.settleLayout();
  await dismissed.resolveCrossFade(0, false);
  assert.equal(viewport(dismissed.tree), 760, "the dismissed session must not resolve into the reopened session");
  await dismissed.resolveCrossFade(1, true);
  dismissed.unmount();

  const android = dialogFixture(source, "android");
  android.render(android.baseProps); android.settleLayout();
  android.emit("keyboardDidShow", 0);
  assert.equal(viewport(android.tree), 0, "a real Android zero frame must not use the iOS cross-fade exception");
  assert.equal(android.preferenceCheckCount, 0);
  assert.equal(android.subscriberCount(), 2);
  android.unmount();
}

function auditNativeAppearance(source: string): void {
  const web = loadModule(source, {
    react: {}, "react-native": { Appearance: {
      getColorScheme: () => "light",
      addChangeListener: () => ({ remove() {} }),
    } },
  });
  assert.doesNotThrow(() => web.applyNativeColorPreference("dark"),
    "a platform without a native appearance setter must keep rendering its app theme");
  let system = "light";
  let override: string | null = null;
  const callbacks = new Set<(event: { colorScheme: string }) => void>();
  const pending: (() => void)[] = [];
  const requests: (string | null)[] = [];
  const actual = () => override ?? system;
  const emit = () => callbacks.forEach((callback) => callback({ colorScheme: actual() }));
  const { getNativeColorMode, subscribeNativeColorMode, refreshNativeColorMode, applyNativeColorPreference } = loadModule(source, {
    react: {}, "react-native": { Appearance: {
      getColorScheme: actual,
      addChangeListener: (callback: (event: { colorScheme: string }) => void) => {
        callbacks.add(callback); return { remove: () => callbacks.delete(callback) };
      },
      setColorScheme: (next: string | null) => {
        requests.push(next);
        pending.push(() => { const before = actual(); override = next; if (actual() !== before) emit(); });
      },
    } },
  });
  const flush = () => {
    for (let count = 0; pending.length; count++) {
      assert.ok(count < 20, "native appearance work must settle without feedback");
      pending.shift()!();
    }
  };
  let first = 0;
  let second = 0;
  assert.equal(getNativeColorMode(), "light");
  const removeFirst = subscribeNativeColorMode(() => first++);
  const removeSecond = subscribeNativeColorMode(() => second++);
  assert.equal(callbacks.size, 1, "logical subscribers must share one native appearance subscription");
  applyNativeColorPreference("dark");
  assert.equal(getNativeColorMode(), "light", "a queued native setter is not a committed appearance snapshot");
  flush();
  assert.equal(getNativeColorMode(), "dark");
  assert.deepEqual([first, second], [1, 1]);
  assert.deepEqual(requests, ["dark"], "native events must not feed back into another preference application");
  system = "dark";
  applyNativeColorPreference("system");
  flush();
  assert.equal(override, null, "system preference must release the native override");
  assert.equal(getNativeColorMode(), "dark");
  assert.deepEqual([first, second], [1, 1], "releasing to the same actual mode needs no native event");
  system = "light"; emit();
  assert.equal(getNativeColorMode(), "light");
  system = "dark";
  refreshNativeColorMode();
  assert.equal(getNativeColorMode(), "dark", "foreground refresh must recover an omitted native event");
  system = "light";
  applyNativeColorPreference("light"); applyNativeColorPreference("dark"); applyNativeColorPreference("system");
  flush();
  assert.equal(override, null);
  assert.equal(actual(), "light");
  assert.equal(getNativeColorMode(), "light", "rapid preferences must finish at the latest queued native configuration");
  const eventCount = first;
  emit();
  assert.equal(first, eventCount, "an unchanged native configuration must not republish");
  removeFirst(); assert.equal(callbacks.size, 1, "a remaining logical subscriber must retain the native listener");
  removeSecond(); assert.equal(callbacks.size, 0);
  system = "dark";
  assert.equal(getNativeColorMode(), "dark", "a new unobserved session must read the current native snapshot");
}

function auditRootMeasurementLifetime(source: string): void {
  const fixture = dialogFixture(source, "android");
  let dismissed = 0;
  const props = { ...fixture.baseProps, onDismiss: () => dismissed++ };
  fixture.render(props); fixture.settleLayout();
  fixture.setFrame({ height: 340, screenY: 20 }); fixture.measure();
  assert.equal(viewport(fixture.tree), 340);
  fixture.render({ ...props, visible: false }); fixture.settleLayout();
  fixture.setFrame({ height: 760, screenY: 0 }); fixture.measure();
  assert.equal(viewport(fixture.tree), 340, "a hidden root expansion must not move a departing surface");
  fixture.physicalDismiss();
  assert.equal(dismissed, 1, "physical dismissal must forward the consumer callback once");
  assert.equal(viewport(fixture.render(props)), 760, "reopening after physical dismissal must not reuse the old shrunken root");
  fixture.settleLayout();

  fixture.deferMeasurements();
  const oldWindow = fixture.measure();
  fixture.setFrame({ height: 500, screenY: 16 }, { width: 680, height: 516 });
  fixture.render(); fixture.settleLayout();
  assert.equal(viewport(fixture.tree), 516, "an old window measurement must not constrain a new rotation before its layout arrives");
  const newWindow = fixture.measure();
  fixture.deliverMeasurement(newWindow, { height: 500, screenY: 16 });
  assert.equal(viewport(fixture.tree), 500);
  fixture.deliverMeasurement(oldWindow, { height: 340, screenY: 20 });
  assert.equal(viewport(fixture.tree), 500, "a late measurement from the same root must not overwrite its newer window result");

  const oldHost = fixture.measure();
  fixture.replaceRoot(); fixture.render(); fixture.settleLayout();
  fixture.deliverMeasurement(oldHost, { height: 290, screenY: 24 });
  assert.equal(viewport(fixture.tree), 500, "a replaced root must reject its predecessor's callback even before a new measurement");
  const currentHost = fixture.measure();
  fixture.deliverMeasurement(currentHost, { height: 490, screenY: 16 });
  assert.equal(viewport(fixture.tree), 490);
  for (const result of [
    { height: Number.NaN, screenY: 0 }, { height: 0, screenY: 0 },
    { height: -1, screenY: 0 }, { height: 300, screenY: Number.POSITIVE_INFINITY },
  ]) {
    fixture.deliverMeasurement(fixture.measure(), result);
    assert.equal(viewport(fixture.tree), 490, "an invalid native measurement must leave the last valid root frame intact");
  }
  fixture.unmount();
}

function auditChromePreferenceEffect(source: string): void {
  const tree = ts.createSourceFile("root.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "AppChromeBoundary");
  assert.ok(declaration);
  let preference = "system";
  let nativeMode = "light";
  let index = 0;
  const dependencies: unknown[][] = [];
  let pending: (() => void)[] = [];
  const requests: string[] = [];
  const createElement = (type: unknown, props: object | null, ...children: unknown[]) => ({ type, props: { ...props, children } });
  const boundary = runInNewContext(ts.transpileModule(`(${declaration.getText(tree)})`, {
    fileName: "root.tsx", compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText, {
    React: { createElement }, View: "View", StatusBar: "StatusBar", darkTheme, lightTheme,
    useSettingsStore: (selector: (state: object) => unknown) => selector({ theme: preference }),
    useNativeColorMode: () => nativeMode,
    applyNativeColorPreference: (mode: string) => requests.push(mode),
    setAndroidNavigationBarTheme() {},
    useLayoutEffect: (callback: () => void, next: unknown[]) => {
      const current = index++;
      const previous = dependencies[current];
      if (!previous || next.some((value, entry) => !Object.is(value, previous[entry]))) {
        dependencies[current] = next;
        pending.push(callback);
      }
    },
  });
  const render = () => {
    index = 0;
    pending = [];
    boundary({ children: null });
    pending.forEach((callback) => callback());
  };
  render();
  nativeMode = "dark"; render();
  nativeMode = "light"; render();
  assert.deepEqual(requests, ["system"], "configuration events must not reapply an unchanged native preference");
  preference = "dark"; render();
  nativeMode = "dark"; render();
  preference = "light"; render();
  preference = "system"; render();
  assert.deepEqual(requests, ["system", "dark", "light", "system"]);
}

async function main(): Promise<void> {
  for (const [height, origin, keyboard, expected] of [
    [720, 24, null, 720], [720, 24, 414, 390], [390, 24, 414, 390], [720, 24, 12, 0],
  ] as const) assert.equal(getDialogViewportHeight(height, origin, keyboard), expected);
  for (const [natural, available, expected] of [
    [418, 650, 176], [456, 430, 150], [456, 200, 64], [456, 0, 64],
  ] as const) assert.equal(getColorPaletteHeight(natural, available), expected);
  auditDialog(dialogSource);
  auditTerminalKeyboardEvents(dialogSource);
  await auditCrossFadeKeyboard(dialogSource);
  const webDialog = dialogFixture(dialogSource, "web");
  assert.equal(viewport(webDialog.render(webDialog.baseProps)), 760);
  webDialog.settleLayout();
  webDialog.render({ ...webDialog.baseProps, visible: false });
  webDialog.settleLayout();
  webDialog.physicalDismiss();
  webDialog.unmount();
  const requiredMetrics = dialogSource.replaceAll("Keyboard.metrics?.()", "Keyboard.metrics()");
  assert.notEqual(requiredMetrics, dialogSource);
  assert.throws(() => {
    const fixture = dialogFixture(requiredMetrics, "web");
    fixture.render(fixture.baseProps);
  }, { name: "TypeError", message: /metrics is not a function/ });
  auditRootMeasurementLifetime(dialogSource);
  auditNativeAppearance(nativeSource);
  auditColorSession(colorSource);
  for (const [source, target, replacement, audit, expectedFailure] of [
    [dialogSource, "rootFrame.windowHeight === windowHeight ? rootFrame.screenY : 0", "0", auditDialog, /screen coordinates must be translated/],
    [dialogSource, "if (!owner.active || !visibleRef.current) return;", "if (false) return;", auditDialog, /queued keyboard events must not move/],
    [nativeSource, 'theme === "system" ? null : theme', 'theme === "system" ? "dark" : theme', auditNativeAppearance, /system preference must release/],
    [nativeSource, 'if (listeners.size !== 0) return;', 'if (false) return;', auditNativeAppearance, /remaining logical subscriber must retain/],
    [colorSource, "height + 176 - paletteHeight", "height", auditColorSession, /keyboard-hide measurement must add back/],
    [dialogSource, "measurement !== rootMeasurementRef.current ||", "", auditRootMeasurementLifetime, /late measurement from the same root/],
    [dialogSource, "rootRef.current !== root ||", "", auditRootMeasurementLifetime, /replaced root must reject/],
    [dialogSource, "setRootFrame({ height: windowHeight, screenY: 0, windowHeight });", "void windowHeight;", auditRootMeasurementLifetime, /reopening after physical dismissal must not reuse/],
    [dialogSource, "rootFrame.windowHeight === windowHeight ? rootFrame.height : windowHeight", "rootFrame.height", auditRootMeasurementLifetime, /old window measurement must not constrain/],
    [dialogSource, "!Number.isFinite(height) || height <= 0 || !Number.isFinite(screenY)", "false", auditRootMeasurementLifetime, /invalid native measurement must leave/],
    [dialogSource, 'const terminalSubscriptions = Platform.OS === "ios" ? [', 'const terminalSubscriptions = false ? [', auditTerminalKeyboardEvents, /terminal hide must reconcile/],
  ] as const) {
    assert.ok(source.includes(target));
    assert.throws(() => audit(source.replace(target, replacement)), { name: "AssertionError", message: expectedFailure }, target);
  }
  const nullInitialKeyboard = dialogSource.replace(
    /const \[keyboardScreenY, setKeyboardScreenY\] = useState<number \| null>\([\s\S]*?\n  \);/,
    "const [keyboardScreenY, setKeyboardScreenY] = useState<number | null>(null);",
  );
  assert.notEqual(nullInitialKeyboard, dialogSource);
  assert.throws(() => auditDialog(nullInitialKeyboard), { name: "AssertionError", message: /already open keyboard must constrain/ });
  const passiveKeyboard = dialogSource.replace(
    /useLayoutEffect\(\(\) => \{\s*if \(!visible\) return;\s*const owner/,
    "React.useEffect(() => { if (!visible) return; const owner",
  );
  assert.notEqual(passiveKeyboard, dialogSource);
  assert.throws(() => auditKeyboardReopen(passiveKeyboard), { name: "AssertionError", message: /reopening must refresh keyboard metrics/ });
  const appRoot = readFileSync("app/_layout.tsx", "utf8");
  auditChromePreferenceEffect(appRoot);
  const derivedPreferenceEffect = appRoot.replace(
    /applyNativeColorPreference\(theme\);\s*\}, \[theme\]/,
    "applyNativeColorPreference(theme); }, [isDarkTheme]",
  );
  assert.notEqual(derivedPreferenceEffect, appRoot);
  assert.throws(() => auditChromePreferenceEffect(derivedPreferenceEffect), { name: "AssertionError", message: /configuration events must not reapply/ });
  assert.match(appRoot, /useLayoutEffect\(\(\) => \{\s*applyNativeColorPreference\(theme\);\s*\}, \[theme\]\)/,
    "native configuration events must not reapply the preference effect");
  for (const [target, replacement, expectedFailure] of [
    ['return Platform.OS === "ios" && screenY === 0 ? null : screenY;', 'return screenY;', /unresolved initial iOS zero frame/],
    ['if (Platform.OS !== "ios" || screenY !== 0)', 'if (screenY !== 0)', /real Android zero frame/],
    ['prefersCrossFade ? null : screenY', 'screenY', /resolved cross-fade preference must distinguish/],
    ['prefersCrossFade ? null : screenY', 'null', /resolved cross-fade preference must distinguish/],
    [' || owner.request !== request', '', /newer keyboard frame must invalidate/],
    ['owner.active = false;', 'owner.active = true;', /retired listener must not start/],
  ] as const) {
    assert.ok(dialogSource.includes(target));
    await assert.rejects(() => auditCrossFadeKeyboard(dialogSource.replace(target, replacement)),
      { name: "AssertionError", message: expectedFailure }, target);
  }
  console.log("UI dialogs audit passed: keyboard lifecycle, root measurement lifetime, color sessions, native appearance and twenty-one mutations.");
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
