import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import {
  createIOSAppModalNativeLifecycle,
  isCurrentAndroidAppModalFadeCompletion,
  reconcileIOSAppModalDesiredVisibility,
  recordIOSAppModalNativeDismissed,
  recordIOSAppModalNativeShown,
  resolveAndroidAppModalPointerEvents,
  shouldAttachAndroidAppModalHost,
  shouldDetachHiddenAndroidAppModalHost,
  type IOSAppModalNativeLifecycle,
} from "../src/components/ui/app-modal-native-lifecycle";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = `${directory}/${entry.name}`;
      return entry.isDirectory()
        ? listTypeScriptFiles(relativePath)
        : /\.tsx?$/.test(entry.name)
          ? [relativePath]
          : [];
    },
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const reanimatedCompletionCallbackIndexes = new Map([
  ["withTiming", 2],
  ["withSpring", 2],
  ["withDecay", 1],
  ["withRepeat", 3],
]);

function hasExplicitWorkletDirective(
  expression: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): boolean {
  if (!expression.body || !ts.isBlock(expression.body)) return false;
  const [firstStatement] = expression.body.statements;
  return (
    firstStatement != null &&
    ts.isExpressionStatement(firstStatement) &&
    ts.isStringLiteral(firstStatement.expression) &&
    firstStatement.expression.text === "worklet"
  );
}

function findUnsafeReanimatedCompletionCallbacks(
  fileName: string,
  source: string,
): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const namedImports = new Map<string, string>();
  const namespaceImports = new Set<string>();
  const variableInitializers = new Map<string, ts.Expression>();
  const functionDeclarations = new Map<string, ts.FunctionDeclaration>();
  const findings: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "react-native-reanimated"
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (reanimatedCompletionCallbackIndexes.has(importedName)) {
            namedImports.set(element.name.text, importedName);
          }
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaceImports.add(bindings.name.text);
      }
    }
  }

  const collectBindings = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      variableInitializers.set(node.name.text, node.initializer);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      functionDeclarations.set(node.name.text, node);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const getCompletionCallbackIndex = (
    expression: ts.LeftHandSideExpression,
  ): number | undefined => {
    const callee = unwrapExpression(expression);
    if (ts.isIdentifier(callee)) {
      const importedName = namedImports.get(callee.text);
      return importedName == null
        ? undefined
        : reanimatedCompletionCallbackIndexes.get(importedName);
    }
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaceImports.has(callee.expression.text)
    ) {
      return reanimatedCompletionCallbackIndexes.get(callee.name.text);
    }
    return undefined;
  };

  const describeUnsafeCallback = (
    callback: ts.Expression,
    seenIdentifiers = new Set<string>(),
  ): string | null => {
    const expression = unwrapExpression(callback);
    const isLogicalFunctionSelection =
      ts.isBinaryExpression(expression) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.CommaToken,
      ].includes(expression.operatorToken.kind);
    if (ts.isConditionalExpression(expression) || isLogicalFunctionSelection) {
      return "callback selected by a conditional/logical expression";
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      return hasExplicitWorkletDirective(expression)
        ? null
        : "completion callback is missing an explicit worklet directive";
    }
    if (ts.isIdentifier(expression)) {
      if (expression.text === "undefined") return null;
      if (seenIdentifiers.has(expression.text)) {
        return "completion callback resolves through a cyclic identifier";
      }
      const nextSeen = new Set(seenIdentifiers).add(expression.text);
      const initializer = variableInitializers.get(expression.text);
      if (initializer) return describeUnsafeCallback(initializer, nextSeen);
      const declaration = functionDeclarations.get(expression.text);
      if (declaration) {
        return hasExplicitWorkletDirective(declaration)
          ? null
          : "referenced completion function is missing an explicit worklet directive";
      }
      return "completion callback identifier cannot be proven to be a worklet";
    }
    return "completion callback is not an explicit, statically proven worklet";
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callbackIndex = getCompletionCallbackIndex(node.expression);
      const callback =
        callbackIndex == null ? undefined : node.arguments[callbackIndex];
      if (callback) {
        const reason = describeUnsafeCallback(callback);
        if (reason) {
          const expression = unwrapExpression(callback);
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(
            expression.getStart(sourceFile),
          );
          findings.push(`${fileName}:${line + 1}:${character + 1} (${reason})`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function assertLifecycle(
  actual: IOSAppModalNativeLifecycle,
  expected: IOSAppModalNativeLifecycle,
) {
  assert.deepEqual(actual, expected);
}

assert.equal(
  resolveAndroidAppModalPointerEvents({ visible: true, fading: false }),
  "auto",
);
assert.equal(
  resolveAndroidAppModalPointerEvents({ visible: false, fading: true }),
  "box-only",
);
assert.equal(
  resolveAndroidAppModalPointerEvents({ visible: false, fading: false }),
  "none",
  "a hidden non-fading full-screen host must never intercept the next route",
);
assert.equal(
  shouldDetachHiddenAndroidAppModalHost({
    visible: false,
    retainHiddenHost: false,
    portalMounted: true,
  }),
  true,
  "revoking hidden-host retention must physically detach the portal",
);
assert.equal(
  shouldDetachHiddenAndroidAppModalHost({
    visible: false,
    retainHiddenHost: true,
    portalMounted: true,
  }),
  false,
);
assert.equal(
  shouldAttachAndroidAppModalHost({
    visible: false,
    retainHiddenHost: true,
    portalMounted: false,
  }),
  true,
  "a refocused route must reacquire its explicitly retained hidden host",
);
assert.equal(
  shouldAttachAndroidAppModalHost({
    visible: false,
    retainHiddenHost: false,
    portalMounted: false,
  }),
  false,
);
assert.equal(
  shouldAttachAndroidAppModalHost({
    visible: true,
    retainHiddenHost: false,
    portalMounted: false,
  }),
  true,
);
assert.equal(
  shouldDetachHiddenAndroidAppModalHost({
    visible: true,
    retainHiddenHost: false,
    portalMounted: true,
  }),
  false,
);
assert.equal(isCurrentAndroidAppModalFadeCompletion(4, true, 4, true), true);
assert.equal(isCurrentAndroidAppModalFadeCompletion(4, false, 4, false), true);
assert.equal(
  isCurrentAndroidAppModalFadeCompletion(5, true, 4, true),
  false,
  "a stale opening completion must not publish into a newer generation",
);
assert.equal(
  isCurrentAndroidAppModalFadeCompletion(5, true, 5, false),
  false,
  "a stale closing completion must not dismiss a reopened portal",
);

const hidden = createIOSAppModalNativeLifecycle(false);
assertLifecycle(hidden, {
  desiredVisible: false,
  generation: 0,
  nativeVisible: false,
  phase: "hidden",
});

const presenting = reconcileIOSAppModalDesiredVisibility(hidden, true);
assertLifecycle(presenting, {
  desiredVisible: true,
  generation: 1,
  nativeVisible: true,
  phase: "presenting",
});

const closeDuringPresentation = reconcileIOSAppModalDesiredVisibility(
  presenting,
  false,
);
assertLifecycle(closeDuringPresentation, {
  desiredVisible: false,
  generation: 1,
  nativeVisible: true,
  phase: "presenting",
});
const shownOnlyToDismiss = recordIOSAppModalNativeShown(
  closeDuringPresentation,
  1,
);
assert.equal(shownOnlyToDismiss.accepted, true);
assertLifecycle(shownOnlyToDismiss.state, {
  desiredVisible: false,
  generation: 1,
  nativeVisible: false,
  phase: "dismissing",
});
const fullyDismissed = recordIOSAppModalNativeDismissed(
  shownOnlyToDismiss.state,
  1,
);
assert.equal(fullyDismissed.accepted, true);
assert.equal(fullyDismissed.reopened, false);
assertLifecycle(fullyDismissed.state, {
  desiredVisible: false,
  generation: 1,
  nativeVisible: false,
  phase: "hidden",
});

const presentationReversedTwice = reconcileIOSAppModalDesiredVisibility(
  closeDuringPresentation,
  true,
);
const stableShown = recordIOSAppModalNativeShown(presentationReversedTwice, 1);
assert.equal(stableShown.accepted, true);
assertLifecycle(stableShown.state, {
  desiredVisible: true,
  generation: 1,
  nativeVisible: true,
  phase: "shown",
});

const dismissing = reconcileIOSAppModalDesiredVisibility(
  stableShown.state,
  false,
);
assertLifecycle(dismissing, {
  desiredVisible: false,
  generation: 1,
  nativeVisible: false,
  phase: "dismissing",
});
const queuedReopen = reconcileIOSAppModalDesiredVisibility(dismissing, true);
assertLifecycle(queuedReopen, {
  desiredVisible: true,
  generation: 1,
  nativeVisible: false,
  phase: "dismissing",
});
const reopened = recordIOSAppModalNativeDismissed(queuedReopen, 1);
assert.equal(reopened.accepted, true);
assert.equal(reopened.reopened, true);
assertLifecycle(reopened.state, {
  desiredVisible: true,
  generation: 2,
  nativeVisible: true,
  phase: "presenting",
});
assert.strictEqual(
  reconcileIOSAppModalDesiredVisibility(reopened.state, true),
  reopened.state,
);

const staleDismiss = recordIOSAppModalNativeDismissed(reopened.state, 1);
assert.equal(staleDismiss.accepted, false);
assert.strictEqual(staleDismiss.state, reopened.state);
const staleShow = recordIOSAppModalNativeShown(reopened.state, 1);
assert.equal(staleShow.accepted, false);
assert.strictEqual(staleShow.state, reopened.state);
const reopenedShown = recordIOSAppModalNativeShown(reopened.state, 2);
assert.equal(reopenedShown.accepted, true);
assertLifecycle(reopenedShown.state, {
  desiredVisible: true,
  generation: 2,
  nativeVisible: true,
  phase: "shown",
});

const cancelQueuedReopen = reconcileIOSAppModalDesiredVisibility(
  queuedReopen,
  false,
);
const staysHidden = recordIOSAppModalNativeDismissed(cancelQueuedReopen, 1);
assert.equal(staysHidden.reopened, false);
assertLifecycle(staysHidden.state, {
  desiredVisible: false,
  generation: 1,
  nativeVisible: false,
  phase: "hidden",
});

const appModal = read("src/components/ui/AppModal.tsx");
const dialog = read("src/components/ui/Dialog.tsx");
const dropdownMenu = read("src/components/overlays/DropdownMenu.tsx");
const contextMenu = read("src/components/overlays/ContextMenu.tsx");
assert.match(
  appModal,
  /resolveAndroidAppModalPointerEvents\(\{[\s\S]{0,100}visible,[\s\S]{0,100}fading: shouldFade/,
  "Android portal hit testing must distinguish a closing fade from every other hidden host",
);
assert.match(
  appModal,
  /shouldDetachHiddenAndroidAppModalHost\(\{[\s\S]{0,220}retainHiddenHost: shouldRetainAndroidPortal[\s\S]{0,520}setPortalVisibility\(false\)/,
  "revoking retention after an already-completed hidden generation must detach the Android portal",
);
assert.match(
  appModal,
  /shouldAttachAndroidAppModalHost\(\{[\s\S]{0,220}retainHiddenHost: shouldRetainAndroidPortal[\s\S]{0,260}setPortalVisibility\(true\)/,
  "regaining focus must reacquire a requested hidden Android portal host",
);
assert.match(
  appModal,
  /importantForAccessibility=\{[\s\S]{0,80}visible \? "yes" : "no-hide-descendants"/,
  "a retained empty Android host must be hidden from accessibility",
);
assert.match(
  appModal,
  /needsOffscreenAlphaCompositing=\{androidFadeCompositingActive\}[\s\S]{0,120}renderToHardwareTextureAndroid=\{androidFadeCompositingActive\}/,
  "the proven Android host fade must preserve one grouped opacity composition while its animation is active",
);
assert.match(
  appModal,
  /if \(!androidFadeCompositingActive\) \{\s*setAndroidFadeCompositingActive\(true\);\s*return;\s*\}[\s\S]{0,220}androidFadePortalCommit\?\.generation !== transition\.generation/,
  "the fade must first request group compositing and then wait for the matching physical portal commit",
);
assert.match(
  appModal,
  /function AndroidFadeCommitMarker\([\s\S]{0,420}React\.useLayoutEffect\([\s\S]{0,160}onCommit\(transition\)/,
  "the group-compositing acknowledgement must come from the committed portal subtree",
);
assert.match(
  appModal,
  /return shouldRetainAndroidPortal \|\| shouldFade \? \(\s*<LayoutSynchronizedPortal>/,
  "retained hosts and grouped fades must publish portal changes during the layout phase",
);
assert.doesNotMatch(
  `${appModal}\n${dialog}`,
  /AppModalFadeLayer|androidFadeRendering|useSharedValue|withTiming|lifecycleMountedRef/,
  "Dialog must not add a second fade or mounted-state owner on top of AppModal",
);
assert.match(
  dialog,
  /width: Math\.min\(sizes\.dialogWidth, windowWidth - 32\)/,
  "standard Dialog geometry must keep the proven shared 304dp width with a window-safe cap",
);
assert.doesNotMatch(
  `${dropdownMenu}\n${contextMenu}`,
  /useAnimatedReaction/,
  "product menu components must not own diagnostic UI-thread subscriptions",
);
for (const [source, owner] of [
  [dropdownMenu, "dropdown"],
  [contextMenu, "context menu"],
] as const) {
  assert.match(
    source,
    /pointerEvents=\{visible && !isClosing \? "auto" : "box-only"\}/,
    `the closing ${owner} must block descendants and touch-through from the first closing frame until its custom animation unmounts`,
  );
  assert.match(
    source,
    /if \(closeStartedRef\.current\)[\s\S]{0,60}return false;/,
    `the ${owner} close transition must reject a later rapid action`,
  );
  assert.ok(
    (source.match(/if \(!beginClose\(\)\)\s*return/g) ?? []).length >= 3,
    `the ${owner} must not run dismiss or item callbacks after another close already won`,
  );
  assert.match(
    source,
    /if \(!isReversingClose\) \{\s*menuProgress\.value = 0;\s*scrimProgress\.value = 0;/,
    `a ${owner} close-to-open reversal must preserve the already painted animation progress`,
  );
  assert.match(
    source,
    /if \(usesIOSNativeHost\) \{[\s\S]{0,320}nativeDismissGenerationRef\.current = generation;[\s\S]{0,120}setNativeDismissPending\(true\);[\s\S]{0,80}return;/,
    `the ${owner} must keep its iOS native host alive after the custom close animation`,
  );
  assert.match(
    source,
    /visible=\{shouldMount && !nativeDismissPending\}[\s\S]{0,160}onDismiss=\{usesIOSNativeHost \? finishNativeDismiss : undefined\}/,
    `the ${owner} must wait for the old native Modal onDismiss before handing off to another overlay`,
  );
  assert.match(
    source,
    /const finalizeClose[\s\S]{0,1200}pendingActivation\.onPress\(\);[\s\S]{0,120}finally \{[\s\S]{0,400}onCloseRef\.current\(\);/,
    `the ${owner} deferred command must run exactly once and always retire parent visibility`,
  );
  assert.match(
    source,
    /useLayoutEffect\(\s*\(\) => \(\) => \{[\s\S]{0,220}transitionGenerationRef\.current \+= 1;[\s\S]{0,220}cancelAnimation\(menuProgress\);[\s\S]{0,120}cancelAnimation\(scrimProgress\);/,
    `the ${owner} must invalidate and cancel UI-thread completions before an owner-unmount paint`,
  );
}
assert.doesNotMatch(
  appModal,
  /react-native-reanimated|useAnimatedReaction|withTiming|\bcancelAnimation\(|runOnJS/,
  "the generic modal fade must not depend on a Worklets completion callback",
);
assert.match(
  appModal,
  /if \(!usesAndroidPortal \|\| !androidPortalMounted\)\s*return;[\s\S]{0,180}hardwareBackPress[\s\S]{0,520}return shouldRetainAndroidPortal \? false : true;/,
  "the closing Android portal must consume hardware back until unmounted while a retained empty host stays inert",
);
assert.match(
  appModal,
  /const nativeModalVisible = usesIOSNativeModal[\s\S]{0,120}iosNativeLifecycle\.nativeVisible[\s\S]{0,100}<Modal[\s\S]{0,80}visible=\{nativeModalVisible\}/,
  "iOS native visibility must be owned by the serialized lifecycle",
);
assert.match(
  appModal,
  /usesIOSNativeModal &&[\s\S]{0,180}iosNativeLifecycleRef\.current\.phase === "dismissing"[\s\S]{0,80}return;/,
  "a departing iOS modal must ignore a stale native close callback",
);
assert.match(
  appModal,
  /pointerEvents=\{[\s\S]{0,120}visible && !iosNativeSceneDeparting \? "auto" : "box-only"[\s\S]{0,40}\}/,
  "a queued iOS reopen must not reactivate the departing modal's children",
);
assert.match(
  appModal,
  /recordIOSAppModalNativeDismissed\([\s\S]{0,300}if \(nativeEvent\.reopened\)\s*return;/,
  "a queued iOS reopen must wait for and consume native onDismiss",
);
assert.match(
  appModal,
  /const iosNativeSceneDeparting =[\s\S]{0,180}iosNativeLifecycle\.phase === "dismissing"/,
  "the iOS departing state must include the serialized native dismiss phase",
);
assert.match(
  appModal,
  /const androidFadeSceneDeparting =[\s\S]{0,100}shouldFade && !visible;/,
  "the Android departing state must cover the complete grouped fade-out",
);
assert.match(
  appModal,
  /const stableDepartingPresentationRef = React\.useRef\([\s\S]{0,80}currentModalPresentation[\s\S]{0,180}const modalPresentation = modalSceneDeparting[\s\S]{0,100}stableDepartingPresentationRef\.current[\s\S]{0,80}: currentModalPresentation;/,
  "a departing native modal or Android fade must retain one committed semantic and visual presentation",
);
assert.ok(
  (appModal.match(/\{modalPresentation\.children\}/g) ?? []).length >= 2,
  "both the Android portal and iOS native modal must paint the retained departing payload",
);
assert.match(
  appModal,
  /const currentVisualPreferences = React\.useMemo<VisualPreferencesSnapshot>[\s\S]{0,420}visualTheme[\s\S]{0,120}visualEffectiveMode[\s\S]{0,120}visualColorScheme[\s\S]{0,120}visualLanguage/,
  "the retained payload must include one coherent source-scene visual snapshot",
);
assert.ok(
  (appModal.match(/\.\.\.modalPresentation\.visualPreferences/g) ?? [])
    .length >= 2,
  "both the Android portal and iOS native modal must use the retained visual snapshot",
);
assert.match(
  appModal,
  /<ThemeVariablesProvider\s+effectiveMode=\{modalPresentation\.visualPreferences\.effectiveMode\}\s*>/,
  "Android NativeWind variables must stay in the same departing visual snapshot",
);
assert.match(
  appModal,
  /const androidImmediateCompletedRef =[\s\S]{0,300}\{ generation: 0, visible \}/,
  "a retained immediate Android host must seed the already-hidden generation",
);
assert.match(
  appModal,
  /if \(!shouldFade\) \{\s*const completed = androidImmediateCompletedRef\.current;[\s\S]{0,220}completed\?\.generation === transition\.generation[\s\S]{0,160}completed\.visible === visible[\s\S]{0,900}return;/,
  "a completed non-fading Android generation must detach on retention revocation without fabricating a second dismiss completion",
);
assert.match(
  appModal,
  /Animated\.timing\(opacity, \{\s*toValue: 1,\s*duration: 150,\s*easing: Easing\.inOut\(Easing\.ease\),\s*useNativeDriver: true/,
  "the tuned Android opening fade must remain unchanged",
);
assert.match(
  appModal,
  /Animated\.timing\(opacity, \{\s*toValue: 0,\s*duration: 120,\s*easing: Easing\.inOut\(Easing\.ease\),\s*useNativeDriver: true/,
  "the tuned Android closing fade must remain unchanged",
);
assert.match(
  appModal,
  /if \(!portalHostCommitted\)\s*return;[\s\S]{0,100}opacity\.stopAnimation\(\);/,
  "the Android fade may start only after @gorhom/portal commits its native host",
);
assert.match(
  appModal,
  /const setPortalHostNode = React\.useCallback\([\s\S]{0,1800}setPortalHostCommitted\(true\)/,
  "the product lifecycle must observe the actual detached Portal host commit",
);
assert.match(
  appModal,
  /<Animated\.View\s+ref=\{setPortalHostNode\}/,
  "the Portal commit gate must be attached to the physical animated host",
);
assert.match(
  appModal,
  /if \(usesAndroidPortal && shouldFade\) \{[\s\S]{0,380}opacity\.stopAnimation\(\);[\s\S]{0,180}setAndroidFadeIntent/,
  "a reversal must stop the previous native-driver fade before publishing the replacement intent",
);
assert.match(
  appModal,
  /React\.useLayoutEffect\([\s\S]{0,220}\(\) => \(\) => \{\s*opacity\.stopAnimation\(\);/,
  "unmount must stop the native-driver fade",
);
assert.match(
  appModal,
  /isCurrentAndroidAppModalFadeCompletion\([\s\S]{0,180}state === "shown"/,
  "only the current generation and direction may complete an Android fade",
);
assert.match(
  appModal,
  /\.start\(\(\{ finished \}\) => \{\s*if \(!finished\)\s*return;/,
  "interrupted native-driver fades must not publish a terminal modal state",
);
assert.doesNotMatch(
  appModal,
  /lifecycleMountedRef/,
  "AppModal must not carry a second mounted-state lifecycle solely to reinterpret interrupted fades",
);

const unsafeFixture = findUnsafeReanimatedCompletionCallbacks(
  "unsafe-fixture.ts",
  'import { withTiming } from "react-native-reanimated";\nwithTiming(1, {}, enabled ? () => {} : undefined);',
);
assert.equal(
  unsafeFixture.length,
  1,
  "the regression guard must recognize a conditional withTiming callback",
);
const unsafeVariableFixture = findUnsafeReanimatedCompletionCallbacks(
  "unsafe-variable-fixture.ts",
  'import * as Reanimated from "react-native-reanimated";\nconst callback = enabled ? () => {} : undefined;\nReanimated.withTiming(1, {}, callback);',
);
assert.equal(
  unsafeVariableFixture.length,
  1,
  "the regression guard must follow a callback selected through a variable and namespace import",
);
const safeAliasFixture = findUnsafeReanimatedCompletionCallbacks(
  "safe-alias-fixture.ts",
  'import { withTiming as animate } from "react-native-reanimated";\nconst callback = () => { "worklet"; };\nanimate(1, {}, callback);',
);
assert.deepEqual(
  safeAliasFixture,
  [],
  "an explicitly workletized callback may be passed through a proven alias",
);
const unsafeProjectCallbacks = [
  ...listTypeScriptFiles("app"),
  ...listTypeScriptFiles("src"),
].flatMap((fileName) =>
  findUnsafeReanimatedCompletionCallbacks(fileName, read(fileName)),
);
assert.deepEqual(
  unsafeProjectCallbacks,
  [],
  `Reanimated completion callbacks must be statically proven worklets and must not be selected through conditional/logical expressions: ${unsafeProjectCallbacks.join(
    ", ",
  )}`,
);

const packageLock = JSON.parse(read("package-lock.json")) as {
  packages: Record<string, { version?: string }>;
};
const reactNativePackage = JSON.parse(
  read("node_modules/react-native/package.json"),
) as { version: string };
assert.equal(reactNativePackage.version, "0.81.5");
assert.equal(
  reactNativePackage.version,
  packageLock.packages["node_modules/react-native"]?.version,
  "the audited React Native modal implementation must match the lockfile",
);
const reactNativeModal = read(
  "node_modules/react-native/Libraries/Modal/Modal.js",
);
assert.match(
  reactNativeModal,
  /const onDismiss = \(\) => \{[\s\S]{0,160}this\.setState\(\{isRendered: false\}, \(\) => \{[\s\S]{0,100}this\.props\.onDismiss\(\)/,
  "React Native must deliver AppModal onDismiss only after retiring the dismissed host",
);
const androidPointerEvents = read(
  "node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/PointerEvents.kt",
);
assert.match(
  androidPointerEvents,
  /canBeTouchTarget[\s\S]{0,140}pointerEvents == AUTO \|\| pointerEvents == BOX_ONLY/,
  "React Native box-only must make the closing portal host a touch target",
);
assert.match(
  androidPointerEvents,
  /canChildrenBeTouchTarget[\s\S]{0,140}pointerEvents == AUTO \|\| pointerEvents == BOX_NONE/,
  "React Native box-only must exclude stale closing-portal descendants",
);
const fabricModalHost = read(
  "node_modules/react-native/React/Fabric/Mounting/ComponentViews/Modal/RCTModalHostViewComponentView.mm",
);
assert.match(
  fabricModalHost,
  /_isPresented = NO;[\s\S]{0,400}dismissViewController:[\s\S]{0,180}completion:\^\{[\s\S]{0,240}eventEmitter->onDismiss/,
  "the reviewed Fabric host clears presentation state before asynchronous dismissal completes",
);

interface ModalElement {
  type: unknown;
  props: Record<string, unknown>;
}

function auditNativeModalPresentation(source: string): void {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effectDependencies: (readonly unknown[] | undefined)[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  let dirty = false;
  let pendingEffects: (() => unknown)[] = [];
  let liveMode: "light" | "dark" = "light";
  let dismissCount = 0;
  const react = {
    createContext: () => ({ Provider: "ContextProvider" }),
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): ModalElement => ({
      type,
      props: {
        ...props,
        children: children.length === 1 ? children[0] : children,
      },
    }),
    useContext: () => null,
    useRef: <T>(initial: T) =>
      refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    useState: <T>(initial: T | (() => T)) => {
      const index = stateIndex++;
      if (!(index in states))
        states[index] =
          typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        states[index],
        (next: unknown) => {
          const resolved =
            typeof next === "function" ? next(states[index]) : next;
          if (!Object.is(resolved, states[index])) {
            states[index] = resolved;
            dirty = true;
          }
        },
      ];
    },
    useMemo: <T>(create: () => T) => create(),
    useCallback: <T>(callback: T) => callback,
    useLayoutEffect: (
      effect: () => unknown,
      dependencies?: readonly unknown[],
    ) => {
      const index = effectIndex++;
      const previous = effectDependencies[index];
      if (
        !dependencies ||
        !previous ||
        dependencies.some((value, entry) => !Object.is(value, previous[entry]))
      ) {
        pendingEffects.push(effect);
      }
      effectDependencies[index] = dependencies;
    },
    useEffect: () => {},
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const isolated = {
    exports: {} as {
      AppModal: (props: Record<string, unknown>) => ModalElement;
    },
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (name === "react") return react;
      if (name === "react-native")
        return {
          Platform: { OS: "ios" },
          Modal: "Modal",
          View: "View",
          Animated: {
            Value: class {
              stopAnimation() {}
            },
          },
          StyleSheet: { create: <T>(styles: T) => styles },
        };
      if (name === "@gorhom/portal") return {};
      if (name === "@/components/ScreenPreferencesBoundary")
        return {
          VisualPreferencesSnapshotProvider:
            "VisualPreferencesSnapshotProvider",
          useVisualTheme: () => liveMode,
          useVisualEffectiveMode: () => liveMode,
          useVisualColorScheme: () => "orange",
          useVisualLanguage: () => "en",
        };
      if (name === "@/theme/provider")
        return { ThemeVariablesProvider: "ThemeVariablesProvider" };
      if (name === "@/components/ui/app-modal-native-lifecycle")
        return {
          createIOSAppModalNativeLifecycle,
          reconcileIOSAppModalDesiredVisibility,
          recordIOSAppModalNativeShown,
          recordIOSAppModalNativeDismissed,
        };
      throw new Error(`Unexpected modal fixture import: ${name}`);
    },
    isolated,
    isolated.exports,
  );
  const render = (
    visible: boolean,
    mode: "light" | "dark",
    children: string,
  ): ModalElement => {
    liveMode = mode;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      dirty = false;
      pendingEffects = [];
      const element = isolated.exports.AppModal({
        visible,
        animationType: "none",
        children,
        onDismiss: () => {
          dismissCount += 1;
        },
      });
      for (const effect of pendingEffects) effect();
      if (!dirty) return element;
    }
    throw new Error("Modal fixture did not converge after layout effects");
  };
  const check = (
    element: ModalElement,
    mode: "light" | "dark",
    children: string,
    interactive: boolean,
  ) => {
    assert.equal(element.type, "Modal");
    const visual = element.props.children as ModalElement;
    assert.equal(visual.type, "VisualPreferencesSnapshotProvider");
    assert.equal(visual.props.effectiveMode, mode);
    const variables = visual.props.children as ModalElement;
    assert.equal(
      variables.type,
      "ThemeVariablesProvider",
      "native modal must own its retained variable snapshot",
    );
    assert.equal(
      variables.props.effectiveMode,
      mode,
      "native variables must follow the same retained visual mode",
    );
    const fragment = variables.props.children as ModalElement;
    const content = fragment.props.children as ModalElement;
    assert.equal(content.type, "View");
    assert.deepEqual(
      content.props.style,
      { flex: 1 },
      "the existing native content geometry must remain unchanged",
    );
    assert.equal(content.props.collapsable, false);
    assert.equal(content.props.children, children);
    assert.equal(
      content.props.pointerEvents,
      interactive ? "auto" : "box-only",
    );
    assert.equal(content.props.accessibilityElementsHidden, !interactive);
    assert.equal(
      content.props.importantForAccessibility,
      interactive ? "yes" : "no-hide-descendants",
    );
  };
  let element = render(true, "light", "first");
  (element.props.onShow as (event: unknown) => void)({ nativeEvent: {} });
  element = render(true, "light", "first");
  check(element, "light", "first", true);
  element = render(false, "dark", "next");
  check(element, "light", "first", false);
  assert.equal(element.props.visible, false);
  element = render(true, "dark", "next");
  check(element, "light", "first", false);
  assert.equal(
    element.props.visible,
    false,
    "a queued reopen cannot expose the departing native controller",
  );
  (element.props.onDismiss as () => void)();
  assert.equal(
    dismissCount,
    0,
    "a queued reopen consumes the departing dismissal callback",
  );
  element = render(true, "dark", "next");
  check(element, "dark", "next", true);
  assert.equal(element.props.visible, true);
  (element.props.onShow as (event: unknown) => void)({ nativeEvent: {} });
  element = render(true, "dark", "next");
  element = render(false, "light", "third");
  check(element, "dark", "next", false);
  (element.props.onDismiss as () => void)();
  assert.equal(dismissCount, 1);
}

function auditAndroidModalPresentation(source: string): void {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effectDependencies: (readonly unknown[] | undefined)[] = [];
  const effectCleanups: (() => void)[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  let dirty = false;
  let pendingEffects: (() => void)[] = [];
  let liveMode: "light" | "dark" = "light";
  let showCount = 0;
  let dismissCount = 0;
  let backHandler: (() => boolean) | undefined;
  const animations: {
    config: { toValue: number; duration: number; useNativeDriver: boolean };
    complete(result: { finished: boolean }): void;
  }[] = [];
  const effect = (
    callback: () => unknown,
    dependencies?: readonly unknown[],
  ) => {
    const index = effectIndex++;
    const previous = effectDependencies[index];
    if (
      !dependencies ||
      !previous ||
      dependencies.some((value, item) => !Object.is(value, previous[item]))
    ) {
      pendingEffects.push(() => {
        effectCleanups[index]?.();
        const cleanup = callback();
        effectCleanups[index] =
          typeof cleanup === "function"
            ? (cleanup as () => void)
            : () => undefined;
      });
    }
    effectDependencies[index] = dependencies;
  };
  const react = {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): ModalElement => ({
      type,
      props: {
        ...props,
        children: children.length === 1 ? children[0] : children,
      },
    }),
    useRef: <T>(initial: T) =>
      refs[refIndex++] ?? (refs[refIndex - 1] = { current: initial }),
    useState: <T>(initial: T | (() => T)) => {
      const index = stateIndex++;
      if (!(index in states))
        states[index] =
          typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        states[index],
        (next: unknown) => {
          const resolved =
            typeof next === "function" ? next(states[index]) : next;
          if (!Object.is(resolved, states[index])) {
            states[index] = resolved;
            dirty = true;
          }
        },
      ];
    },
    useMemo: <T>(create: () => T) => create(),
    useCallback: <T>(callback: T) => callback,
    useLayoutEffect: effect,
    useEffect: effect,
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const isolated = {
    exports: {} as {
      AppModal: (props: Record<string, unknown>) => ModalElement | null;
    },
  };
  new Function("require", "module", "exports", compiled)(
    (name: string) => {
      if (name === "react") return react;
      if (name === "react-native")
        return {
          Platform: { OS: "android" },
          Modal: "Modal",
          View: "View",
          Animated: {
            View: "AnimatedView",
            Value: class {
              stopAnimation() {}
              setValue() {}
            },
            timing: (
              _value: unknown,
              config: (typeof animations)[number]["config"],
            ) => ({
              start: (complete: (typeof animations)[number]["complete"]) =>
                animations.push({ config, complete }),
            }),
          },
          BackHandler: {
            addEventListener: (_event: string, callback: () => boolean) => {
              backHandler = callback;
              return {
                remove: () => {
                  if (backHandler === callback) backHandler = undefined;
                },
              };
            },
          },
          Easing: { ease: "ease", inOut: (value: unknown) => value },
          StyleSheet: {
            create: <T>(styles: T) => styles,
            absoluteFillObject: {},
          },
        };
      if (name === "@gorhom/portal") return { Portal: "Portal" };
      if (name === "@/components/ScreenPreferencesBoundary")
        return {
          VisualPreferencesSnapshotProvider:
            "VisualPreferencesSnapshotProvider",
          useVisualTheme: () => liveMode,
          useVisualEffectiveMode: () => liveMode,
          useVisualColorScheme: () => "orange",
          useVisualLanguage: () => "en",
        };
      if (name === "@/theme/provider")
        return { ThemeVariablesProvider: "ThemeVariablesProvider" };
      if (name === "@/components/ui/app-modal-native-lifecycle")
        return {
          createIOSAppModalNativeLifecycle,
          reconcileIOSAppModalDesiredVisibility,
          recordIOSAppModalNativeShown,
          recordIOSAppModalNativeDismissed,
          resolveAndroidAppModalPointerEvents,
          shouldAttachAndroidAppModalHost,
          shouldDetachHiddenAndroidAppModalHost,
          isCurrentAndroidAppModalFadeCompletion,
        };
      throw new Error(`Unexpected Android modal fixture import: ${name}`);
    },
    isolated,
    isolated.exports,
  );
  const render = (
    visible: boolean,
    mode: "light" | "dark",
    children: string,
    animationType = "fade",
    keepMountedOnAndroid = false,
  ): ModalElement | null => {
    liveMode = mode;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      dirty = false;
      pendingEffects = [];
      const element = isolated.exports.AppModal({
        visible,
        animationType,
        keepMountedOnAndroid,
        children,
        onShow: () => {
          showCount += 1;
        },
        onDismiss: () => {
          dismissCount += 1;
        },
      });
      if (element) {
        const visual = element.props.children as ModalElement;
        const variables = visual.props.children as ModalElement;
        const host = variables.props.children as ModalElement;
        assert.equal(host.type, "AnimatedView");
        (host.props.ref as (node: unknown) => void)({});
        const [marker] = host.props.children as (ModalElement | null)[];
        if (marker?.props.compositingActive) {
          (marker.props.onCommit as (transition: unknown) => void)(
            marker.props.transition,
          );
        }
      }
      for (const run of pendingEffects) run();
      if (!dirty) return element;
    }
    throw new Error(
      "Android modal fixture did not converge after portal commits",
    );
  };
  const check = (
    element: ModalElement | null,
    mode: "light" | "dark",
    children: string,
    pointerEvents: string,
  ) => {
    assert.ok(element);
    const visual = element.props.children as ModalElement;
    assert.equal(visual.props.effectiveMode, mode);
    const variables = visual.props.children as ModalElement;
    assert.equal(variables.props.effectiveMode, mode);
    const host = variables.props.children as ModalElement;
    assert.equal(host.props.pointerEvents, pointerEvents);
    const [, fragment] = host.props.children as ModalElement[];
    const content = fragment.props.children as ModalElement;
    assert.equal(content.props.children, children);
  };
  let element = render(true, "light", "first");
  assert.equal(
    animations.length,
    1,
    "the committed Android host must start its opening native fade",
  );
  assert.deepEqual(animations[0].config, {
    toValue: 1,
    duration: 150,
    easing: "ease",
    useNativeDriver: true,
  });
  check(element, "light", "first", "auto");
  animations[0].complete({ finished: true });
  render(true, "light", "first");
  assert.equal(showCount, 1);
  assert.equal(
    animations.length,
    1,
    "a completed generation must not restart its fade",
  );

  element = render(false, "dark", "second");
  assert.equal(animations.length, 2);
  assert.deepEqual(animations[1].config, {
    toValue: 0,
    duration: 120,
    easing: "ease",
    useNativeDriver: true,
  });
  check(element, "light", "first", "box-only");
  assert.equal(
    backHandler?.(),
    true,
    "a fading-out portal must still consume hardware Back",
  );
  animations[1].complete({ finished: false });
  assert.equal(
    dismissCount,
    0,
    "an interrupted fade must not dismiss the portal",
  );

  element = render(true, "dark", "second");
  assert.equal(animations.length, 3);
  check(element, "dark", "second", "auto");
  animations[1].complete({ finished: true });
  element = render(true, "dark", "second");
  check(element, "dark", "second", "auto");
  assert.equal(
    dismissCount,
    0,
    "a stale close completion must not detach the reopened portal",
  );
  animations[2].complete({ finished: true });
  render(true, "dark", "second");
  assert.equal(showCount, 2);
  render(false, "light", "third");
  assert.equal(animations.length, 4);
  animations[3].complete({ finished: true });
  assert.equal(render(false, "light", "third"), null);
  assert.equal(dismissCount, 1);
  assert.equal(
    backHandler,
    undefined,
    "a physically detached host must release hardware Back",
  );

  for (const cleanup of effectCleanups) cleanup();
  states.length = 0;
  refs.length = 0;
  effectDependencies.length = 0;
  effectCleanups.length = 0;
  element = render(false, "light", "idle", "none", true);
  check(element, "light", "idle", "none");
  assert.equal(
    (backHandler as (() => boolean) | undefined)?.(),
    false,
    "an empty retained host must not intercept hardware Back",
  );
  assert.equal(render(false, "light", "idle", "none", false), null);
  assert.equal(
    dismissCount,
    1,
    "revoking retention must not fabricate a second dismissal",
  );
}

auditNativeModalPresentation(appModal);
auditAndroidModalPresentation(appModal);
const appModalTree = ts.createSourceFile(
  "AppModal.tsx",
  appModal,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const nativeFadeCommands: string[] = [];
const collectNativeFadeCommands = (node: ts.Node): void => {
  if (
    ts.isExpressionStatement(node) &&
    /^Animated\.timing\(opacity,/.test(node.getText(appModalTree))
  ) {
    nativeFadeCommands.push(node.getText(appModalTree));
  }
  ts.forEachChild(node, collectNativeFadeCommands);
};
collectNativeFadeCommands(appModalTree);
assert.equal(
  nativeFadeCommands.length,
  2,
  "opening and closing must each issue a native fade command",
);
for (const command of nativeFadeCommands) {
  assert.throws(
    () => auditAndroidModalPresentation(appModal.replace(command, "void 0;")),
    (error: unknown) => error instanceof assert.AssertionError,
    "removing a native fade must fail the executed Android lifecycle",
  );
}
const nativeBranchIndex = appModal.indexOf("  const nativeModalGeneration =");
assert.ok(nativeBranchIndex > 0);
const androidBranch = appModal.slice(0, nativeBranchIndex);
const nativeBranch = appModal.slice(nativeBranchIndex);
for (const mutated of [
  nativeBranch
    .replace(
      /<ThemeVariablesProvider\s+effectiveMode=\{modalPresentation\.visualPreferences\.effectiveMode\}\s*>/,
      "<>",
    )
    .replace("</ThemeVariablesProvider>", "</>"),
  nativeBranch.replace(
    "effectiveMode={modalPresentation.visualPreferences.effectiveMode}",
    "effectiveMode={visualEffectiveMode}",
  ),
]) {
  assert.notEqual(
    mutated,
    nativeBranch,
    "modal mutation must match its native branch",
  );
  assert.throws(
    () => auditNativeModalPresentation(androidBranch + mutated),
    (error: unknown) => error instanceof assert.AssertionError,
    "native variable mutations must violate executed retained-presentation assertions",
  );
}

console.log("App modal native lifecycle audit passed.");
