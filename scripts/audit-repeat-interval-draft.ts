import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { normalizeIntervalDraft } from "../src/features/habit-form/utils/repeat-interval";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

const original = readFileSync(
  "src/features/habit-form/components/RepeatIntervalTab.tsx",
  "utf8",
);

function auditDraft(source: string): void {
  for (const [input, expected] of [
    ["17", "17"],
    ["", "2"],
    ["x0", "2"],
    ["366", "365"],
    ["9x4", "94"],
  ]) {
    const changes: string[] = [];
    const normalizedValueRef = { current: 2 };
    const environment = {
      value: "2",
      normalizedValue: 2,
      normalizedValueRef,
      normalizeIntervalDraft,
      onChange: (value: string) => changes.push(value),
    };
    const change = loadSourceCallableForAudit<(text: string) => void>(
      source,
      "handleTextChange",
      environment,
    );
    const blur = loadSourceCallableForAudit<() => void>(
      source,
      "handleTextBlur",
      environment,
    );
    change(input);
    blur();
    assert.equal(
      changes.at(-1),
      expected,
      "blur must normalize the latest native change before a React render",
    );
  }
  const values: string[] = [];
  const normalizedValueRef = { current: 2 };
  const environment = {
    MIN_INTERVAL: 2,
    MAX_INTERVAL: 365,
    value: "2",
    normalizedValue: 2,
    normalizedValueRef,
    onChange: (value: string) => values.push(value),
  };
  const increment = loadSourceCallableForAudit<() => void>(
    source,
    "increment",
    environment,
  );
  const decrement = loadSourceCallableForAudit<() => void>(
    source,
    "decrement",
    environment,
  );
  const blur = loadSourceCallableForAudit<() => void>(
    source,
    "handleTextBlur",
    environment,
  );
  increment();
  increment();
  blur();
  assert.deepEqual(values, ["3", "4", "4"]);
  decrement();
  blur();
  assert.equal(values.at(-1), "3");
  normalizedValueRef.current = 365;
  increment();
  blur();
  assert.equal(values.at(-1), "365");
  normalizedValueRef.current = 2;
  const count = values.length;
  decrement();
  assert.equal(
    values.length,
    count,
    "the lower-bound step must remain a no-op",
  );
}

auditDraft(original);
const staleBlur = original.replace(
  "String(normalizedValueRef.current)",
  "String(normalizedValue)",
);
assert.notEqual(staleBlur, original);
assert.throws(() => auditDraft(staleBlur), { name: "AssertionError" });

interface DraftElement {
  type: unknown;
  props: Record<string, unknown>;
}

function auditComponentLifetime(source: string): void {
  const refs: { current: unknown }[] = [];
  let refIndex = 0;
  let effectIndex = 0;
  const committedDependencies: (readonly unknown[])[] = [];
  let pendingEffects: {
    index: number;
    effect: () => void;
    dependencies: readonly unknown[];
  }[] = [];
  const changes: string[] = [];
  const react = {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): DraftElement => ({
      type,
      props: { ...props, children },
    }),
    useRef: <T>(initial: T) =>
      refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    useLayoutEffect: (effect: () => void, dependencies: readonly unknown[]) => {
      pendingEffects.push({ index: effectIndex++, effect, dependencies });
    },
  };
  const noop = () => {};
  // This fixture owns the element factory; styling integration is checked separately.
  const compiled = ts.transpileModule(
    source.replace(/^\/\*\* @jsxImportSource nativewind \*\/\r?\n/, ""),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const isolated = {
    exports: {} as {
      RepeatIntervalTab: (props: Record<string, unknown>) => DraftElement;
    },
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (name === "react") return react;
      if (name === "react-native")
        return {
          View: "View",
          Text: "Text",
          Pressable: "Pressable",
          TextInput: "TextInput",
        };
      if (name === "@expo/vector-icons/MaterialIcons") return "MaterialIcons";
      if (name === "react-i18next")
        return { useTranslation: () => ({ t: (key: string) => key }) };
      if (name === "@/theme/colors")
        return {
          getAccentScheme: () => ({ base: "#123456" }),
          darkTheme: { divider: "#333333", disabled: "#777777" },
          lightTheme: { divider: "#CCCCCC", disabled: "#888888" },
        };
      if (name === "@/components/ScreenPreferencesBoundary")
        return {
          useVisualColorScheme: () => "orange",
          useVisualLanguage: () => "en",
          useVisualEffectiveMode: () => "light",
        };
      if (name === "@/theme/tokens")
        return { sizes: { stepperButton: 44, rowHeight: 56 } };
      if (name === "@/components/ui/Toggle") return { Toggle: "Toggle" };
      if (name === "@/features/habit-form/utils/repeat-interval")
        return { normalizeIntervalDraft };
      if (name === "@/features/habits/presentation/repeat-labels")
        return { getEveryNDaysLabel: () => "interval" };
      throw new Error(`Unexpected interval fixture import: ${name}`);
    },
    isolated,
    isolated.exports,
  );
  const render = (value: string, committed: boolean): DraftElement => {
    refIndex = 0;
    effectIndex = 0;
    pendingEffects = [];
    const result = isolated.exports.RepeatIntervalTab({
      value,
      onChange: (next: string) => {
        changes.push(next);
      },
      fromCompletion: false,
      onFromCompletionChange: noop,
    });
    if (committed) {
      for (const { index, effect, dependencies } of pendingEffects) {
        const previous = committedDependencies[index];
        if (
          !previous ||
          previous.length !== dependencies.length ||
          dependencies.some(
            (value, entry) => !Object.is(value, previous[entry]),
          )
        ) {
          effect();
        }
        committedDependencies[index] = dependencies;
      }
    }
    return result;
  };
  const find = (
    node: unknown,
    predicate: (element: DraftElement) => boolean,
  ): DraftElement | null => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = find(child, predicate);
        if (found) return found;
      }
    } else if (
      node != null &&
      typeof node === "object" &&
      "type" in node &&
      "props" in node
    ) {
      const element = node as DraftElement;
      return predicate(element)
        ? element
        : find(element.props.children, predicate);
    }
    return null;
  };
  const initial = render("2", true);
  const input = find(initial, (element) => element.type === "TextInput")!;
  const increase = find(
    initial,
    (element) => element.props.accessibilityLabel === "repeat.increaseInterval",
  )!;
  const decrease = find(
    initial,
    (element) => element.props.accessibilityLabel === "repeat.decreaseInterval",
  )!;
  const change = input.props.onChange as (event: unknown) => void;
  const blur = input.props.onBlur as (event: unknown) => void;
  change({ nativeEvent: { text: "17" }, timeStamp: 10 });
  render("99", false);
  blur({ timeStamp: 11 });
  assert.equal(
    changes.at(-1),
    "17",
    "a discarded render must not overwrite the current native draft",
  );
  const beforeSteps = changes.length;
  (increase.props.onPress as () => void)();
  (increase.props.onPress as () => void)();
  (decrease.props.onPress as () => void)();
  blur({ timeStamp: 12 });
  assert.deepEqual(
    changes.slice(beforeSteps),
    ["18", "19", "18", "18"],
    "rapid native/step/blur callbacks must retain one synchronous latest draft",
  );
  render("23", true);
  blur({ timeStamp: 13 });
  assert.equal(
    changes.at(-1),
    "23",
    "a committed external value must replace the prior draft before the next event",
  );
  render("23", false);
  change({ nativeEvent: { text: "365" }, timeStamp: 14 });
  const beforeUpperBound = changes.length;
  (increase.props.onPress as () => void)();
  assert.equal(changes.length, beforeUpperBound);
  blur({ timeStamp: 15 });
  assert.equal(changes.at(-1), "365");
  render("2", true);
  const beforeLowerBound = changes.length;
  (decrease.props.onPress as () => void)();
  assert.equal(changes.length, beforeLowerBound);
}

auditComponentLifetime(original);
for (const [target, replacement] of [
  [
    /React\.useLayoutEffect\(\(\) => \{\s*normalizedValueRef\.current = normalizedValue;/g,
    "normalizedValueRef.current = normalizedValue;\n React.useLayoutEffect(() => {",
  ],
  [/normalizedValueRef\.current = normalizedValue;/g, "void normalizedValue;"],
] as const) {
  assert.equal(
    original.match(target)?.length,
    1,
    "interval mutation must identify one publication site",
  );
  assert.throws(
    () => auditComponentLifetime(original.replace(target, replacement)),
    (error: unknown) => error instanceof assert.AssertionError,
    "interval publication mutations must fail executed component lifetime assertions",
  );
}
console.log(
  "Repeat interval draft audit passed: native/step/blur ordering, committed publication, bounds, and three mutations.",
);
