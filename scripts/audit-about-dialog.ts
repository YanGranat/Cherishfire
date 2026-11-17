import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as colors from "../src/theme/colors";
import * as tokens from "../src/theme/tokens";
import { privacyPolicy } from "../src/features/settings/privacy-policy";
import notices from "../assets/third_party_notices.json";
import * as dialogLayout from "../src/components/ui/dialog-layout";

interface Element {
  type: unknown;
  props: Record<string, unknown>;
}

interface AboutResource {
  title: string;
  description: string;
  close: string;
  version: string;
}

type Component = (props: Record<string, unknown>) => Element;
const aboutFile = "src/features/settings/components/AboutDialog.tsx";
const descriptions = {
  de: "Eine App zur Gewohnheitsverfolgung.",
  en: "A habit tracking app.",
  es: "Una app para el seguimiento de hábitos.",
  fr: "Une application pour suivre vos habitudes.",
  it: "Un'app per monitorare le abitudini.",
  nl: "Een app om gewoonten bij te houden.",
  pl: "Aplikacja do śledzenia nawyków.",
  ru: "Приложение для отслеживания привычек.",
  uk: "Застосунок для відстеження звичок.",
};
const resources = new Map<string, AboutResource>();
for (const [language, description] of Object.entries(descriptions)) {
  const resource = JSON.parse(
    readFileSync(resolve(`src/i18n/locales/${language}.json`), "utf8"),
  ).about as AboutResource;
  assert.equal(
    resource.description,
    description,
    `${language} must describe habit tracking`,
  );
  assert.ok(
    resource.title &&
      resource.close &&
      resource.version.includes("{{version}}"),
  );
  resources.set(language, resource);
}
assert.deepEqual(
  readdirSync(resolve("src/i18n/locales"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .sort(),
  Object.keys(descriptions).sort(),
  "every bundled locale must have an About description contract",
);

const jsx = (type: unknown, props: Record<string, unknown>): Element => ({
  type,
  props,
});
function loadComponent(
  file: string,
  name: string,
  mocks: Record<string, unknown>,
  transform: (source: string) => string = (source) => source,
): Component {
  const compiled = ts.transpileModule(
    transform(readFileSync(resolve(file), "utf8")),
    {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const module = { exports: {} as Record<string, Component> };
  new Function("require", "module", "exports", compiled)(
    (id: string) => {
      if (id === "nativewind/jsx-runtime" || id === "react/jsx-runtime")
        return { jsx, jsxs: jsx };
      assert.ok(Object.hasOwn(mocks, id), `unexpected platform import: ${id}`);
      return mocks[id];
    },
    module,
    module.exports,
  );
  assert.equal(typeof module.exports[name], "function");
  return module.exports[name];
}

function descendants(element: Element): Element[] {
  const result = [element];
  const visit = (child: unknown): void => {
    if (Array.isArray(child)) child.forEach(visit);
    else if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      "props" in child
    ) {
      result.push(...descendants(child as Element));
    }
  };
  visit(element.props.children);
  return result;
}

function only(
  root: Element,
  type: unknown,
  predicate: (element: Element) => boolean = () => true,
): Element {
  const found = descendants(root).filter(
    (element) => element.type === type && predicate(element),
  );
  assert.equal(found.length, 1, `expected one ${String(type)} element`);
  return found[0];
}

function style(value: unknown): Record<string, unknown> {
  return Array.isArray(value)
    ? Object.assign({}, ...value.map(style))
    : value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
}

function auditRendering(transform?: (source: string) => string): void {
  let mode: "light" | "dark" = "light";
  let language = "en";
  let windowWidth = 360;
  const closeCalls: unknown[][] = [];
  const onClose = (...args: unknown[]) => closeCalls.push(args);
  const preferences = {
    useVisualEffectiveMode: () => mode,
    useVisualColorScheme: () => "orange",
  };
  const translation = {
    useTranslation: () => ({
      t: (key: string, values?: { version?: string }) => {
        if (!key.startsWith("about.")) return key;
        const value =
          resources.get(language)![key.slice(6) as keyof AboutResource];
        assert.equal(
          typeof value,
          "string",
          `unknown About translation: ${key}`,
        );
        return values?.version
          ? value.replace("{{version}}", values.version)
          : value;
      },
    }),
  };
  const Dialog = loadComponent("src/components/ui/Dialog.tsx", "Dialog", {
    react: {
      useRef: (value: unknown) => ({ current: value }),
      useEffect: () => undefined,
      useLayoutEffect: () => undefined,
      useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => undefined],
    },
    "react-native": {
      View: "View",
      Text: "Text",
      Pressable: "Pressable",
      ScrollView: "ScrollView",
      Keyboard: { metrics: () => undefined },
      Platform: { OS: "android" },
      useWindowDimensions: () => ({ width: windowWidth, height: 800 }),
    },
    "@expo/vector-icons/MaterialIcons": "MaterialIcons",
    "@/theme/tokens": tokens,
    "./dialog-layout": dialogLayout,
    "@/theme/colors": colors,
    "@/components/ScreenPreferencesBoundary": preferences,
    "@/components/ui/AppModal": {
      AppModal: "AppModal",
      AppModalContentMarker: "ContentMarker",
    },
  });
  const AboutDialog = loadComponent(
    aboutFile,
    "AboutDialog",
    {
      "react-native": { View: "View", Text: "Text" },
      "expo-constants": { expoConfig: { version: "9.8.7" } },
      "react-i18next": translation,
      "@/components/ui/Dialog": { Dialog },
      "@/components/ScreenPreferencesBoundary": preferences,
      "@/theme/colors": colors,
    },
    transform,
  );
  const DeleteDialog = loadComponent(
    "src/features/habit-detail/components/DeleteDialog.tsx",
    "DeleteDialog",
    {
      react: {},
      "react-i18next": translation,
      "@/components/ui/Dialog": { Dialog },
    },
  );
  const standard = Dialog(
    DeleteDialog({
      visible: true,
      onCancel: () => undefined,
      onDelete: () => undefined,
    }).props,
  );
  const deleteButton = only(
    standard,
    "Pressable",
    (element) =>
      element.props.accessibilityRole === "button" &&
      descendants(element).some(
        (child) =>
          child.type === "Text" &&
          child.props.children === "deleteDialog.delete",
      ),
  );
  const deleteText = style(only(deleteButton, "Text").props.style);
  assert.equal(deleteText.fontSize, 14.5);
  assert.equal(deleteText.lineHeight, 20);

  for (mode of ["light", "dark"] as const) {
    const palette = mode === "light" ? colors.lightTheme : colors.darkTheme;
    for (language of Object.keys(descriptions)) {
      const expected = resources.get(language)!;
      const about = AboutDialog({ visible: true, onClose });
      assert.equal(about.type, Dialog);
      assert.equal(about.props.variant, "about");
      assert.equal(about.props.contentBackgroundColor, palette.menuSurface);
      assert.deepEqual(about.props.titleStyle, {
        fontSize: 20,
        lineHeight: 26,
        fontWeight: "400",
        marginBottom: 16,
      });
      assert.deepEqual(about.props.contentStyle, { paddingBottom: 12 });
      assert.deepEqual(about.props.actionsContainerStyle, {
        width: "100%",
        justifyContent: "flex-end",
        columnGap: 0,
      });
      assert.deepEqual(about.props.actionButtonStyle, { paddingHorizontal: 0 });
      const actions = about.props.actions as Record<string, unknown>[];
      assert.equal(actions.length, 1);
      assert.equal(
        actions[0].onPress,
        onClose,
        "Close must keep the supplied handler identity",
      );
      assert.equal(actions[0].role, "cancel");
      assert.equal(actions[0].tone, "muted");
      assert.equal(actions[0].label, expected.close);
      for (const width of [280, 360, 800]) {
        windowWidth = width;
        const modal = Dialog(about.props);
        assert.equal(modal.type, "AppModal");
        assert.equal(modal.props.visible, true);
        assert.equal(modal.props.animationType, "fade");
        assert.equal(modal.props.transparent, true);
        assert.equal(modal.props.statusBarTranslucent, true);
        const card = only(
          modal,
          "Pressable",
          (element) =>
            style(element.props.style).borderRadius === tokens.radii.dialog,
        );
        const cardStyle = style(card.props.style);
        assert.equal(cardStyle.width, Math.min(304, width - 32));
        assert.equal(cardStyle.maxHeight, 752);
        assert.equal(cardStyle.paddingTop, 24);
        assert.equal(cardStyle.paddingHorizontal, 24);
        assert.equal(cardStyle.paddingBottom, 12);
        assert.equal(cardStyle.backgroundColor, palette.menuSurface);
        const text = only(
          modal,
          "Text",
          (element) => element.props.children === expected.close,
        );
        const closeText = style(text.props.style);
        assert.deepEqual(closeText, {
          fontSize: 13.5,
          lineHeight: 19,
          fontWeight: "600",
          color: palette.muted,
        });
        assert.ok(
          Number(closeText.fontSize) < Number(deleteText.fontSize),
          "About must preserve a quieter action hierarchy than destructive confirmations",
        );
        assert.equal(
          Number(cardStyle.paddingBottom) +
            (44 - Number(closeText.lineHeight)) / 2,
          24.5,
          "the nominal footer edge gap must balance the 24dp top inset",
        );
        const button = only(
          modal,
          "Pressable",
          (element) => element.props.accessibilityRole === "button",
        );
        assert.equal(
          button.props.className,
          "min-h-[44px] px-md items-center justify-center active:opacity-60",
        );
        assert.deepEqual(style(button.props.style), { maxWidth: "100%", paddingHorizontal: 0 });
        assert.deepEqual(button.props.accessibilityState, {
          disabled: undefined,
        });
        assert.equal(
          style(
            only(
              modal,
              "Text",
              (element) => element.props.children === expected.description,
            ).props.style,
          ).color,
          palette.muted,
        );
        assert.equal(
          style(
            only(
              modal,
              "Text",
              (element) =>
                element.props.children ===
                expected.version.replace("{{version}}", "9.8.7"),
            ).props.style,
          ).color,
          palette.muted,
        );
        const before = closeCalls.length;
        (button.props.onPress as () => void)();
        assert.deepEqual(closeCalls.slice(before), [[]]);
        const scrim = only(
          modal,
          "Pressable",
          (element) =>
            element.props.className === "flex-1" &&
            style(element.props.style).backgroundColor === colors.scrimColor,
        );
        assert.equal(
          style(scrim.props.style).backgroundColor,
          colors.scrimColor,
        );
        (scrim.props.onPress as () => void)();
        assert.equal(closeCalls.length, before + 2);
        assert.deepEqual(closeCalls.at(-1), []);
        let expectedCloseCount = before + 2;
        for (let backPress = 0; backPress < 2; backPress += 1) {
          assert.equal((modal.props.onRequestClose as () => boolean)(), true);
          assert.equal(closeCalls.length, ++expectedCloseCount);
          assert.deepEqual(closeCalls.at(-1), []);
        }
      }
      assert.equal(
        Dialog(AboutDialog({ visible: false, onClose }).props).props.visible,
        false,
      );
    }
  }
}

function auditPrivacyPolicy(): void {
  const markdown = [
    `# ${privacyPolicy.title}`,
    ...privacyPolicy.sections.flatMap(({ title, text }) => [
      `## ${title}`,
      text,
    ]),
  ].join("\n\n");
  assert.equal(
    readFileSync(resolve("PRIVACY.md"), "utf8").replace(/\r\n/g, "\n").trim(),
    markdown,
    "the published and in-app privacy policies must contain the same text",
  );
  assert.ok(privacyPolicy.sections.at(-1)!.text.includes(privacyPolicy.contact));
  const PrivacyScreen = loadComponent("app/settings/privacy.tsx", "default", {
    "react-native": { View: "View", Text: "Text" },
    "react-i18next": {
      useTranslation: () => ({ t: (key: string) => key }),
    },
    "@/features/settings/components/SettingsScreenShell": {
      SettingsScreenShell: "SettingsScreenShell",
    },
    "@/features/settings/privacy-policy": { privacyPolicy },
  });
  const screen = PrivacyScreen({});
  assert.equal(screen.type, "SettingsScreenShell");
  assert.equal(screen.props.title, "settings.privacyPolicy");
  assert.notEqual(screen.props.scrollableBody, false);
  for (const section of privacyPolicy.sections) {
    const heading = only(screen, "Text", ({ props }) => props.children === section.title);
    assert.equal(heading.props.accessibilityRole, "header");
    const paragraph = only(screen, "Text", ({ props }) => props.children === section.text);
    assert.equal(paragraph.props.selectable, true);
  }
}

function auditPrivacyNavigation(): void {
  const source = readFileSync(resolve("app/settings/index.tsx"), "utf8");
  const tree = ts.createSourceFile("settings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const buttons: ts.JsxOpeningElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === "Pressable" &&
        node.attributes.properties.some((property) => ts.isJsxAttribute(property) &&
          property.name.getText(tree) === "accessibilityLabel" &&
          property.initializer?.getText(tree) === '{t("settings.privacyPolicy")}')) {
      buttons.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(buttons.length, 1, "Settings must expose one accessible privacy-policy control");
  const property = (name: string) => buttons[0].attributes.properties.find(
    (entry): entry is ts.JsxAttribute => ts.isJsxAttribute(entry) && entry.name.getText(tree) === name,
  );
  assert.equal(property("accessibilityRole")?.initializer?.getText(tree), '"button"');
  const handler = property("onPress")?.initializer;
  assert.ok(handler && ts.isJsxExpression(handler) && handler.expression);
  const code = ts.transpileModule(`(${handler.expression.getText(tree)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const status of ["dispatched", "blocked", "failed"]) {
    const destinations: string[] = [];
    const errors: unknown[][] = [];
    const failure = new Error("NavigationFailed");
    let intents = 0;
    const press = runInNewContext(code, {
      router: { push: (route: string) => destinations.push(route) },
      runNavigationIntent: ({ target, dispatch }: { target: string; dispatch: () => void }) => {
        intents += 1;
        assert.equal(target, "/settings/privacy");
        if (status === "dispatched") dispatch();
        return { status, error: failure };
      },
      console: { error: (...args: unknown[]) => errors.push(args) },
    }) as () => void;
    press();
    assert.equal(intents, 1);
    assert.deepEqual(destinations, status === "dispatched" ? ["/settings/privacy"] : []);
    assert.equal(errors.length, status === "failed" ? 1 : 0);
    if (status === "failed") assert.equal(errors[0][1], failure);
  }
}

async function auditNoticeAsset(): Promise<void> {
  const assetPath = "./assets/third_party_notices.json";
  const root = resolve(import.meta.dirname, "..");
  const config = JSON.parse(readFileSync(resolve(root, "app.json"), "utf8")) as {
    expo: { plugins: unknown[] };
  };
  const configured = config.expo.plugins.filter((plugin) => Array.isArray(plugin) && plugin[0] === "expo-asset");
  assert.equal(configured.length, 1, "native assets must have one configured expo-asset owner");
  assert.deepEqual(configured[0], ["expo-asset", { assets: [assetPath] }]);
  assert.ok(notices.groups.length > 0);
  for (const notice of notices.groups) {
    assert.ok(notice.packages.length > 0 && notice.text.trim() && notice.license);
  }
  const require = createRequire(import.meta.url);
  const pluginRoot = join(dirname(require.resolve("expo-asset/package.json")), "plugin/build");
  const assetUtilities = require(join(pluginRoot, "utils.js")) as {
    resolveAssetPaths: (assets: string[], root: string) => Promise<string[]>;
    validateAssets: (assets: string[], platform: string) => string[];
  };
  const assets = await assetUtilities.resolveAssetPaths([assetPath], root);
  for (const platform of ["android", "ios"]) {
    assert.deepEqual(assetUtilities.validateAssets(assets, platform), [resolve(root, assetPath)]);
  }
  const plugin = require(join(pluginRoot, "withAssets.js")).default as (
    config: { name: string; slug: string }, props: { assets: string[] },
  ) => { mods: { android: { dangerous: (config: Record<string, unknown>) => Promise<unknown> } } };
  const temporaryRoot = resolve(root, "temporary_files");
  mkdirSync(temporaryRoot, { recursive: true });
  const nativeRoot = mkdtempSync(join(temporaryRoot, "asset-copy-"));
  try {
    const nativeConfig = plugin({ name: "Asset Fixture", slug: "asset-fixture" }, { assets: [assetPath] });
    await nativeConfig.mods.android.dangerous({
      ...nativeConfig,
      modRequest: { projectRoot: root, platformProjectRoot: nativeRoot },
      modResults: {},
    });
    assert.deepEqual(
      readFileSync(join(nativeRoot, "app/src/main/assets/third_party_notices.json")),
      readFileSync(resolve(root, assetPath)),
      "the installed asset plugin must copy the complete notice bytes into Android assets",
    );
  } finally {
    assert.ok(nativeRoot.startsWith(temporaryRoot + sep));
    rmSync(nativeRoot, { recursive: true });
  }
}

auditPrivacyPolicy();
auditPrivacyNavigation();
auditRendering();
for (const [needle, replacement] of [
  ["fontSize: 13.5", "fontSize: 14.5"],
  ["lineHeight: 19", "lineHeight: 20"],
  ["paddingBottom: 12", "paddingBottom: 22"],
  ["onPress: onClose", "onPress: () => onClose(0)"],
  ['t("about.description")', 't("about.version")'],
]) {
  assert.ok(
    readFileSync(resolve(aboutFile), "utf8").includes(needle),
    `mutation target must exist: ${needle}`,
  );
  assert.throws(
    () => auditRendering((source) => source.replace(needle, replacement)),
    { name: "AssertionError" },
    `the About contract must detect ${needle}`,
  );
}
const assetAuditDeadline = setTimeout(() => {
  console.error("Notice asset audit did not complete within 10 seconds");
  process.exitCode = 1;
}, 10_000);
void auditNoticeAsset()
  .then(() => console.log("About, privacy policy, and bundled notices audit passed."))
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => clearTimeout(assetAuditDeadline));
