import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

type Tag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
interface Sources { wrapper?: string; route?: string }
const wrapperPath = "src/platform/note-editor-viewport.tsx";
const routePath = "app/habit/[id]/notes.tsx";

export function assertNoteEditorViewportLayout(source: string): void {
  const tree = ts.createSourceFile("notes.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tags = new Map<string, Tag[]>();
  const initializers = new Map<string, ts.Expression[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(tree);
      tags.set(name, [...(tags.get(name) ?? []), node]);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const name = node.name.getText(tree);
      initializers.set(name, [...(initializers.get(name) ?? []), node.initializer]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const tag = (name: string): Tag => {
    const matches = tags.get(name) ?? [];
    assert.equal(matches.length, 1, `the Notes route must retain one ${name}`);
    return matches[0];
  };
  const attribute = (node: Tag, name: string): ts.Expression => {
    assert.ok(node.attributes.properties.every(ts.isJsxAttribute), "layout props must not hide a later override in a spread");
    const matches = node.attributes.properties.filter((item): item is ts.JsxAttribute =>
      ts.isJsxAttribute(item) && item.name.getText(tree) === name);
    assert.equal(matches.length, 1, `the layout must own one ${name} prop`);
    const value = matches[0].initializer;
    assert.ok(value && ts.isJsxExpression(value) && value.expression, `${name} must be an explicit expression`);
    return value.expression;
  };
  const styleFields = (node: Tag): Map<string, string> => {
    const value = attribute(node, "style");
    assert.ok(ts.isObjectLiteralExpression(value), "fixed layout owners must expose primitive style objects");
    const fields = new Map<string, string>();
    for (const field of value.properties) {
      assert.ok(ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field));
      const name = field.name.getText(tree);
      assert.ok(!fields.has(name), `duplicate style field: ${name}`);
      fields.set(name, ts.isPropertyAssignment(field) ? field.initializer.getText(tree) : name);
    }
    return fields;
  };
  const evaluate = (value: ts.Expression, environment: Record<string, unknown>) =>
    new Function(...Object.keys(environment), `return (${value.getText(tree)});`)(...Object.values(environment));
  const root = tag("KeyboardAvoidingView");
  const viewport = tag("NoteEditorViewport");
  const list = tag("FlatList");
  assert.equal(styleFields(root).has("paddingBottom"), false,
    "the screen root must not duplicate the editor viewport keyboard inset");
  const viewportStyle = styleFields(viewport);
  assert.deepEqual([...viewportStyle.keys()].sort(), ["flex", "overflow", "paddingBottom"]);
  assert.equal(viewportStyle.get("flex"), "1");
  assert.equal(viewportStyle.get("paddingBottom"), "editorBottomPadding",
    "the measured editor lift and uncovered safe area must belong to the list viewport");
  assert.equal(viewportStyle.get("overflow"), '"hidden"', "the viewport must clip the extended editor painting once");
  let parent: ts.Node | undefined = list.parent;
  while (parent && parent !== viewport.parent) parent = parent.parent;
  assert.equal(parent, viewport.parent, "the list must be inside the editor viewport");
  for (const platform of ["android", "ios", "web"]) {
    assert.equal(evaluate(attribute(root, "behavior"), { Platform: { OS: platform } }),
      platform === "ios" ? "padding" : undefined, "iOS must retain its sole KeyboardAvoidingView padding owner");
  }
  const painting = initializers.get("extendEditorPainting") ?? [];
  assert.equal(painting.length, 1, "the route must define one editor painting mode");
  const lift = initializers.get("editorKeyboardLift") ?? [];
  assert.equal(lift.length, 1, "the route must define one manual editor lift");
  const bottomPadding = initializers.get("editorBottomPadding") ?? [];
  assert.equal(bottomPadding.length, 1, "the route must define one editor bottom padding");
  for (const platform of ["android", "ios", "web"]) {
    for (const editing of [false, true]) {
      const enabled = evaluate(painting[0], { Platform: { OS: platform }, editingNoteIds: new Set(editing ? [1] : []) });
      assert.equal(enabled, platform === "android" && editing,
        "extended painting must be limited to Android card editing");
      assert.equal(evaluate(lift[0], {
        Platform: { OS: platform }, editingNoteIds: new Set(editing ? [1] : []), viewportKeyboardLift: 96,
      }), enabled ? 96 : 0, "manual editor padding must not duplicate iOS padding or affect the composer mode");
      for (const releasePending of [false, true]) {
        for (const keyboardVisible of [false, true]) {
          for (const bottomInset of [0, 16, 24, 48]) {
            const hideComposer = editing || releasePending;
            const manualLift: number = enabled && keyboardVisible ? 96 : 0;
            const actual = evaluate(bottomPadding[0], {
              editorKeyboardLift: manualLift, hideComposer, keyboardVisible,
              insets: { bottom: bottomInset },
            });
            const expected: number = manualLift + (hideComposer && !keyboardVisible ? bottomInset : 0);
            assert.equal(actual, expected,
              "hidden composer must transfer its safe area to the list only while the keyboard is hidden");
          }
        }
      }
      const style = evaluate(attribute(list, "style"), { extendEditorPainting: enabled });
      assert.equal(style?.overflow, enabled ? "visible" : undefined);
      assert.equal(evaluate(attribute(list, "removeClippedSubviews"), { extendEditorPainting: enabled }), enabled ? false : undefined,
        "only an extended Android editor may disable native child clipping");
    }
  }
}

function auditNativeOwner(route: string): void {
  const activeEditorGeometryRef = { current: null as { requestId: number } | null };
  const keyboardTopRef = Object.defineProperty({}, "current", { get() {
    assert.fail("a native viewport must not start the JS keyboard geometry owner");
  } });
  const execute = loadSourceCallableForAudit<(entry: unknown) => void>(route, "scheduleEditorGeometry", {
    activeEditorSaveRef: { current: { noteId: 7 } }, activeEditorGeometryRef,
    hasNativeNoteEditorViewport: true, keyboardTopRef,
  });
  execute({ requestId: 1, targets: { noteId: 7 } });
  assert.equal(activeEditorGeometryRef.current?.requestId, 1,
    "the native owner must retain the latest physical geometry identity before yielding");
  execute({ requestId: 2, targets: { noteId: 7 } });
  assert.equal(activeEditorGeometryRef.current?.requestId, 2);
  execute({ requestId: 3, targets: { noteId: 8 } });
  assert.equal(activeEditorGeometryRef.current?.requestId, 2, "an inactive editor must not replace the current native identity");
}

export function auditNoteEditorViewport(sources: Sources = {}): void {
  const wrapper = sources.wrapper ?? readFileSync(wrapperPath, "utf8");
  const route = sources.route ?? readFileSync(routePath, "utf8");
  const compiled = ts.transpileModule(wrapper, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  for (const platform of ["android", "ios", "web"]) {
    for (const capability of [null, {}, { supportsViewport: false }, { supportsViewport: "true" }, { supportsViewport: true }] as ({ supportsViewport?: unknown } | null)[]) {
      let optionalLoads = 0, viewLoads = 0;
      const fallback = () => {};
      const nativeHost = () => {};
      const module = { exports: {} as { hasNativeNoteEditorViewport: boolean; NoteEditorViewport: unknown } };
      runInNewContext(compiled, { module, exports: module.exports, require(name: string) {
        if (name === "react-native") return { Platform: { OS: platform }, View: fallback };
        assert.equal(name, "expo");
        return {
          requireOptionalNativeModule(name: string) { assert.equal(name, "NoteEditorMetrics"); optionalLoads++; return capability; },
          requireNativeView(name: string) { assert.equal(name, "NoteEditorMetrics"); viewLoads++; return nativeHost; },
        };
      } });
      const expected = platform === "android" && capability?.supportsViewport === true;
      assert.equal(module.exports.hasNativeNoteEditorViewport, expected,
        "Android must enable the native viewport only with explicit capability; web and iOS must retain the fallback");
      assert.equal(module.exports.NoteEditorViewport, expected ? nativeHost : fallback,
        "the platform wrapper must expose the actual selected host without another layout layer");
      assert.equal(optionalLoads, platform === "android" ? 1 : 0, "non-Android platforms must not load the viewport module");
      assert.equal(viewLoads, expected ? 1 : 0, "an unavailable viewport must not require a native host");
    }
  }
  assertNoteEditorViewportLayout(route);
  auditNativeOwner(route);
}

export function auditNoteEditorViewportMutations(): number {
  const wrapper = readFileSync(wrapperPath, "utf8").replace(/\r\n/g, "\n");
  const route = readFileSync(routePath, "utf8").replace(/\r\n/g, "\n");
  const replace = (value: string, before: string, after: string) => {
    assert.equal(value.split(before).length, 2, "each viewport mutation must select one source region");
    return value.replace(before, after);
  };
  auditNoteEditorViewport({ wrapper, route });
  const trials: { wrapper?: string; route?: string; expected: string }[] = [
    { route: replace(route, "hideComposer && !keyboardVisible ? insets.bottom : 0", "false ? insets.bottom : 0"), expected: "transfer its safe area" },
    { route: replace(route, "hideComposer && !keyboardVisible ? insets.bottom : 0", "hideComposer ? insets.bottom : 0"), expected: "transfer its safe area" },
    { route: replace(route, "hideComposer && !keyboardVisible ? insets.bottom : 0", "!keyboardVisible ? insets.bottom : 0"), expected: "transfer its safe area" },
    { route: replace(route, "hideComposer && !keyboardVisible ? insets.bottom : 0", "hideComposer && !keyboardVisible ? 12 : 0"), expected: "transfer its safe area" },
    { wrapper: replace(wrapper, 'Platform.OS === "android"', "true"), expected: "non-Android platforms must not load the viewport module" },
    { wrapper: replace(wrapper, "nativeMetrics?.supportsViewport === true", "nativeMetrics !== null"), expected: "only with explicit capability" },
    { route: replace(route, "      if (hasNativeNoteEditorViewport) return;", ""), expected: "a native viewport must not start the JS keyboard geometry owner" },
    { route: replace(route, "      activeEditorGeometryRef.current = entry;\n      if (hasNativeNoteEditorViewport) return;", "      if (hasNativeNoteEditorViewport) return;\n      activeEditorGeometryRef.current = entry;"), expected: "retain the latest physical geometry identity" },
  ];
  for (const trial of trials) {
    assert.throws(() => auditNoteEditorViewport({ wrapper: trial.wrapper ?? wrapper, route: trial.route ?? route }),
      (error: unknown) => error instanceof assert.AssertionError && error.message.includes(trial.expected),
      `the viewport mutation must violate its intended behavior: ${trial.expected}`);
  }
  return trials.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  auditNoteEditorViewport();
  const mutations = process.argv.includes("--mutations") ? auditNoteEditorViewportMutations() : 0;
  console.log(`Note editor viewport audit passed.${mutations ? ` ${mutations} targeted mutations detected.` : ""}`);
}
