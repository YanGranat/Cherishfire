import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import {
  getAccentScheme,
  getThemeVars,
  lightTheme,
  darkTheme,
  semantic,
  settingsScreenBackgrounds,
} from "../src/theme/colors";
import { BUILTIN_COLOR_SCHEMES, type ColorScheme } from "../src/types/settings";
import { sizes, zIndex } from "../src/theme/tokens";

interface Element {
  type: unknown;
  props: Record<string, unknown>;
}

function loadSource<T>(
  file: string,
  mocks: Record<string, unknown>,
  transform: (source: string) => string = (source) => source,
): T {
  const filename = resolve(file);
  const source = transform(readFileSync(filename, "utf8")).replace(
    /^\/\*\* @jsxImportSource nativewind \*\/\r?\n/,
    "",
  );
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const require = createRequire(filename);
  new Function("require", "module", "exports", compiled)(
    (id: string) => (Object.hasOwn(mocks, id) ? mocks[id] : require(id)),
    module,
    module.exports,
  );
  return module.exports as T;
}

const react = {
  useMemo: <T>(create: () => T) => create(),
  createElement: (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): Element => ({
    type,
    props: {
      ...props,
      children: children.length === 1 ? children[0] : children,
    },
  }),
};

interface ProviderModule {
  prewarmThemeVariables(): void;
  ThemeProvider(props: {
    effectiveMode: "light" | "dark";
    colorScheme?: ColorScheme;
    children: unknown;
  }): Element;
  ThemeVariablesProvider(props: {
    effectiveMode: "light" | "dark";
    colorScheme?: ColorScheme;
    children: unknown;
  }): Element;
}

function auditVariableOwnership(transform?: (source: string) => string): void {
  const variableCalls: Record<string, string>[] = [];
  const absoluteFillObject = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  };
  const provider = loadSource<ProviderModule>(
    "src/theme/provider.tsx",
    {
      react,
      "react-native": { View: "View", StyleSheet: { absoluteFillObject } },
      nativewind: {
        vars: (variables: Record<string, string>) => {
          variableCalls.push(variables);
          return { variables };
        },
      },
      "./colors": { getThemeVars },
    },
    transform,
  );
  provider.prewarmThemeVariables();
  assert.equal(
    variableCalls.length,
    2,
    "prewarm must allocate exactly the light and dark variable sets",
  );
  const byMode = new Map<string, unknown>();
  for (const effectiveMode of ["light", "dark", "light", "dark"] as const) {
    for (const colorScheme of [
      ...BUILTIN_COLOR_SCHEMES,
      "#123456",
      "#FFFFFF",
      "#000000",
    ] as ColorScheme[]) {
      const scene = provider.ThemeProvider({
        effectiveMode,
        colorScheme,
        children: "scene",
      });
      const portal = provider.ThemeVariablesProvider({
        effectiveMode,
        colorScheme,
        children: "dialog",
      });
      const [fill, variables] = scene.props.style as unknown[];
      const [portalFill, portalVariables] = portal.props.style as unknown[];
      assert.deepEqual(fill, { flex: 1 });
      assert.equal(scene.props.className, "bg-background");
      assert.equal(scene.props.children, "scene");
      assert.equal(portal.props.children, "dialog");
      assert.equal(portalFill, absoluteFillObject);
      assert.equal(
        portal.props.className,
        undefined,
        "portal variables must not add an opaque background",
      );
      assert.equal(
        variables,
        portalVariables,
        "scene and detached portal must share the effective-mode variables",
      );
      if (!byMode.has(effectiveMode)) byMode.set(effectiveMode, variables);
      assert.equal(
        variables,
        byMode.get(effectiveMode),
        "changing an accent must not replace inherited theme variables",
      );
    }
  }
  assert.equal(
    variableCalls.length,
    2,
    "palette selection must not allocate additional CSS-variable owners",
  );
  assert.notEqual(byMode.get("light"), byMode.get("dark"));
}

function auditThemeValues(): void {
  const rgb = (hex: string) =>
    [1, 3, 5]
      .map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
      .join(" ");
  for (const mode of ["light", "dark"] as const) {
    const theme = mode === "light" ? lightTheme : darkTheme;
    assert.deepEqual(
      getThemeVars(mode),
      {
        "--color-background": rgb(theme.background),
        "--color-surface": rgb(theme.surface),
        "--color-surface-elevated": rgb(theme.surfaceElevated),
        "--color-border": rgb(theme.border),
        "--color-muted": rgb(theme.muted),
        "--color-primary": rgb(theme.primary),
        "--color-divider": rgb(theme.divider),
        "--color-destructive": rgb(semantic.failure),
        "--color-press-highlight": rgb(theme.pressHighlight),
      },
      "the CSS theme must preserve every effective-mode color",
    );
  }
}

function auditGroupedSurfaceColors(): void {
  assert.equal(lightTheme.background, "#F2F2F2");
  assert.equal(lightTheme.surface, "#FFFFFF");
  assert.equal(lightTheme.surfaceElevated, "#FFFFFF");
  assert.equal(lightTheme.menuSurface, "#FFFFFF");
  assert.deepEqual(
    darkTheme,
    {
      background: "#2C2C2C",
      surface: "#2C2C2C",
      surfaceElevated: "#333333",
      menuSurface: "#0F0F0F",
      divider: "#474747",
      border: "#3A3A3A",
      disabled: "#616161",
      muted: "#9E9E9E",
      primary: "#E8E7E7",
      icon: "#E8E7E7",
      metric: "#E8E7E7",
      onSurface: "#E8E7E7",
      pressHighlight: "#333333",
      menuHighlight: "#3A3A3A",
      neutral: "#616161",
      unmarkedPast: "#616161",
    },
    "grouped light surfaces must not change the dark palette",
  );

  for (const [file, binding, light, dark] of [
    [
      "app/create.tsx",
      "rowBackgroundColor",
      lightTheme.background,
      darkTheme.background,
    ],
    [
      "src/features/notes/components/NoteCard.tsx",
      "cardBackgroundColor",
      lightTheme.surfaceElevated,
      "#1B1B1B",
    ],
    [
      "src/features/archive/components/ArchiveCard.tsx",
      "cardBackgroundColor",
      lightTheme.surfaceElevated,
      "#1B1B1B",
    ],
    [
      "src/features/notes/components/NoteInput.tsx",
      "composerBackground",
      lightTheme.surface,
      "#1B1B1B",
    ],
  ] as const) {
    const tree = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const expressions: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === binding &&
        node.initializer
      ) {
        expressions.push(node.initializer.getText(tree));
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(
      expressions.length,
      1,
      `${file} must have one ${binding} owner`,
    );
    const evaluate = new Function(
      "isDark",
      "isDarkTheme",
      "lightTheme",
      "darkTheme",
      "palette",
      `return (${expressions[0]});`,
    );
    for (const isDark of [false, true]) {
      assert.equal(
        evaluate(
          isDark,
          isDark,
          lightTheme,
          darkTheme,
          isDark ? darkTheme : lightTheme,
        ),
        isDark ? dark : light,
      );
    }
  }

  for (const file of [
    "app/settings/theme.tsx",
    "app/settings/language.tsx",
    "app/settings/color-scheme.tsx",
  ]) {
    const tree = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const rowClasses: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(tree) === "className" &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      ) {
        if (node.initializer.text.includes("active:bg-press-highlight"))
          rowClasses.push(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(
      rowClasses.length,
      1,
      `${file} must expose one selection-row style`,
    );
    assert.ok(
      !rowClasses[0].split(/\s+/).includes("bg-surface"),
      "preference rows must inherit the flat scene backdrop",
    );
  }

  for (const mode of ["light", "dark"] as const) {
    const { ArchiveCard } = loadSource<{
      ArchiveCard(props: Record<string, unknown>): Element;
    }>("src/features/archive/components/ArchiveCard.tsx", {
      react: {
        ...react,
        memo: (component: unknown) => component,
        useRef: (initial: unknown) => ({ current: initial }),
        useState: (initial: unknown) => [initial, () => undefined],
      },
      "react-native": {
        View: "View", Text: "Text", Pressable: "Pressable",
        useWindowDimensions: () => ({ fontScale: 1 }),
      },
      "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
      "@expo/vector-icons/MaterialIcons": "MaterialIcons",
      "@/components/ScreenPreferencesBoundary": {
        useVisualLanguage: () => "en",
        useVisualEffectiveMode: () => mode,
      },
      "@/utils/date": { formatLocalizedDate: () => "" },
      "@/theme/tokens": { radii: { listCard: 10 } },
      "@/theme/colors": { lightTheme },
    });
    const root = ArchiveCard({
      habit: { id: 1, name: "Routine", archiveHistory: [], archivedAt: null },
      isInteractionBlocked: () => false,
    });
    const action = root.props.children as Element;
    const card = action.props.children as Element;
    assert.deepEqual(card.props.style, {
      backgroundColor: mode === "light" ? "#FFFFFF" : "#1B1B1B",
      borderRadius: 10,
    });
    assert.deepEqual(root.props.style, {
      paddingHorizontal: 11,
      marginBottom: 11.5,
    });
  }
}

function auditSettingsSceneSurfaces(
  transform: (file: string, source: string) => string = (_file, source) =>
    source,
): void {
  assert.deepEqual(settingsScreenBackgrounds, {
    light: "#FAFAFA",
    dark: "#2C2C2C",
  });
  for (const mode of ["light", "dark"] as const) {
    const expected = mode === "light" ? "#FAFAFA" : "#2C2C2C";
    const { SettingsScreenShell } = loadSource<{
      SettingsScreenShell(props: Record<string, unknown>): Element;
    }>(
      "src/features/settings/components/SettingsScreenShell.tsx",
      {
        react,
        "expo-router": { useRouter: () => ({ back: () => undefined }) },
        "@/components/layout/Header": { Header: "Header" },
        "@/components/layout/ScreenWrapper": { ScreenWrapper: "ScreenWrapper" },
        "@/components/ScreenPreferencesBoundary": {
          useVisualEffectiveMode: () => mode,
        },
        "@/theme/colors": { settingsScreenBackgrounds },
      },
      (source) => transform("shell", source),
    );
    for (const scrollableBody of [true, false]) {
      const scene = SettingsScreenShell({
        title: "Preferences",
        scrollableBody,
        children: "body",
      });
      assert.equal(
        scene.props.backgroundColor,
        expected,
        "Settings outer canvas must stay flat",
      );
      assert.equal(scene.props.padBottom, false);
      const children = scene.props.children as Element[];
      assert.equal(children[0].type, "Header");
      assert.equal(
        children[0].props.backgroundColor,
        expected,
        "Settings header must match its backdrop",
      );
      assert.equal(children[0].props.centerTitle, true);
      if (scrollableBody) {
        assert.equal(children[1].type, "ScreenWrapper");
        assert.equal(children[1].props.scrollable, true);
        assert.equal(
          children[1].props.backgroundColor,
          expected,
          "Settings scroll body must match its backdrop",
        );
      } else assert.equal(children[1], "body");
    }
    const { SettingsNavigator } = loadSource<{ SettingsNavigator(): Element }>(
      "app/settings/_layout.tsx",
      {
        react: {
          ...react,
          useCallback: (callback: unknown) => callback,
          useEffect: () => undefined,
          useRef: (value: unknown) => ({ current: value }),
        },
        "react-native": {
          View: "View",
          Easing: { linear: "linear" },
          useWindowDimensions: () => ({ width: 360 }),
        },
        "@react-navigation/stack": {
          createStackNavigator: () => ({ Navigator: "Navigator" }),
        },
        "expo-router": { withLayoutContext: () => "SettingsStack" },
        "@/components/ScreenPreferencesBoundary": {
          useVisualEffectiveMode: () => mode,
        },
        "@/theme/colors": { settingsScreenBackgrounds },
      },
      (source) =>
        'import React from "react";\n' +
        transform("navigator", source) +
        "\nexport { SettingsNavigator };\n",
    );
    const parent = SettingsNavigator();
    assert.equal(
      parent.type,
      "View",
      "Settings transitions require an opaque stationary parent",
    );
    assert.deepEqual(parent.props.style, {
      flex: 1,
      backgroundColor: expected,
    });
    const stack = parent.props.children as Element;
    assert.equal(stack.type, "SettingsStack");
    assert.equal(stack.props.detachInactiveScreens, true);
    const options = stack.props.screenOptions as Record<string, unknown>;
    assert.deepEqual(options.cardStyle, { backgroundColor: expected });
    assert.equal(options.gestureEnabled, false);
    assert.deepEqual(options.transitionSpec, {
      open: { animation: "timing", config: { duration: 98, easing: "linear" } },
      close: {
        animation: "timing",
        config: { duration: 80, easing: "linear" },
      },
    });
  }
}

function auditFab(transform?: (source: string) => string): void {
  let selected: ColorScheme = "orange";
  const shared = { value: 1 };
  const springs: number[] = [];
  let pressIns = 0;
  let presses = 0;
  const { FAB } = loadSource<{
    FAB(props: { onPress(): void; onPressIn(): void }): Element;
  }>(
    "src/components/ui/FAB.tsx",
    {
      react,
      "react-native": { Pressable: "Pressable" },
      "@expo/vector-icons/Entypo": "Entypo",
      "react-native-reanimated": {
        createAnimatedComponent: () => "AnimatedPressable",
        useSharedValue: () => shared,
        useAnimatedStyle: (create: () => unknown) => create(),
        withSpring: (value: number) => {
          springs.push(value);
          return value;
        },
      },
      "react-native-safe-area-context": {
        useSafeAreaInsets: () => ({ bottom: 24 }),
      },
      "@/theme/tokens": { sizes, zIndex },
      "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
      "@/components/ScreenPreferencesBoundary": {
        useVisualColorScheme: () => selected,
      },
      "@/theme/colors": { getAccentScheme },
    },
    transform,
  );
  for (const scheme of [
    ...BUILTIN_COLOR_SCHEMES,
    "#123456",
    "#FFFFFF",
    "#000000",
  ] as ColorScheme[]) {
    selected = scheme;
    const element = FAB({
      onPress: () => {
        presses += 1;
      },
      onPressIn: () => {
        pressIns += 1;
      },
    });
    const [animated, style] = element.props.style as unknown[];
    assert.deepEqual(animated, { transform: [{ scale: 1 }] });
    assert.deepEqual(style, {
      position: "absolute",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: getAccentScheme(scheme).base,
      bottom: 40,
      right: 16,
      width: sizes.fab,
      height: sizes.fab,
      borderRadius: sizes.fab / 2,
      zIndex: zIndex.fab,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
      elevation: 4,
    });
    assert.equal(element.props.className, undefined);
    assert.equal(element.props.accessibilityRole, "button");
    assert.equal(element.props.accessibilityLabel, "creation.title");
    const icon = element.props.children as Element;
    assert.equal(icon.type, "Entypo");
    assert.deepEqual(icon.props, {
      name: "plus",
      size: 34,
      color: "#FFFFFF",
      children: [],
    });
    (element.props.onPressIn as () => void)();
    assert.equal(shared.value, 0.95);
    (element.props.onPressOut as () => void)();
    assert.equal(shared.value, 1);
    (element.props.onPress as () => void)();
  }
  const count = BUILTIN_COLOR_SCHEMES.length + 3;
  assert.equal(pressIns, count);
  assert.equal(presses, count);
  assert.equal(springs.length, count * 2);
}

function auditJsxStylingBoundaries(): void {
  const require = createRequire(resolve("babel.config.js"));
  const babel = require("@babel/core") as {
    transformSync(
      source: string,
      options: Record<string, unknown>,
    ): { code?: string | null } | null;
  };
  const configure = require("./babel.config.js") as (api: {
    cache(value: boolean): void;
  }) => Record<string, unknown>;
  const config = configure({ cache() {} });
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".tsx")) files.push(file);
    }
  };
  walk("app");
  walk("src");
  const runtimeFor = (
    file: string,
    source: string,
    platform: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const output = babel.transformSync(source, {
      ...config,
      ...overrides,
      filename: resolve(file),
      configFile: false,
      babelrc: false,
      envName: "production",
      caller: {
        name: "metro",
        platform,
        isDev: false,
        supportsStaticESM: false,
      },
    });
    assert.ok(output?.code, `Babel must compile ${file} for ${platform}`);
    const runtime = output.code.match(
      /["']((?:react|nativewind|react-native-css-interop)\/jsx(?:-dev)?-runtime)["']/,
    )?.[1];
    return runtime;
  };
  let styledFiles = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let hasClassName = false;
    let hasJsx = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isJsxElement(node) ||
        ts.isJsxSelfClosingElement(node) ||
        ts.isJsxFragment(node)
      )
        hasJsx = true;
      if (
        (ts.isJsxAttribute(node) || ts.isPropertyAssignment(node)) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === "className"
      ) {
        hasClassName = true;
      }
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        /^(?:Animated\.|AnimatedPressable$)/.test(node.tagName.getText(tree))
      ) {
        assert.ok(
          !node.attributes.properties.some(
            (property) =>
              ts.isJsxAttribute(property) &&
              property.name.getText(tree) === "className",
          ),
          `animated hosts must own native styles explicitly: ${file}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    if (hasClassName) {
      styledFiles += 1;
      assert.ok(
        source.startsWith("/** @jsxImportSource nativewind */"),
        `styled JSX requires its own import-source pragma: ${file}`,
      );
    }
    if (!hasJsx) continue;
    for (const platform of ["android", "ios", "web"]) {
      const runtime = runtimeFor(file, source, platform);
      assert.equal(
        hasClassName
          ? /^(?:nativewind|react-native-css-interop)\//.test(runtime ?? "")
          : runtime === "react/jsx-runtime",
        true,
        `JSX runtime must match the file's styling boundary: ${file} (${platform})`,
      );
    }
  }
  const probeFile = "src/components/ui/StylingProbe.tsx";
  const probe =
    'import { View } from "react-native"; export default () => <View style={{ flex: 1 }} />;';
  assert.equal(runtimeFor(probeFile, probe, "android"), "react/jsx-runtime");
  const styledProbe =
    '/** @jsxImportSource nativewind */\nimport { View } from "react-native"; export default () => <View className="flex-1" />;';
  assert.ok(
    /^(?:nativewind|react-native-css-interop)\//.test(
      runtimeFor(probeFile, styledProbe, "android") ?? "",
    ),
  );
  assert.equal(
    runtimeFor(
      probeFile,
      styledProbe.replace("/** @jsxImportSource nativewind */", ""),
      "android",
    ),
    "react/jsx-runtime",
    "a missing pragma must be observable at the emitted JSX boundary",
  );
  assert.notEqual(
    runtimeFor(probeFile, probe, "android", {
      presets: [
        ["babel-preset-expo", { jsxImportSource: "nativewind" }],
        "nativewind/babel",
      ],
    }),
    "react/jsx-runtime",
    "a global styling transform must be detectable in an unstyled module",
  );
  assert.ok(styledFiles > 0);
  console.log(
    `JSX styling boundaries passed: ${files.length} TSX files, ${styledFiles} explicit styling owners, Android/iOS/web Babel output.`,
  );
}

function auditNativeCalendarCells(): void {
  const path = "src/features/statistics/components/Heatmap.tsx";
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const bypassed: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.attributes.properties.some(
        (property) =>
          ts.isJsxAttribute(property) &&
          property.name.getText(source) === "cssInterop" &&
          property.initializer?.getText(source) === "{false}",
      )
    )
      bypassed.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(
    bypassed.map((node) => node.tagName.getText(source)),
    ["View", "View", "Text"],
  );
  for (const node of bypassed) {
    assert.ok(
      node.attributes.properties.every(
        (property) =>
          ts.isJsxAttribute(property) &&
          ["key", "cssInterop", "style"].includes(
            property.name.getText(source),
          ),
      ),
      "native calendar cells must not acquire class names, interaction handlers or spread props",
    );
    const style = node.attributes.properties.find(
      (property) =>
        ts.isJsxAttribute(property) &&
        property.name.getText(source) === "style",
    ) as ts.JsxAttribute;
    assert.ok(
      style?.initializer,
      "each bypassed cell must have its explicit native style",
    );
    assert.doesNotMatch(
      style.initializer.getText(source),
      /\bvars\s*\(|--color-|className/,
    );
  }
  assert.equal(
    (
      bypassed[0].attributes.properties.find(
        (property) =>
          ts.isJsxAttribute(property) &&
          property.name.getText(source) === "style",
      ) as ts.JsxAttribute
    ).initializer?.getText(source),
    "{calendarCellFrameStyle}",
  );

  const NativeView = Symbol("NativeView");
  const InteropView = Symbol("InteropView");
  const module = loadSource<{
    default: (jsx: typeof react.createElement) => typeof react.createElement;
  }>("node_modules/react-native-css-interop/src/runtime/wrap-jsx.ts", {
    "./api": { interopComponents: new Map([[NativeView, InteropView]]) },
    "./components": {},
    "./third-party-libs/react-native-safe-area-context": {
      maybeHijackSafeAreaProvider: (type: unknown) => type,
    },
  });
  const jsx = module.default(react.createElement);
  const style = [{ width: "100%", height: 32 }, { backgroundColor: "#123456" }];
  const native = jsx(
    NativeView,
    { cssInterop: false, style, accessibilityLabel: "Cell" },
    "13",
  );
  assert.equal(native.type, NativeView);
  assert.deepEqual(native.props, {
    style,
    accessibilityLabel: "Cell",
    children: "13",
  });
  assert.equal(
    jsx(NativeView, { style }).type,
    InteropView,
    "the library must retain ordinary CSS interop outside the explicit bypass",
  );
}

function auditCompositeStylingBoundaries(
  transform: (file: string, source: string) => string = (_file, source) =>
    source,
): void {
  const registrationPath =
    "node_modules/react-native-css-interop/src/runtime/components.ts";
  const registration = ts.createSourceFile(
    registrationPath,
    readFileSync(registrationPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const remappedProps = new Map<string, Set<string>>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(registration) === "remapProps"
    ) {
      const [component, mapping] = node.arguments;
      assert.ok(
        component &&
          ts.isIdentifier(component) &&
          mapping &&
          ts.isObjectLiteralExpression(mapping),
      );
      remappedProps.set(
        component.text,
        new Set(
          mapping.properties.map((property) =>
            property.name!.getText(registration),
          ),
        ),
      );
    }
    ts.forEachChild(node, collect);
  };
  collect(registration);
  assert.deepEqual([...remappedProps.keys()].sort(), [
    "FlatList",
    "ImageBackground",
    "KeyboardAvoidingView",
    "VirtualizedList",
  ]);
  const consumers: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!file.endsWith(".tsx")) continue;
      const source = transform(file, readFileSync(file, "utf8"));
      const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const imported = new Map<string, string>();
      for (const statement of tree.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          statement.moduleSpecifier.getText(tree) !== '"react-native"'
        )
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const specifier of bindings.elements)
          imported.set(
            specifier.name.text,
            specifier.propertyName?.text ?? specifier.name.text,
          );
      }
      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const component = imported.get(node.tagName.getText(tree));
          const mapped = component && remappedProps.get(component);
          if (mapped) {
            consumers.push(`${file}:${component}`);
            for (const property of node.attributes.properties) {
              assert.ok(
                !ts.isJsxAttribute(property) ||
                  !mapped.has(property.name.getText(tree)),
                `remapped composites require resolved native styles without a global descendant JSX transform: ${file}`,
              );
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
  };
  walk("app");
  walk("src");
  assert.deepEqual(consumers.sort(), [
    "app/archive.tsx:FlatList",
    "app/habit/[id]/notes.tsx:FlatList",
    "app/habit/[id]/notes.tsx:KeyboardAvoidingView",
    "app/settings/color-scheme.tsx:FlatList",
    "src/features/habit-form/components/RepeatSheet.tsx:KeyboardAvoidingView",
  ]);

  const opaqueStyles = new WeakMap<object, unknown>();
  const shared = loadSource<Record<string, unknown>>(
    "node_modules/react-native-css-interop/src/shared.ts",
    {
      "./runtime/native/resolvers/shared": {
        ShorthandSymbol: Symbol("Shorthand"),
      },
    },
  );
  const config = loadSource<Record<string, unknown>>(
    "node_modules/react-native-css-interop/src/runtime/config.ts",
    {},
  );
  const api = loadSource<{
    interopComponents: Map<unknown, unknown>;
    remapProps(
      component: unknown,
      mapping: Record<string, string>,
    ): (props: Record<string, unknown>) => Element;
  }>("node_modules/react-native-css-interop/src/runtime/native/api.ts", {
    react: { ...react, forwardRef: (render: unknown) => render },
    "../../shared": shared,
    "../config": config,
    "../observable": {},
    "./appearance-observables": {},
    "./native-interop": {},
    "./styles": { opaqueStyles },
    "./unwrap-components": {},
    "./stylesheet": {},
    "./unit-observables": {},
  });
  const base = Symbol("Composite");
  const remapped = api.remapProps(base, { className: "style" });
  const opaque = remapped({ className: "flex-1 justify-end" });
  assert.equal(opaque.type, base);
  assert.deepEqual(Object.keys(opaque.props.style as object), []);
  assert.ok(
    opaqueStyles.has(opaque.props.style as object),
    "remapProps must be exercised through its actual opaque-style implementation",
  );
  const bridge = loadSource<{
    default: (jsx: typeof react.createElement) => typeof react.createElement;
  }>("node_modules/react-native-css-interop/src/runtime/wrap-jsx.ts", {
    "./api": api,
    "./components": {},
    "./third-party-libs/react-native-safe-area-context": {
      maybeHijackSafeAreaProvider: (type: unknown) => type,
    },
  }).default(react.createElement);
  for (const [file, component] of [
    [
      "src/features/habit-form/components/RepeatSheet.tsx",
      "KeyboardAvoidingView",
    ],
    ["app/habit/[id]/notes.tsx", "KeyboardAvoidingView"],
    ["app/settings/color-scheme.tsx", "FlatList"],
  ]) {
    const source = transform(file, readFileSync(file, "utf8"));
    const tree = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined;
    let noteViewport: ts.JsxOpeningElement | undefined;
    let background: ts.VariableStatement | undefined;
    const find = (node: ts.Node): void => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        node.tagName.getText(tree) === component
      )
        opening = node;
      if (file.includes("notes") && ts.isJsxOpeningElement(node) &&
          node.tagName.getText(tree) === "NoteEditorViewport") noteViewport = node;
      if (
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (item) => item.name.getText(tree) === "backgroundColor",
        )
      )
        background = node;
      ts.forEachChild(node, find);
    };
    find(tree);
    assert.ok(opening);
    const attribute = (name: string) =>
      opening!.attributes.properties.find(
        (property) =>
          ts.isJsxAttribute(property) && property.name.getText(tree) === name,
      ) as ts.JsxAttribute | undefined;
    assert.equal(
      attribute("cssInterop")?.initializer?.getText(tree),
      "{false}",
    );
    const style = attribute("style")?.initializer;
    assert.ok(style && ts.isJsxExpression(style) && style.expression);
    let mode: "light" | "dark" = "light";
    const extracted = loadSource<{
      style(lift: number): Record<string, unknown>;
    }>(
      file,
      {
        "@/components/ScreenPreferencesBoundary": {
          useVisualEffectiveMode: () => mode,
        },
        "@/theme/colors": { lightTheme, darkTheme, settingsScreenBackgrounds },
      },
      () => `import { useVisualEffectiveMode } from "@/components/ScreenPreferencesBoundary";
      import { lightTheme, darkTheme, settingsScreenBackgrounds } from "@/theme/colors";
      export function style(editorKeyboardLift: number) {
        ${background?.getText(tree) ?? ""}
        return ${style.expression!.getText(tree)};
      }`,
    );
    let extractedNoteViewport: { style(lift: number): Record<string, unknown> } | undefined;
    if (file.includes("notes")) {
      assert.ok(noteViewport, "Notes must preserve its dedicated editor viewport");
      const viewportStyle = noteViewport.attributes.properties.find((property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText(tree) === "style")?.initializer;
      assert.ok(viewportStyle && ts.isJsxExpression(viewportStyle) && viewportStyle.expression);
      extractedNoteViewport = loadSource(file, {}, () => `
        export function style(editorBottomPadding: number) {
          return ${viewportStyle.expression!.getText(tree)};
        }`);
    }
    for (mode of ["light", "dark"] as const)
      for (const lift of [0, 168]) {
        const nativeStyle = extracted.style(lift);
        assert.deepEqual(
          nativeStyle,
          file.includes("RepeatSheet")
            ? { flex: 1, justifyContent: "flex-end" }
            : file.includes("notes")
              ? {
                  flex: 1,
                  backgroundColor: (mode === "dark" ? darkTheme : lightTheme)
                    .background,
                }
              : { flex: 1, backgroundColor: settingsScreenBackgrounds[mode] },
        );
        const element = bridge(base, { cssInterop: false, style: nativeStyle });
        assert.equal(element.type, base);
        assert.equal(element.props.style, nativeStyle);
        assert.ok(!("cssInterop" in element.props));
        assert.ok(!opaqueStyles.has(nativeStyle));
        if (file.includes("notes")) {
          const viewportStyle = extractedNoteViewport!.style(lift);
          assert.deepEqual(viewportStyle, { flex: 1, paddingBottom: lift, overflow: "hidden" },
            "the Notes viewport, not its screen root, must own the editor keyboard lift");
          assert.equal("backgroundColor" in viewportStyle, false,
            "the Notes viewport must remain transparent instead of owning another background");
          assert.equal(nativeStyle.backgroundColor,
            (mode === "dark" ? darkTheme : lightTheme).background,
            "the transparent Notes viewport must preserve its current root canvas in both themes");
          const nativeViewport = Symbol("NoteEditorViewport");
          const viewportElement = bridge(nativeViewport, { style: viewportStyle });
          assert.equal(viewportElement.type, nativeViewport);
          assert.equal(viewportElement.props.style, viewportStyle);
          assert.ok(!opaqueStyles.has(viewportStyle));
        }
      }
  }
}

function auditDatePickerCells(
  transform: (source: string) => string = (source) => source,
): void {
  const file = "src/features/habit-form/components/DatePickerModal.tsx";
  const module = loadSource<{
    DatePickerDayCell: (props: Record<string, unknown>) => Element;
  }>(
    file,
    {
      react: {
        ...react,
        memo: (component: unknown) => component,
        useCallback: (callback: unknown) => callback,
      },
      "react-native": { Pressable: "Pressable", View: "View", Text: "Text" },
      "@/theme/tokens": { borders: { todayIndicator: 1.25 } },
    },
    (source) => {
      const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const declaration = tree.statements.find(
        (statement) =>
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some(
            (item) => item.name.getText(tree) === "DatePickerDayCell",
          ),
      );
      assert.ok(
        declaration,
        "the calendar must expose its actual day-cell declaration to the fixture",
      );
      return transform(`import React, { useCallback } from "react";
      import { View, Text, Pressable } from "react-native";
      import { borders } from "@/theme/tokens";
      ${declaration.getText(tree)}
      export { DatePickerDayCell };`);
    },
  );
  for (const palette of [lightTheme, darkTheme])
    for (const scheme of BUILTIN_COLOR_SCHEMES) {
      for (const selected of [false, true])
        for (const today of [false, true])
          for (const placeholder of [false, true]) {
            const calls: unknown[][] = [];
            const day = placeholder
              ? null
              : {
                  dateString: "2011-12-30",
                  dayNumber: 30,
                  dayLabel: "30",
                  accessibilityLabel: "Friday, December 30, 2011",
                };
            const accent = getAccentScheme(scheme).base;
            const cell = module.DatePickerDayCell({
              accent,
              textColor: palette.primary,
              day,
              isSelected: selected,
              isTodayDate: today,
              onSelectDay: (...args: unknown[]) => calls.push(args),
            });
            assert.equal(cell.type, "Pressable");
            assert.deepEqual(cell.props.style, {
              width: "14.28%",
              height: 40,
              alignItems: "center",
              justifyContent: "center",
            });
            assert.equal(cell.props.cssInterop, false);
            assert.equal(cell.props.disabled, placeholder);
            assert.equal(cell.props.accessible, !placeholder);
            assert.equal(cell.props.accessibilityElementsHidden, placeholder);
            assert.equal(
              cell.props.importantForAccessibility,
              placeholder ? "no-hide-descendants" : "yes",
            );
            assert.equal(
              cell.props.accessibilityRole,
              placeholder ? undefined : "button",
            );
            assert.equal(
              cell.props.accessibilityLabel,
              day?.accessibilityLabel,
            );
            assert.deepEqual(
              cell.props.accessibilityState,
              placeholder ? undefined : { selected },
            );
            if (placeholder) {
              assert.equal(cell.props.onPress, undefined);
              assert.equal(cell.props.children, null);
            } else {
              (cell.props.onPress as () => void)();
              assert.deepEqual(
                calls,
                [["2011-12-30"]],
                "a press must retain the civil-date key without a local Date round trip",
              );
              const circle = cell.props.children as Element;
              assert.equal(circle.type, "View");
              assert.equal(circle.props.cssInterop, false);
              assert.deepEqual(circle.props.style, {
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: selected ? accent : "transparent",
                borderWidth: today && !selected ? 1.25 : 0,
                borderColor: today && !selected ? accent : "transparent",
              });
              const label = circle.props.children as Element;
              assert.equal(label.type, "Text");
              assert.equal(label.props.cssInterop, false);
              assert.deepEqual(label.props.style, {
                fontSize: 14,
                color: selected ? "#FFFFFF" : palette.primary,
              });
              assert.equal(label.props.children, "30");
            }
          }
    }
}

auditThemeValues();
auditGroupedSurfaceColors();
auditSettingsSceneSurfaces();
for (const [owner, before, after, expected] of [
  [
    "shell",
    /<Header\s+backgroundColor=\{backgroundColor\}/g,
    "<Header",
    /header must match/,
  ],
  [
    "shell",
    /<ScreenWrapper\s+scrollable\s+backgroundColor=\{backgroundColor\}>/g,
    "<ScreenWrapper scrollable>",
    /scroll body must match/,
  ],
  [
    "navigator",
    /<View\s+style=\{\{ flex: 1, backgroundColor: stackBackgroundColor \}\}>/g,
    '<View style={{ flex: 1, backgroundColor: "#F2F2F2" }}>',
    /Expected values to be strictly deep-equal/,
  ],
] as const) {
  assert.throws(
    () =>
      auditSettingsSceneSurfaces((file, source) => {
        if (file !== owner) return source;
        assert.equal(source.match(before)?.length, 1);
        return source.replace(before, after);
      }),
    (error) =>
      error instanceof assert.AssertionError && expected.test(error.message),
    "scene-surface mutations must fail an actual rendered contract",
  );
}
assert.throws(
  () =>
    auditSettingsSceneSurfaces((file, source) => {
      if (file !== "navigator") return source;
      const parent =
        /<View\s+style=\{\{ flex: 1, backgroundColor: stackBackgroundColor \}\}>/g;
      assert.equal(source.match(parent)?.length, 1);
      assert.equal(source.split("</View>").length - 1, 1);
      return source.replace(parent, "").replace("</View>", "");
    }),
  (error) =>
    error instanceof assert.AssertionError &&
    /opaque stationary parent/.test(error.message),
  "removing only the transition underlay must fail even with opaque card surfaces",
);
auditVariableOwnership();
auditFab();
auditNativeCalendarCells();
auditDatePickerCells();
for (const [before, after] of [
  [/width: "14.28%",\s*height: 40/g, 'width: "14.28%", height: 41'],
  [/isSelected \? "#FFFFFF" : textColor/g, 'isSelected ? "#FFFFFF" : accent'],
  [
    /onPress=\{dateString == null \? undefined : handlePress\}/g,
    "onPress={handlePress}",
  ],
  [
    /isTodayDate && !isSelected \? borders.todayIndicator : 0/g,
    "isTodayDate ? borders.todayIndicator : 0",
  ],
] as const) {
  const original = readFileSync(
    "src/features/habit-form/components/DatePickerModal.tsx",
    "utf8",
  );
  assert.equal(
    original.match(before)?.length,
    1,
    "each cell mutation must have one actual source target",
  );
  assert.throws(
    () => auditDatePickerCells((source) => source.replace(before, after)),
    { name: "AssertionError" },
  );
}
auditJsxStylingBoundaries();
auditCompositeStylingBoundaries();
for (const [file, before, after] of [
  [
    "src/features/habit-form/components/RepeatSheet.tsx",
    'justifyContent: "flex-end"',
    'justifyContent: "flex-start"',
  ],
  [
    "src/features/habit-form/components/RepeatSheet.tsx",
    "cssInterop={false}",
    'className="flex-1 justify-end"',
  ],
  [
    "app/habit/[id]/notes.tsx",
    "paddingBottom: editorBottomPadding",
    "paddingBottom: 0",
  ],
  [
    "app/settings/color-scheme.tsx",
    "settingsScreenBackgrounds[useVisualEffectiveMode()]",
    "settingsScreenBackgrounds.light",
  ],
] as const) {
  const original = readFileSync(file, "utf8");
  assert.equal(
    original.split(before).length,
    2,
    "each composite mutation must have one actual source target",
  );
  assert.throws(
    () =>
      auditCompositeStylingBoundaries((path, source) =>
        path === file ? source.replace(before, after) : source,
      ),
    { name: "AssertionError" },
  );
}
assert.throws(
  () =>
    auditVariableOwnership((source) =>
      source.replace("if (cached) return cached;", "if (false) return cached;"),
    ),
  { name: "AssertionError" },
  "the ownership audit must reject uncached inherited variables",
);
assert.throws(
  () =>
    auditFab((source) =>
      source.replace(
        "backgroundColor: accent.base",
        "backgroundColor: '#000000'",
      ),
    ),
  { name: "AssertionError" },
  "the FAB audit must reject an incorrect accent without a geometry change",
);
console.log(
  "Theme rendering audit passed: shared variables, exact theme/FAB/calendar props, native cells, and mutation guards.",
);
