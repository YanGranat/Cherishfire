import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import {
  loadAppContentForAudit,
  loadStartupForAudit,
  type AppContentAuditEvent,
  type AppContentAuditRoute,
  type AppContentAuditRouteState,
  type StartupAuditHarness,
  type StartupAuditSourceOptions,
  validateAppContentAuditSourceTransform,
  validateStartupAuditSourceTransform,
} from "./fixtures/load-startup-for-audit";

const SCENARIO_TIMEOUT_MS = 5_000;

interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function applySourceEdits(
  source: string,
  edits: readonly SourceEdit[],
): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(
      ordered[index - 1].start >= ordered[index].end,
      "startup source edits must not overlap",
    );
  }
  return ordered.reduce(
    (current, edit) =>
      `${current.slice(0, edit.start)}${edit.replacement}${current.slice(
        edit.end,
      )}`,
    source,
  );
}

function getMigratedAppFunction(source: string): {
  sourceFile: ts.SourceFile;
  declaration: ts.FunctionDeclaration;
} {
  const sourceFile = ts.createSourceFile(
    "app/_layout.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "MigratedApp",
  );
  assert.equal(matches.length, 1, "MigratedApp must have one declaration");
  assert.ok(matches[0].body, "MigratedApp must have a function body");
  return { sourceFile, declaration: matches[0] };
}

function findFinalStartupGate(
  sourceFile: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
): ts.IfStatement {
  const matches = declaration.body!.statements.filter(
    (statement): statement is ts.IfStatement => {
      if (!ts.isIfStatement(statement)) return false;
      const condition = statement.expression.getText(sourceFile);
      return (
        condition.includes("!success") &&
        condition.includes("!bootstrapReady") &&
        !condition.includes("settingsLoadFailed")
      );
    },
  );
  assert.equal(matches.length, 1, "the final startup gate must be unique");
  return matches[0];
}

function declaresIdentifier(
  statement: ts.Statement,
  expectedName: string,
): boolean {
  return (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === expectedName,
    )
  );
}

function restorePostBootstrapLoadingGate(source: string): string {
  const { sourceFile, declaration } = getMigratedAppFunction(source);
  const finalGate = findFinalStartupGate(sourceFile, declaration);
  const condition = finalGate.expression.getText(sourceFile);
  assert.ok(
    !condition.includes("settingsLoading"),
    "the intended source must not already gate AppContent on settingsLoading",
  );

  const edits: SourceEdit[] = [
    {
      start: finalGate.expression.getStart(sourceFile),
      end: finalGate.expression.getEnd(),
      replacement: `(${condition}) || settingsLoading`,
    },
  ];
  const statements = declaration.body!.statements;
  if (
    !statements.some((statement) =>
      declaresIdentifier(statement, "settingsLoading"),
    )
  ) {
    const loadSettingsStatement = statements.find((statement) =>
      declaresIdentifier(statement, "loadSettings"),
    );
    assert.ok(loadSettingsStatement, "MigratedApp must select loadSettings");
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    edits.push({
      start: loadSettingsStatement.end,
      end: loadSettingsStatement.end,
      replacement: `${newline}  const settingsLoading = useSettingsStore((s) => s.isLoading);`,
    });
  }
  return applySourceEdits(source, edits);
}

function removeBootstrapReadinessGate(source: string): string {
  const { sourceFile, declaration } = getMigratedAppFunction(source);
  const finalGate = findFinalStartupGate(sourceFile, declaration);
  const condition = finalGate.expression.getText(sourceFile);
  const mutatedCondition = condition.replace(/\s*\|\|\s*!bootstrapReady\b/, "");
  assert.notEqual(
    mutatedCondition,
    condition,
    "the bootstrapReady term must exist in the final startup gate",
  );
  assert.ok(
    !mutatedCondition.includes("!bootstrapReady"),
    "the mutation must remove the complete bootstrapReady term",
  );
  return applySourceEdits(source, [
    {
      start: finalGate.expression.getStart(sourceFile),
      end: finalGate.expression.getEnd(),
      replacement: mutatedCondition,
    },
  ]);
}

function removeSettingsFailurePresentation(source: string): string {
  const { sourceFile, declaration } = getMigratedAppFunction(source);
  const matches = declaration.body!.statements.filter(
    (statement): statement is ts.IfStatement =>
      ts.isIfStatement(statement) &&
      statement.expression.getText(sourceFile).includes("settingsLoadFailed"),
  );
  assert.equal(
    matches.length,
    1,
    "the settings bootstrap failure branch must be unique",
  );
  return applySourceEdits(source, [
    {
      start: matches[0].getStart(sourceFile),
      end: matches[0].end,
      replacement: "",
    },
  ]);
}

function replaceUniqueSourceText(
  source: string,
  expected: string,
  replacement: string,
  label: string,
): string {
  const start = source.indexOf(expected);
  assert.notEqual(start, -1, `${label} mutation target must exist`);
  assert.equal(
    source.indexOf(expected, start + expected.length),
    -1,
    `${label} mutation target must be unique`,
  );
  return `${source.slice(0, start)}${replacement}${source.slice(
    start + expected.length,
  )}`;
}

function forceNotificationReplace(source: string): string {
  return replaceUniqueSourceText(
    source,
    "if (!homeAlreadyMounted)",
    "if (true)",
    "forced notification replace",
  );
}

function suppressNotificationReplace(source: string): string {
  return replaceUniqueSourceText(
    source,
    "if (!homeAlreadyMounted)",
    "if (false)",
    "suppressed notification replace",
  );
}

function ignoreNotificationRootStaleness(source: string): string {
  return replaceUniqueSourceText(
    source,
    "rootState?.stale === false &&",
    "true &&",
    "notification root staleness",
  );
}

function ignoreNotificationLeafState(source: string): string {
  return replaceUniqueSourceText(
    source,
    "scene.state == null",
    "true",
    "notification leaf state",
  );
}

function reattachNotificationSubscriberByRoute(source: string): string {
  return replaceUniqueSourceText(
    source,
    "[navigationRef, router]",
    "[navigationRef, router, navigationRef.getRootState()]",
    "notification route dependency",
  );
}

function ignoreFocusedSceneIndex(source: string): string {
  return replaceUniqueSourceText(
    source,
    "sceneState?.routes[sceneState.index ?? 0]",
    "sceneState?.routes[0]",
    "notification focused scene index",
  );
}

function searchAnyHomeScene(source: string): string {
  return replaceUniqueSourceText(
    source,
    "sceneState?.routes[sceneState.index ?? 0]",
    'sceneState?.routes.find((route) => route.name === "index")',
    "notification focused Home scene",
  );
}

function fullRouteState(
  routes: readonly AppContentAuditRoute[],
  index = 0,
): AppContentAuditRouteState {
  return { stale: false, index, routes };
}

function homeRouteState(): AppContentAuditRouteState {
  return fullRouteState([
    {
      name: "__root",
      state: fullRouteState([{ name: "index" }]),
    },
  ]);
}

function settingsIndexRouteState(): AppContentAuditRouteState {
  return fullRouteState([
    {
      name: "__root",
      state: fullRouteState([
        {
          name: "settings",
          state: fullRouteState([{ name: "index" }]),
        },
      ]),
    },
  ]);
}

function statisticsRouteState(): AppContentAuditRouteState {
  return fullRouteState([
    {
      name: "__root",
      state: fullRouteState([{ name: "statistics" }]),
    },
  ]);
}

function homeAfterPreviousSceneRouteState(): AppContentAuditRouteState {
  return fullRouteState([
    {
      name: "__root",
      state: fullRouteState([{ name: "statistics" }, { name: "index" }], 1),
    },
  ]);
}

function statisticsOverHomeRouteState(): AppContentAuditRouteState {
  return fullRouteState([
    {
      name: "__root",
      state: fullRouteState([{ name: "index" }, { name: "statistics" }], 1),
    },
  ]);
}

function expectedNotificationEvents(replace: boolean): AppContentAuditEvent[] {
  const events: AppContentAuditEvent[] = [
    { type: "presentation", values: ["2031-04-05"] },
    { type: "select-date", values: ["2031-04-05"] },
  ];
  if (replace) events.push({ type: "replace", values: ["/"] });
  return events;
}

async function auditInitialMigrationPending(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = loadStartupForAudit({ onRetry: () => undefined }, source);
  try {
    const snapshot = harness.snapshot();
    assert.equal(snapshot.startupVisible, true);
    assert.equal(snapshot.startupError, false);
    assert.equal(snapshot.appContentIdentity, null);
    assert.equal(
      harness.settingsLoadCallCount,
      0,
      "settings bootstrap must wait for migration success",
    );
  } finally {
    harness.unmount();
  }
}

async function auditMigrationFailure(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  let retryCalls = 0;
  const harness = loadStartupForAudit(
    {
      onRetry: () => {
        retryCalls += 1;
      },
    },
    source,
  );
  try {
    const failure = new Error("Synthetic migration failure");
    harness.setMigration({ success: false, error: failure });
    const snapshot = harness.snapshot();
    assert.equal(snapshot.startupVisible, true);
    assert.equal(snapshot.startupError, true);
    assert.equal(snapshot.appContentIdentity, null);
    harness.invokeStartupRetry();
    assert.equal(retryCalls, 1);
  } finally {
    harness.unmount();
  }
}

async function auditSettingsPendingAndSuccess(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = loadStartupForAudit({ onRetry: () => undefined }, source);
  try {
    harness.queueSettingsLoad();
    harness.setMigration({ success: true, error: null });
    assert.equal(harness.settingsLoadCallCount, 1);
    assert.equal(
      harness.snapshot().appContentIdentity,
      null,
      "settings bootstrap must finish before AppContent mounts",
    );

    await harness.completeNextSettingsLoad(true);
    const snapshot = harness.snapshot();
    assert.equal(snapshot.startupVisible, false);
    assert.notEqual(snapshot.appContentIdentity, null);
    assert.equal(snapshot.appContentMountCount, 1);
    assert.equal(snapshot.appContentUnmountCount, 0);
    assert.equal(harness.warmupCallCount, 1);
  } finally {
    harness.unmount();
  }
}

async function auditSettingsFailure(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = loadStartupForAudit({ onRetry: () => undefined }, source);
  try {
    harness.queueSettingsLoad();
    harness.setMigration({ success: true, error: null });
    await harness.completeNextSettingsLoad(false);
    const snapshot = harness.snapshot();
    assert.ok(
      snapshot.startupVisible && snapshot.startupError,
      "failed settings bootstrap must render the startup error",
    );
    assert.equal(snapshot.startupErrorMessage, "common.dataErrorMessage");
    assert.equal(snapshot.appContentIdentity, null);
  } finally {
    harness.unmount();
  }
}

async function auditRejectedSettingsBootstrap(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = loadStartupForAudit({ onRetry: () => undefined }, source);
  try {
    const failure = new Error("Synthetic settings rejection");
    harness.queueSettingsLoad();
    harness.setMigration({ success: true, error: null });
    await harness.rejectNextSettingsLoad(failure);
    const snapshot = harness.snapshot();
    assert.equal(snapshot.startupVisible, true);
    assert.equal(snapshot.startupError, true);
    assert.equal(snapshot.appContentIdentity, null);
  } finally {
    harness.unmount();
  }
}

async function auditRetryBootstrap(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  let retryCalls = 0;
  const failed = loadStartupForAudit(
    {
      onRetry: () => {
        retryCalls += 1;
      },
    },
    source,
  );
  failed.setMigration({
    success: false,
    error: new Error("Synthetic initial migration failure"),
  });
  failed.invokeStartupRetry();
  failed.unmount();
  assert.equal(retryCalls, 1);
  const retried = loadStartupForAudit({ onRetry: () => undefined }, source);
  try {
    retried.queueSettingsLoad();
    retried.setMigration({ success: true, error: null });
    assert.equal(
      retried.snapshot().appContentIdentity,
      null,
      "a retried MigratedApp instance must repeat settings bootstrap",
    );
    await retried.completeNextSettingsLoad(true);
    assert.notEqual(retried.snapshot().appContentIdentity, null);
  } finally {
    retried.unmount();
  }
}

async function createReadyHarness(
  source: StartupAuditSourceOptions,
): Promise<StartupAuditHarness> {
  const harness = loadStartupForAudit({ onRetry: () => undefined }, source);
  harness.queueSettingsLoad();
  harness.setMigration({ success: true, error: null });
  await harness.completeNextSettingsLoad(true);
  assert.notEqual(harness.snapshot().appContentIdentity, null);
  return harness;
}

async function auditPostBootstrapPublicationSuccess(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = await createReadyHarness(source);
  try {
    const initial = harness.snapshot();
    harness.setSettingsLoading(true);
    assert.equal(
      harness.snapshot().appContentIdentity,
      initial.appContentIdentity,
      "post-bootstrap settings reads must preserve the mounted AppContent identity",
    );
    harness.setSettingsLoading(false);
    const completed = harness.snapshot();
    assert.equal(completed.appContentIdentity, initial.appContentIdentity);
    assert.equal(completed.appContentMountCount, 1);
    assert.equal(completed.appContentUnmountCount, 0);
  } finally {
    harness.unmount();
  }
}

async function auditPostBootstrapPublicationRetry(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = await createReadyHarness(source);
  try {
    const initial = harness.snapshot();
    for (const loading of [true, false, true, false]) {
      harness.setSettingsLoading(loading);
      assert.equal(
        harness.snapshot().appContentIdentity,
        initial.appContentIdentity,
        "publication recovery must not replace the mounted AppContent tree",
      );
    }
    const completed = harness.snapshot();
    assert.equal(completed.appContentMountCount, 1);
    assert.equal(completed.appContentUnmountCount, 0);
  } finally {
    harness.unmount();
  }
}

async function auditReadyTreeUnmountAccounting(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = await createReadyHarness(source);
  try {
    const failure = new Error("Synthetic migration failure after readiness");
    harness.setMigration({ success: false, error: failure });
    const snapshot = harness.snapshot();
    assert.equal(snapshot.appContentIdentity, null);
    assert.equal(snapshot.appContentMountCount, 1);
    assert.equal(
      snapshot.appContentUnmountCount,
      1,
      "removing a mounted AppContent tree must record exactly one unmount",
    );
    assert.equal(snapshot.startupVisible, true);
    assert.equal(snapshot.startupError, true);
  } finally {
    harness.unmount();
  }
}

async function auditLateBootstrapUnmount(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  for (const outcome of [true, false, "reject"] as const) {
    const harness = loadStartupForAudit({ onRetry: () => undefined }, source);
    harness.queueSettingsLoad();
    harness.setMigration({ success: true, error: null });
    harness.unmount();
    if (outcome === "reject") {
      await harness.rejectNextSettingsLoad(
        new Error("Synthetic late rejection"),
      );
    } else {
      await harness.completeNextSettingsLoad(outcome);
    }
    assert.equal(
      harness.lateStateWriteCount,
      0,
      "a settled bootstrap must not write into an unmounted owner",
    );
    assert.equal(harness.snapshot().appContentMountCount, 0);
    assert.equal(harness.snapshot().appContentIdentity, null);
  }
}

async function auditSupersededBootstrap(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = loadStartupForAudit({ onRetry: () => undefined }, source);
  try {
    harness.queueSettingsLoad();
    harness.setMigration({ success: true, error: null });
    harness.setMigration({
      success: false,
      error: new Error("Synthetic migration change"),
    });
    await harness.completeNextSettingsLoad(true);
    assert.equal(harness.snapshot().startupError, true);
    harness.queueSettingsLoad();
    harness.setMigration({ success: true, error: null });
    assert.equal(harness.settingsLoadCallCount, 2);
    assert.equal(
      harness.snapshot().appContentIdentity,
      null,
      "a superseded bootstrap completion must not publish readiness for its replacement",
    );
    await harness.completeNextSettingsLoad(true);
    assert.notEqual(harness.snapshot().appContentIdentity, null);
    assert.equal(harness.snapshot().appContentMountCount, 1);
  } finally {
    harness.unmount();
  }
}

async function auditSameHomeNotification(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  for (const state of [homeRouteState(), homeAfterPreviousSceneRouteState()]) {
    const harness = loadAppContentForAudit(source);
    try {
      harness.setNavigation(true, state);
      harness.emitNotification();
      assert.deepEqual(
        harness.events,
        expectedNotificationEvents(false),
        "a committed Home route must preserve AppContent while publishing the reminder intent",
      );
    } finally {
      harness.unmount();
    }
  }
}

async function auditNonHomeNotifications(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const cases: readonly {
    label: string;
    ready: boolean;
    state: AppContentAuditRouteState | undefined;
  }[] = [
    {
      label: "nested settings index",
      ready: true,
      state: settingsIndexRouteState(),
    },
    { label: "statistics", ready: true, state: statisticsRouteState() },
    {
      label: "Home below focused statistics",
      ready: true,
      state: statisticsOverHomeRouteState(),
    },
    { label: "navigation not ready", ready: false, state: homeRouteState() },
    { label: "missing state", ready: true, state: undefined },
  ];
  for (const entry of cases) {
    const harness = loadAppContentForAudit(source);
    try {
      harness.setNavigation(entry.ready, entry.state);
      harness.emitNotification();
      assert.deepEqual(
        harness.events,
        expectedNotificationEvents(true),
        `${entry.label} must navigate to Home after publishing the reminder intent`,
      );
    } finally {
      harness.unmount();
    }
  }
}

async function auditIncompleteNotificationStates(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const homeScene = fullRouteState([{ name: "index" }]);
  const cases: readonly {
    label: string;
    state: AppContentAuditRouteState;
  }[] = [
    {
      label: "stale root",
      state: {
        stale: true,
        index: 0,
        routes: [{ name: "__root", state: homeScene }],
      },
    },
    {
      label: "partial scene",
      state: fullRouteState([
        {
          name: "__root",
          state: { index: 0, routes: [{ name: "index" }] },
        },
      ]),
    },
    {
      label: "invalid focused index",
      state: { stale: false, index: 1, routes: [{ name: "__root" }] },
    },
    {
      label: "unexpected root wrapper",
      state: fullRouteState([{ name: "alternate-root", state: homeScene }]),
    },
    {
      label: "nested index scene",
      state: fullRouteState([
        {
          name: "__root",
          state: fullRouteState([
            {
              name: "index",
              state: fullRouteState([{ name: "child" }]),
            },
          ]),
        },
      ]),
    },
  ];
  for (const entry of cases) {
    const harness = loadAppContentForAudit(source);
    try {
      harness.setNavigation(true, entry.state);
      harness.emitNotification();
      assert.deepEqual(
        harness.events,
        expectedNotificationEvents(true),
        `${entry.label} must conservatively navigate to Home`,
      );
    } finally {
      harness.unmount();
    }
  }
}

async function auditRapidNotificationsReadCurrentRoute(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = loadAppContentForAudit(source);
  try {
    harness.setNavigation(true, homeRouteState());
    harness.emitNotification();
    harness.setNavigation(true, statisticsRouteState());
    harness.emitNotification();
    assert.deepEqual(harness.events, [
      ...expectedNotificationEvents(false),
      ...expectedNotificationEvents(true),
    ]);
    assert.equal(
      harness.subscriptionCount,
      1,
      "rapid notifications must share one stable subscriber",
    );
  } finally {
    harness.unmount();
  }
}

async function auditNotificationSubscriptionStability(
  source: StartupAuditSourceOptions = {},
): Promise<void> {
  const harness = loadAppContentForAudit(source);
  try {
    for (const state of [
      homeRouteState(),
      settingsIndexRouteState(),
      statisticsRouteState(),
      homeRouteState(),
    ]) {
      harness.setNavigation(true, state);
      harness.rerender();
    }
    assert.equal(
      harness.subscriptionCount,
      1,
      "route changes must not reattach the reminder notification subscriber",
    );
    assert.equal(harness.unsubscriptionCount, 0);
    harness.emitNotification();
    assert.deepEqual(harness.events, expectedNotificationEvents(false));
  } finally {
    harness.unmount();
  }
  assert.equal(
    harness.unsubscriptionCount,
    1,
    "AppContent unmount must remove its reminder notification subscriber once",
  );
}

async function assertScenarioRejectsMutation(
  label: string,
  scenario: (source?: StartupAuditSourceOptions) => Promise<void>,
  transform: (source: string) => string,
  expectedFailure: RegExp,
): Promise<void> {
  const source = { transform };
  // Target selection, syntax and module loading are mutation preconditions.
  validateStartupAuditSourceTransform(source);
  let rejected = false;
  try {
    await scenario(source);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    assert.match(
      error.message,
      expectedFailure,
      `${label} must fail at the intended observable`,
    );
    rejected = true;
  }
  assert.ok(rejected, `${label} must be detected by the behavioral audit`);
}

async function assertAppContentScenarioRejectsMutation(
  label: string,
  scenario: (source?: StartupAuditSourceOptions) => Promise<void>,
  transform: (source: string) => string,
  expectedFailure: RegExp,
): Promise<void> {
  const source = { transform };
  // Target selection, syntax and module loading are mutation preconditions.
  validateAppContentAuditSourceTransform(source);
  let rejected = false;
  try {
    await scenario(source);
  } catch (error) {
    if (!(error instanceof assert.AssertionError)) throw error;
    assert.match(
      error.message,
      expectedFailure,
      `${label} must fail at the intended observable`,
    );
    rejected = true;
  }
  assert.ok(rejected, `${label} must be detected by the behavioral audit`);
}

async function runStartupLifecycleAudit(): Promise<void> {
  await auditInitialMigrationPending();
  await auditMigrationFailure();
  await auditSettingsPendingAndSuccess();
  await auditSettingsFailure();
  await auditRejectedSettingsBootstrap();
  await auditRetryBootstrap();
  await auditPostBootstrapPublicationSuccess();
  await auditPostBootstrapPublicationRetry();
  await auditReadyTreeUnmountAccounting();
  await auditLateBootstrapUnmount();
  await auditSupersededBootstrap();
  await auditSameHomeNotification();
  await auditNonHomeNotifications();
  await auditIncompleteNotificationStates();
  await auditRapidNotificationsReadCurrentRoute();
  await auditNotificationSubscriptionStability();

  await assertScenarioRejectsMutation(
    "post-bootstrap loading gate restored",
    auditPostBootstrapPublicationSuccess,
    restorePostBootstrapLoadingGate,
    /post-bootstrap settings reads must preserve the mounted AppContent identity/,
  );
  await assertScenarioRejectsMutation(
    "bootstrap readiness gate removed",
    auditSettingsPendingAndSuccess,
    removeBootstrapReadinessGate,
    /settings bootstrap must finish before AppContent mounts/,
  );
  await assertScenarioRejectsMutation(
    "settings failure presentation removed",
    auditSettingsFailure,
    removeSettingsFailurePresentation,
    /failed settings bootstrap must render the startup error/,
  );
  for (const [scenario, expectedFailure] of [
    [auditLateBootstrapUnmount, /must not write into an unmounted owner/],
    [
      auditSupersededBootstrap,
      /must not publish readiness for its replacement/,
    ],
  ] as const) {
    await assertScenarioRejectsMutation(
      "superseded bootstrap owner guard removed",
      scenario,
      (source) =>
        replaceUniqueSourceText(
          source,
          "if (active) {",
          "if (true) {",
          "bootstrap owner guard",
        ),
      expectedFailure,
    );
  }
  await assertAppContentScenarioRejectsMutation(
    "same-route notification replace restored",
    auditSameHomeNotification,
    forceNotificationReplace,
    /committed Home route must preserve AppContent/,
  );
  await assertAppContentScenarioRejectsMutation(
    "non-Home notification replace suppressed",
    auditNonHomeNotifications,
    suppressNotificationReplace,
    /nested settings index must navigate to Home/,
  );
  await assertAppContentScenarioRejectsMutation(
    "stale root accepted as committed Home",
    auditIncompleteNotificationStates,
    ignoreNotificationRootStaleness,
    /stale root must conservatively navigate to Home/,
  );
  await assertAppContentScenarioRejectsMutation(
    "nested index accepted as Home leaf",
    auditIncompleteNotificationStates,
    ignoreNotificationLeafState,
    /nested index scene must conservatively navigate to Home/,
  );
  await assertAppContentScenarioRejectsMutation(
    "notification subscriber made route-dependent",
    auditNotificationSubscriptionStability,
    reattachNotificationSubscriberByRoute,
    /route changes must not reattach the reminder notification subscriber/,
  );
  await assertAppContentScenarioRejectsMutation(
    "focused scene index ignored",
    auditSameHomeNotification,
    ignoreFocusedSceneIndex,
    /committed Home route must preserve AppContent/,
  );
  await assertAppContentScenarioRejectsMutation(
    "unfocused Home scene accepted",
    auditNonHomeNotifications,
    searchAnyHomeScene,
    /Home below focused statistics must navigate to Home/,
  );
}

export async function auditStartupLifecycle(): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runStartupLifecycleAudit(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Startup lifecycle audit timed out")),
          SCENARIO_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const invokedDirectly =
  process.argv[1] != null &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  void auditStartupLifecycle()
    .then(() => {
      console.log(
        "Startup lifecycle audit passed (16 scenario groups, 12 behavioral mutations).",
      );
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
