import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const reviewedStackVersion = "7.7.2";
const reviewedExpoRouterVersion = "6.0.24";
const settingsLayout = readFileSync(
  resolve(root, "app/settings/_layout.tsx"),
  "utf8",
);
const rootLayout = readFileSync(resolve(root, "app/_layout.tsx"), "utf8");
const homeScreen = readFileSync(resolve(root, "app/index.tsx"), "utf8");
const statisticsScreen = readFileSync(
  resolve(root, "app/statistics.tsx"),
  "utf8",
);
const statisticsHook = readFileSync(
  resolve(root, "src/features/statistics/hooks/useStatistics.ts"),
  "utf8",
);
const packageLock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
) as { packages: Record<string, { version?: string }> };
const installedStackPackage = JSON.parse(
  readFileSync(
    resolve(root, "node_modules/@react-navigation/stack/package.json"),
    "utf8",
  ),
) as { version: string };
const installedExpoRouterPackage = JSON.parse(
  readFileSync(resolve(root, "node_modules/expo-router/package.json"), "utf8"),
) as { version: string };
const installedCardStack = readFileSync(
  resolve(
    root,
    "node_modules/@react-navigation/stack/src/views/Stack/CardStack.tsx",
  ),
  "utf8",
);
const installedExpoRouterRouting = readFileSync(
  resolve(root, "node_modules/expo-router/build/global-state/routing.js"),
  "utf8",
);

assert.equal(
  installedStackPackage.version,
  packageLock.packages["node_modules/@react-navigation/stack"]?.version,
  "the audited Settings navigator must match the lockfile",
);
assert.equal(
  installedExpoRouterPackage.version,
  packageLock.packages["node_modules/expo-router"]?.version,
  "the audited Expo Router implementation must match the lockfile",
);
assert.equal(
  installedExpoRouterPackage.version,
  reviewedExpoRouterVersion,
  "review hidden-route lifecycle again before upgrading Expo Router",
);
assert.equal(
  installedStackPackage.version,
  reviewedStackVersion,
  "review the effective detachInactiveScreens default before upgrading @react-navigation/stack",
);
assert.match(
  installedCardStack,
  /detachInactiveScreens = Platform\.OS === 'web' \|\|\s*Platform\.OS === 'android' \|\|\s*Platform\.OS === 'ios'/,
  "the installed navigator must detach inactive Settings screens by default on iOS and Android",
);
assert.match(
  installedCardStack,
  /<MaybeScreenContainer\s+enabled=\{detachInactiveScreens\}/,
  "the effective detachment default must reach the native screen container",
);
assert.match(
  installedCardStack,
  /<MaybeScreen[\s\S]{0,180}enabled=\{detachInactiveScreens\}/,
  "the effective detachment default must reach every native screen",
);

assert.match(settingsLayout, /const OPEN_DURATION_MS = 98;/);
assert.match(settingsLayout, /const CLOSE_DURATION_MS = 80;/);
assert.match(settingsLayout, /const OPEN_EASING = Easing\.linear;/);
assert.match(settingsLayout, /const CLOSE_EASING = Easing\.linear;/);
assert.match(settingsLayout, /const INCOMING_SHIFT_RATIO = 0\.2;/);
assert.match(settingsLayout, /const OUTGOING_SHIFT_RATIO = 0\.2;/);
assert.match(
  settingsLayout,
  /open:\s*\{\s*animation: "timing",\s*config: \{ duration: OPEN_DURATION_MS, easing: OPEN_EASING \}/,
  "Settings open transition must retain its tuned duration and linear easing",
);
assert.match(
  settingsLayout,
  /close:\s*\{\s*animation: "timing",\s*config: \{ duration: CLOSE_DURATION_MS, easing: CLOSE_EASING \}/,
  "Settings close transition must retain its tuned duration and linear easing",
);
assert.match(
  settingsLayout,
  /const incomingShiftPx = baseWidth \* INCOMING_SHIFT_RATIO;/,
  "the incoming Settings scene must retain its tuned horizontal shift",
);
assert.match(
  settingsLayout,
  /const outgoingShiftPx = baseWidth \* OUTGOING_SHIFT_RATIO;/,
  "the outgoing Settings scene must retain its tuned horizontal shift",
);
assert.match(
  settingsLayout,
  /inputRange: \[-outgoingShiftPx, -outgoingShiftPx \* 0\.5, 0\],\s*outputRange: \[0, 0\.5, 1\]/,
  "the outgoing Settings scene must retain its tuned transparency curve",
);
assert.match(
  settingsLayout,
  /inputRange: \[0, incomingShiftPx\],\s*outputRange: \[1, 0\]/,
  "the incoming Settings scene must retain its tuned transparency curve",
);
assert.match(
  settingsLayout,
  /const effectiveMode = useVisualEffectiveMode\(\);[\s\S]{0,180}const stackBackgroundColor = settingsScreenBackgrounds\[effectiveMode\]/,
  "the Settings stack must derive one opaque background from its shared visual snapshot",
);
assert.match(
  settingsLayout,
  /cardStyle: \{ backgroundColor: stackBackgroundColor \}/,
  "the Settings stack card must hide the native container during theme-aware transitions",
);
assert.match(
  settingsLayout,
  /gestureEnabled: false/,
  "Settings gestures must remain disabled",
);
assert.equal(
  (settingsLayout.match(/<ScreenPreferencesBoundary\b/g) ?? []).length,
  0,
  "the nested Settings stack must consume the single application visual owner",
);
assert.match(
  settingsLayout,
  /function SettingsNavigator\(\)[\s\S]*?<SettingsStack[\s\S]{0,120}detachInactiveScreens/,
  "inactive Settings native views must be detached instead of accumulating render work",
);
assert.doesNotMatch(
  settingsLayout,
  /\bscreenLayout\b/,
  "nested Settings screens must not each repaint an identical visual boundary",
);
assert.match(
  rootLayout,
  /<ScreenPreferencesBoundary>[\s\S]{0,420}<AppNavigation \/>[\s\S]{0,120}<\/ScreenPreferencesBoundary>/,
  "one live application visual owner must update every covered route before it is revealed",
);

assert.match(
  settingsLayout,
  /detachInactiveScreens/,
  "Settings must use the installed platform detachment contract",
);
assert.doesNotMatch(
  settingsLayout,
  /\bfreezeOnBlur\b/,
  "Settings must not opt into navigator-owned freezing",
);
assert.doesNotMatch(
  settingsLayout,
  /\b(?:Freeze|Suspense)\b/,
  "Settings must not add a manual Freeze or Suspense boundary",
);
assert.doesNotMatch(
  settingsLayout,
  /\bprefetch\b/,
  "Settings must not preload routes by mounting hidden screens",
);
// Expo Router route prefetch dispatches PRELOAD and the JS stack mounts that
// destination off-screen. Module and data warmup must remain separate from
// route lifecycle work so hidden scenes cannot accumulate render handlers.
assert.match(
  installedExpoRouterRouting,
  /function prefetch\(href, options\) \{[\s\S]{0,160}event: 'PRELOAD'/,
  "Expo Router prefetch semantics changed; re-audit every hidden route before enabling it",
);
assert.match(
  installedCardStack,
  /\[\.\.\.props\.routes, \.\.\.props\.state\.preloadedRoutes\]\.map/,
  "the reviewed JS stack must continue to mount preloaded routes off-screen",
);
assert.match(
  rootLayout,
  /import \{ Stack, useNavigationContainerRef, useRouter \} from "expo-router"/,
  "the root navigator must use Expo Router's native Stack",
);
assert.match(
  rootLayout,
  /animation: "none"[\s\S]{0,160}contentStyle: \{ backgroundColor: stackBackgroundColor \}/,
  "root promotion must stay transition-free and opaque in the live theme",
);
assert.match(
  homeScreen,
  /scheduleStatisticsPeriodsPrewarm\([\s\S]{0,700}period: "week", periodOffset: 0/,
  "only the common current-week Statistics data may warm during a genuine Home idle slot",
);
assert.doesNotMatch(
  homeScreen,
  /router\.prefetch\s*\(|navigation\.preload\s*\(|\bPRELOAD\b/,
  "Home must never mount hidden routes as a latency optimization",
);
assert.match(
  homeScreen,
  /route: "\/settings", load: \(\) => import\("\.\/settings\/index"\)/,
  "safe Settings module-only warmup must remain available",
);
assert.match(
  homeScreen,
  /route: "\/statistics", load: \(\) => import\("\.\/statistics"\)/,
  "safe Statistics module-only warmup must remain available",
);
assert.doesNotMatch(
  homeScreen,
  /prepareHabitDetail|onPressInHabit|pathname: "\/create"[\s\S]{0,180}prefetch/,
  "Habit/Create presses must navigate directly without hidden route lifecycle work",
);
assert.match(
  statisticsHook,
  /useFocusEffect\([\s\S]{0,260}statisticsFocusedRef\.current = true[\s\S]{0,260}statisticsFocusedRef\.current = false[\s\S]{0,160}cancelStatisticsPreparation/,
  "Statistics calculation and reload ownership must remain focus-scoped",
);
assert.match(
  statisticsHook,
  /function useLiveStatisticsStoreSnapshot\([\s\S]{0,2200}useSyncExternalStore/,
  "Statistics visible facts must update while covered so Back cannot reveal a stale scene",
);
assert.match(
  statisticsScreen,
  /<ReorderableStatisticsBlocks[\s\S]{0,500}active=\{active\}/,
  "the single Statistics scene must receive its presentation readiness gate",
);
const statisticsSourceFile = ts.createSourceFile(
  "statistics.tsx",
  statisticsScreen,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let periodSceneElement: ts.JsxSelfClosingElement | null = null;
const findPeriodScene = (node: ts.Node): void => {
  if (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(statisticsSourceFile) === "StatisticsPeriodScene"
  ) {
    assert.equal(
      periodSceneElement,
      null,
      "Statistics must render one retained period scene",
    );
    periodSceneElement = node;
  }
  ts.forEachChild(node, findPeriodScene);
};
findPeriodScene(statisticsSourceFile);
assert.ok(
  periodSceneElement,
  "Statistics must render its retained period scene",
);
const readJsxExpression = (
  attributes: ts.JsxAttributes,
  name: string,
): string | null => {
  const attribute = attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) &&
      property.name.getText(statisticsSourceFile) === name,
  );
  if (
    attribute?.initializer == null ||
    !ts.isJsxExpression(attribute.initializer) ||
    attribute.initializer.expression == null
  ) {
    return null;
  }
  return attribute.initializer.expression.getText(statisticsSourceFile);
};
const retainedScene = periodSceneElement as ts.JsxSelfClosingElement;
assert.equal(
  readJsxExpression(retainedScene.attributes, "active"),
  "sceneActive",
  "the retained period scene must receive the source-coherent interaction gate",
);
assert.ok(
  ts.isJsxElement(retainedScene.parent),
  "the retained period scene must have one explicit interaction wrapper",
);
const retainedSceneWrapper = retainedScene.parent as ts.JsxElement;
assert.equal(
  retainedSceneWrapper.openingElement.tagName.getText(statisticsSourceFile),
  "View",
);
assert.equal(
  readJsxExpression(
    retainedSceneWrapper.openingElement.attributes,
    "pointerEvents",
  ),
  'sceneActive ? "auto" : "none"',
  "only the source-coherent exposed Statistics scene may own drag and scroll interaction",
);
assert.doesNotMatch(
  statisticsScreen,
  /hiddenDeckMountCount|StatisticsFallbackScene|deckEnabled/,
  "Statistics must not keep invisible chart scenes mounted behind the visible presentation",
);

console.log("Settings navigation architecture audit passed.");
