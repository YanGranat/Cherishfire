import assert from "node:assert/strict";
import { withAuditDeadline } from "./fixtures/with-audit-deadline";
import fs from "node:fs";
import path from "node:path";
import {
  SettingsMutationCoordinator,
  createSettingsMutationSnapshot,
  type SettingsMutationCoordinatorDependencies,
  type SettingsSideEffectPhase,
  type SettingsWriteEntry,
} from "../src/application/settings/settings-mutation-coordinator";
import { DEFAULT_SETTINGS } from "../src/types/settings";
import { getHabitDescriptionLinesScope } from "../src/application/settings/habit-description-lines-setting";

function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(
  overrides: Partial<SettingsMutationCoordinatorDependencies> = {},
) {
  const writes: SettingsWriteEntry[][] = [];
  const deletes: string[][] = [];
  const languageEffects: {
    language: string;
    phase: SettingsSideEffectPhase;
  }[] = [];
  const reminderEffects: {
    enabled: boolean;
    phase: SettingsSideEffectPhase;
  }[] = [];
  const effectErrors: unknown[] = [];
  const dependencies: SettingsMutationCoordinatorDependencies = {
    async write(entries) {
      writes.push(entries.map((entry) => [...entry] as SettingsWriteEntry));
    },
    scheduleRepair(task) {
      let cancelled = false;
      queueMicrotask(() => {
        if (!cancelled) task();
      });
      return {
        cancel() {
          cancelled = true;
        },
      };
    },
    async changeLanguage(language, phase) {
      languageEffects.push({ language, phase });
    },
    async setReminderMasterEnabled(enabled, phase) {
      reminderEffects.push({ enabled, phase });
    },
    onNativeEffectError(_effect, _phase, error) {
      effectErrors.push(error);
    },
    ...overrides,
    delete:
      overrides.delete ??
      (async (keys) => {
        deletes.push([...keys]);
      }),
    waitForCommitOpportunity:
      overrides.waitForCommitOpportunity ?? (async () => undefined),
  };
  const coordinator = new SettingsMutationCoordinator(
    dependencies,
    createSettingsMutationSnapshot(DEFAULT_SETTINGS),
  );
  return {
    coordinator,
    writes,
    deletes,
    languageEffects,
    reminderEffects,
    effectErrors,
  };
}

async function auditAtoBtoA(): Promise<void> {
  const { coordinator, writes } = createHarness();
  const first = coordinator.submit({
    scope: "theme",
    value: "dark",
  });
  const second = coordinator.submit({
    scope: "theme",
    value: "light",
  });
  const third = coordinator.submit({
    scope: "theme",
    value: "dark",
  });

  const results = await Promise.all([
    first.completion,
    second.completion,
    third.completion,
  ]);
  assert.deepEqual(
    results.map(({ status }) => status),
    ["superseded", "superseded", "committed"],
  );
  assert.deepEqual(writes, [[["theme", "dark"]]]);
  assert.equal(coordinator.getConfirmedValue("theme"), "dark");
}

async function auditOldCommitLatestFailure(): Promise<void> {
  const firstWrite = deferred<void>();
  let writeCount = 0;
  const { coordinator } = createHarness({
    async write() {
      writeCount += 1;
      if (writeCount === 1) return firstWrite.promise;
      throw new Error("latest write failed");
    },
  });

  const first = coordinator.submit({
    scope: "theme",
    value: "dark",
  });
  await flushMicrotasks();
  assert.equal(writeCount, 1, "the first durable write must have started");

  const latest = coordinator.submit({
    scope: "theme",
    value: "light",
  });
  firstWrite.resolve();

  assert.equal((await first.completion).status, "committed");
  const failed = await latest.completion;
  assert.equal(failed.status, "failed");
  assert.equal(failed.isLatest, true);
  assert.equal(
    failed.confirmedValue,
    "dark",
    "latest failure must roll back to the older write that really committed",
  );
}

async function auditSharedCommitOpportunity(): Promise<void> {
  const commitOpportunity = deferred<void>();
  let writeStarted = false;
  const { coordinator } = createHarness({
    waitForCommitOpportunity: () => commitOpportunity.promise,
    async write() {
      writeStarted = true;
    },
  });

  const pending = coordinator.submit({ scope: "theme", value: "dark" });
  assert.equal(
    coordinator.getCurrentValue("theme"),
    "dark",
    "the optimistic value must be owned synchronously in the tap turn",
  );
  await flushMicrotasks();
  assert.equal(
    writeStarted,
    false,
    "settings SQLite must not contend with the first complete foreground paint",
  );

  commitOpportunity.resolve();
  assert.equal((await pending.completion).status, "committed");
  assert.equal(writeStarted, true);
}

async function auditDescriptionLinesExactFence(): Promise<void> {
  const habitId = 17;
  const scope = getHabitDescriptionLinesScope(habitId);
  let persisted = 1;
  const { coordinator } = createHarness({
    async write(entries) {
      const value = entries.find(
        ([key]) => key === `habit_description_lines_v1:${habitId}`,
      )?.[1];
      if (typeof value === "number") persisted = value;
    },
  });

  const beforeCutoff = coordinator.submit({
    scope,
    value: 2,
    operation: "set",
  });
  assert.equal(coordinator.readHabitDescriptionLines(habitId), 2);
  const fence = coordinator.captureDurableFence();
  const afterCutoff = coordinator.submit({
    scope,
    value: 3,
    operation: "set",
  });
  assert.equal(
    coordinator.readHabitDescriptionLines(habitId),
    3,
    "B must become the immediate optimistic cache value",
  );

  await coordinator.whenDurableThrough(fence);
  assert.equal((await beforeCutoff.completion).status, "committed");
  assert.equal(
    persisted,
    2,
    "an export cutoff must include A even when B is already visible",
  );

  let afterCutoffSettled = false;
  void afterCutoff.completion.then(() => {
    afterCutoffSettled = true;
  });
  await flushMicrotasks();
  assert.equal(
    afterCutoffSettled,
    false,
    "B must not extend or pass the captured export cutoff",
  );

  coordinator.releaseDurableFence(fence, "resume-post-cutoff");
  assert.equal((await afterCutoff.completion).status, "committed");
  assert.equal(persisted, 3, "an aborted/read-only transfer must resume B");
}

async function auditDescriptionLinesFirstFailureAndRapidSupersession(): Promise<void> {
  const failedHabitId = 171;
  const failedScope = getHabitDescriptionLinesScope(failedHabitId);
  const failing = createHarness({
    async write() {
      throw new Error("first description write failed");
    },
  }).coordinator;
  const firstFailure = await failing.submit({
    scope: failedScope,
    value: 9,
    operation: "set",
  }).completion;
  assert.equal(firstFailure.status, "failed");
  assert.equal(firstFailure.confirmedValue, 1);
  assert.equal(
    failing.readHabitDescriptionLines(failedHabitId),
    1,
    "a first-ever failed resize must resolve with the real default baseline",
  );

  const rapidHabitId = 172;
  const rapidScope = getHabitDescriptionLinesScope(rapidHabitId);
  const rapid = createHarness().coordinator;
  const first = rapid.submit({
    scope: rapidScope,
    value: 2,
    operation: "set",
  });
  const second = rapid.submit({
    scope: rapidScope,
    value: 3,
    operation: "set",
  });
  assert.deepEqual(
    (await Promise.all([first.completion, second.completion])).map(
      ({ status }) => status,
    ),
    ["superseded", "committed"],
    "rapid first A→B must not reject while A is superseded before dispatch",
  );
  assert.equal(rapid.readHabitDescriptionLines(rapidHabitId), 3);
}

async function auditDescriptionLinesCommittedImportWins(): Promise<void> {
  const habitId = 18;
  const scope = getHabitDescriptionLinesScope(habitId);
  let persisted = 1;
  const { coordinator } = createHarness({
    async write(entries) {
      const value = entries.find(
        ([key]) => key === `habit_description_lines_v1:${habitId}`,
      )?.[1];
      if (typeof value === "number") persisted = value;
    },
  });

  const beforeCutoff = coordinator.submit({
    scope,
    value: 2,
    operation: "set",
  });
  const fence = coordinator.captureDurableFence();
  const afterCutoff = coordinator.submit({
    scope,
    value: 3,
    operation: "set",
  });
  await coordinator.whenDurableThrough(fence);
  assert.equal((await beforeCutoff.completion).status, "committed");
  assert.equal(persisted, 2);

  persisted = 6;
  coordinator.replaceConfirmedSnapshot(
    createSettingsMutationSnapshot(DEFAULT_SETTINGS, new Map([[habitId, 6]])),
  );
  assert.equal(
    coordinator.readHabitDescriptionLines(habitId),
    6,
    "committed import publication must replace the optimistic cache",
  );
  coordinator.releaseDurableFence(fence, "discard-post-cutoff");
  assert.equal((await afterCutoff.completion).status, "superseded");
  assert.equal(persisted, 6, "discarded B must not overwrite imported SQLite");
  assert.equal(coordinator.readHabitDescriptionLines(habitId), 6);

  coordinator.replaceConfirmedSnapshot(
    createSettingsMutationSnapshot(DEFAULT_SETTINGS),
  );
  assert.equal(
    coordinator.readHabitDescriptionLines(habitId),
    1,
    "an imported snapshot without the scoped row must clear an older cached height",
  );
}

async function auditDescriptionLinesRollbackAndStaleLoad(): Promise<void> {
  const habitId = 19;
  const scope = getHabitDescriptionLinesScope(habitId);
  const firstWrite = deferred<void>();
  let writeCount = 0;
  const { coordinator } = createHarness({
    async write() {
      writeCount += 1;
      if (writeCount === 1) return firstWrite.promise;
      throw new Error("latest description write failed");
    },
  });
  coordinator.replaceConfirmedSnapshot(
    createSettingsMutationSnapshot(DEFAULT_SETTINGS, new Map([[habitId, 4]])),
  );

  const first = coordinator.submit({ scope, value: 5, operation: "set" });
  await flushMicrotasks();
  const latest = coordinator.submit({ scope, value: 6, operation: "set" });
  assert.equal(coordinator.readHabitDescriptionLines(habitId), 6);
  firstWrite.resolve();
  assert.equal((await first.completion).status, "committed");
  const latestResult = await latest.completion;
  assert.equal(latestResult.status, "failed");
  assert.equal(latestResult.confirmedValue, 5);
  assert.equal(
    coordinator.readHabitDescriptionLines(habitId),
    5,
    "latest failure must roll back to the older value that really committed",
  );

  const staleToken = coordinator.captureLoadToken();
  const newer = coordinator.submit({ scope, value: 7, operation: "set" });
  assert.equal(
    coordinator.replaceConfirmedSnapshot(
      createSettingsMutationSnapshot(DEFAULT_SETTINGS, new Map([[habitId, 2]])),
      staleToken,
    ),
    false,
  );
  assert.equal(
    coordinator.readHabitDescriptionLines(habitId),
    7,
    "a stale load must not hydrate an old description cache",
  );
  await newer.completion;
}

async function auditDescriptionLinesDeletionCleanup(): Promise<void> {
  const habitId = 20;
  const scope = getHabitDescriptionLinesScope(habitId);
  const oldWrite = deferred<void>();
  const { coordinator, deletes } = createHarness({
    async write() {
      await oldWrite.promise;
    },
  });
  const oldResize = coordinator.submit({
    scope,
    value: 8,
    operation: "set",
  });
  await flushMicrotasks();

  const [cleanup] = coordinator.publishDeletedHabitDescriptionLines([habitId]);
  assert.equal(
    coordinator.readHabitDescriptionLines(habitId),
    1,
    "successful habit deletion must clear the visible cache immediately",
  );
  oldWrite.resolve();
  assert.equal((await oldResize.completion).status, "committed");
  assert.equal((await cleanup.completion).status, "committed");
  assert.deepEqual(deletes, [[`habit_description_lines_v1:${habitId}`]]);
  assert.equal(
    coordinator.getConfirmedValue(scope),
    1,
    "a delayed old UPSERT followed by cleanup must keep the deleted baseline",
  );

  const failedCleanupHabitId = 21;
  const failedCleanupScope =
    getHabitDescriptionLinesScope(failedCleanupHabitId);
  const failedCleanup = createHarness({
    async delete() {
      throw new Error("best-effort cleanup failed");
    },
  }).coordinator;
  failedCleanup.replaceConfirmedSnapshot(
    createSettingsMutationSnapshot(
      DEFAULT_SETTINGS,
      new Map([[failedCleanupHabitId, 9]]),
    ),
  );
  const [failedSubmission] = failedCleanup.publishDeletedHabitDescriptionLines([
    failedCleanupHabitId,
  ]);
  assert.equal(
    failedCleanup.readHabitDescriptionLines(failedCleanupHabitId),
    1,
    "the already-committed habit transaction must clear cache before trailing cleanup",
  );
  const failedResult = await failedSubmission.completion;
  assert.equal(failedResult.status, "failed");
  assert.equal(failedResult.confirmedValue, 1);
  assert.equal(failedCleanup.getConfirmedValue(failedCleanupScope), 1);
}

async function auditColorBundle(): Promise<void> {
  let failNext = false;
  const persistedBatches: SettingsWriteEntry[][] = [];
  const { coordinator } = createHarness({
    async write(entries) {
      persistedBatches.push([...entries]);
      if (failNext) throw new Error("color bundle failed");
    },
  });
  const savedBundle = {
    colorScheme: "#123456" as const,
    colorSchemeOptions: ["#123456" as const, "orange" as const],
    builtinColorOverrides: { orange: "#123456" as const },
    customColors: ["#123456" as const],
  };
  const saved = coordinator.submit({
    scope: "color",
    value: savedBundle,
    operation: "replace-bundle",
  });
  assert.equal((await saved.completion).status, "committed");
  assert.equal(persistedBatches.length, 1);
  assert.equal(
    persistedBatches[0].length,
    4,
    "all color fields must cross SQLite as one atomic repository write",
  );

  failNext = true;
  const failed = coordinator.submit({
    scope: "color",
    value: {
      colorScheme: "#ABCDEF",
      colorSchemeOptions: ["#ABCDEF"],
      builtinColorOverrides: {},
      customColors: ["#ABCDEF"],
    },
    operation: "replace-bundle",
  });
  const failure = await failed.completion;
  assert.equal(failure.status, "failed");
  assert.deepEqual(failure.confirmedValue, savedBundle);
}

async function auditColorSelectionCannotSkipChangedStructure(): Promise<void> {
  const { coordinator, writes } = createHarness();
  const nextBundle = {
    ...coordinator.getConfirmedValue("color"),
    colorScheme: "orange" as const,
    // `customColors` is persisted separately, so it participates in the
    // coordinator-owned decision between one-row and atomic bundle writes.
    customColors: ["#123456" as const],
  };
  const selection = coordinator.submit({
    scope: "color",
    value: nextBundle,
    operation: "select",
  });
  assert.equal((await selection.completion).status, "committed");
  assert.equal(
    writes[0].length,
    4,
    "selection must fall back to an atomic bundle if any separately persisted color field differs",
  );
}

async function auditQueuedCommandOwnsItsPayload(): Promise<void> {
  const { coordinator, writes } = createHarness();
  const order = ["summary", "bar", "heatmap", "habit"] as const;
  const mutableOrder = [...order];
  const queued = coordinator.submit({
    scope: "statisticsOrder:week",
    value: mutableOrder,
  });
  mutableOrder.reverse();
  await queued.completion;
  assert.deepEqual(
    writes[0]?.[0]?.[1],
    order,
    "a caller mutation after submit must not rewrite the registered intent",
  );
}

async function auditDeferredRepairFlushNow(): Promise<void> {
  let scheduledRun: (() => void) | null = null;
  let cancelled = false;
  const { coordinator, writes } = createHarness({
    scheduleRepair(task) {
      scheduledRun = task;
      return {
        cancel() {
          cancelled = true;
        },
      };
    },
  });

  const repair = coordinator.scheduleRepair([
    { entry: ["theme", "dark"], scopes: ["theme"] },
  ]);
  assert.equal(typeof scheduledRun, "function");
  assert.equal(
    writes.length,
    0,
    "normal startup path keeps repair off first paint",
  );
  await coordinator.whenIdle();
  assert.equal(await repair, "committed");
  assert.equal(
    cancelled,
    true,
    "flush-now cancels the deferred scheduler handle",
  );
  assert.deepEqual(writes, [[["theme", "dark"]]]);
}

async function auditDurableFenceCutoff(): Promise<void> {
  const themeWrite = deferred<void>();
  const skipWrite = deferred<void>();
  const laterWrite = deferred<void>();
  const { coordinator } = createHarness({
    async write(entries) {
      switch (entries[0]?.[0]) {
        case "theme":
          return themeWrite.promise;
        case "ask_skip_reason":
          return skipWrite.promise;
        case "sound_enabled":
          return laterWrite.promise;
        default:
          return;
      }
    },
  });

  const theme = coordinator.submit({ scope: "theme", value: "dark" });
  const skip = coordinator.submit({ scope: "askSkipReason", value: false });
  const fence = coordinator.captureDurableFence();
  const later = coordinator.submit({ scope: "sound", value: false });
  await flushMicrotasks();

  let fenceSettled = false;
  const waiting = coordinator.whenDurableThrough(fence).then(() => {
    fenceSettled = true;
  });
  themeWrite.resolve();
  await theme.completion;
  await flushMicrotasks();
  assert.equal(
    fenceSettled,
    false,
    "every settings write accepted before the cutoff must reach a terminal state",
  );

  skipWrite.resolve();
  await skip.completion;
  await waiting;
  assert.equal(
    fenceSettled,
    true,
    "a settings intent accepted after capture must not delay the cutoff",
  );

  coordinator.releaseDurableFence(fence, "resume-post-cutoff");
  laterWrite.resolve();
  await later.completion;
}

async function auditDurableFenceFlushesRegisteredRepair(): Promise<void> {
  const { coordinator, writes } = createHarness({
    scheduleRepair() {
      return { cancel() {} };
    },
  });
  const repair = coordinator.scheduleRepair([
    { entry: ["theme", "dark"], scopes: ["theme"] },
  ]);
  const fence = coordinator.captureDurableFence();

  await coordinator.whenDurableThrough(fence);
  assert.equal(await repair, "committed");
  assert.deepEqual(writes, [[["theme", "dark"]]]);
  coordinator.releaseDurableFence(fence, "resume-post-cutoff");
}

async function auditFencePinsPreCutoffIntent(): Promise<void> {
  const { coordinator, writes } = createHarness();
  const beforeCutoff = coordinator.submit({ scope: "theme", value: "dark" });
  const fence = coordinator.captureDurableFence();
  const afterCutoff = coordinator.submit({ scope: "theme", value: "light" });

  await coordinator.whenDurableThrough(fence);
  assert.equal((await beforeCutoff.completion).status, "committed");
  assert.deepEqual(
    writes,
    [[["theme", "dark"]]],
    "a pre-cutoff intent must reach SQLite even if a later intent supersedes it before dispatch",
  );

  let laterSettled = false;
  void afterCutoff.completion.then(() => {
    laterSettled = true;
  });
  await flushMicrotasks();
  assert.equal(
    laterSettled,
    false,
    "post-cutoff settings writes must remain behind the gate until the snapshot owner releases it",
  );

  coordinator.releaseDurableFence(fence, "resume-post-cutoff");
  assert.equal((await afterCutoff.completion).status, "committed");
  assert.deepEqual(writes, [[["theme", "dark"]], [["theme", "light"]]]);
}

async function auditCommittedImportDiscardsPostCutoffIntent(): Promise<void> {
  let persistedTheme = "system";
  const { coordinator } = createHarness({
    async write(entries) {
      const theme = entries.find(([key]) => key === "theme")?.[1];
      if (typeof theme === "string") persistedTheme = theme;
    },
  });

  const beforeCutoff = coordinator.submit({ scope: "theme", value: "dark" });
  const fence = coordinator.captureDurableFence();
  const afterCutoff = coordinator.submit({ scope: "theme", value: "light" });

  await coordinator.whenDurableThrough(fence);
  assert.equal((await beforeCutoff.completion).status, "committed");
  assert.equal(persistedTheme, "dark");

  // The import transaction atomically replaces the durable settings snapshot.
  persistedTheme = "imported";
  const beforeReload = coordinator.captureLoadToken();
  coordinator.replaceConfirmedSnapshot(
    createSettingsMutationSnapshot({ ...DEFAULT_SETTINGS, theme: "system" }),
  );
  assert.equal(
    coordinator.isLoadTokenCurrent(beforeReload),
    false,
    "publishing the imported snapshot must advance the settings generation",
  );
  assert.equal(coordinator.getConfirmedValue("theme"), "system");

  let postCutoffSettled = false;
  void afterCutoff.completion.then(() => {
    postCutoffSettled = true;
  });
  await flushMicrotasks();
  assert.equal(
    postCutoffSettled,
    false,
    "committed-import publication must not wait for a post-cutoff command held by its own fence",
  );

  coordinator.releaseDurableFence(fence, "discard-post-cutoff");
  assert.equal((await afterCutoff.completion).status, "superseded");
  assert.equal(
    persistedTheme,
    "imported",
    "an intent accepted behind an import fence must never replay onto the imported database",
  );
  await coordinator.whenIdle();
}

async function auditCommittedImportDiscardsPostCutoffRepair(): Promise<void> {
  const { coordinator, writes } = createHarness();
  const fence = coordinator.captureDurableFence();
  const repair = coordinator.scheduleRepair([
    { entry: ["theme", "dark"], scopes: ["theme"] },
  ]);
  await flushMicrotasks();

  coordinator.releaseDurableFence(fence, "discard-post-cutoff");

  assert.equal(await repair, "superseded");
  assert.deepEqual(
    writes,
    [],
    "a deferred pre-import repair registered after the cutoff must not touch the imported database",
  );
  await coordinator.whenIdle();
}

async function auditOverlappingFencesFailFast(): Promise<void> {
  const { coordinator } = createHarness();
  const fence = coordinator.captureDurableFence();
  assert.throws(
    () => coordinator.captureDurableFence(),
    /Only one settings durable fence may be active/,
    "data transfer must serialize snapshots instead of giving overlapping fences ambiguous ownership",
  );
  coordinator.releaseDurableFence(fence, "resume-post-cutoff");
  const nextFence = coordinator.captureDurableFence();
  coordinator.releaseDurableFence(nextFence, "resume-post-cutoff");
}

async function auditColorSelectionAbsorbsDirtyStructure(): Promise<void> {
  const { coordinator, writes } = createHarness({
    scheduleRepair() {
      return { cancel() {} };
    },
  });
  const confirmed = coordinator.getConfirmedValue("color");
  const repair = coordinator.scheduleRepair([
    {
      entry: ["color_scheme_options", confirmed.colorSchemeOptions],
      scopes: ["color"],
    },
    {
      entry: [
        "color_scheme_builtin_overrides",
        confirmed.builtinColorOverrides,
      ],
      scopes: ["color"],
    },
    {
      entry: ["custom_colors", confirmed.customColors],
      scopes: ["color"],
    },
  ]);
  const selection = coordinator.submit({
    scope: "color",
    value: { ...confirmed, colorScheme: "sunset" },
    operation: "select",
  });

  assert.equal((await selection.completion).status, "committed");
  await coordinator.whenIdle();
  assert.equal(await repair, "superseded");
  assert.equal(
    writes[0].length,
    4,
    "a selection must atomically absorb normalized color rows whose deferred repair is still dirty",
  );
}

async function auditLegacyStatisticsRepairIsIndependent(): Promise<void> {
  const { coordinator, writes } = createHarness({
    scheduleRepair() {
      return { cancel() {} };
    },
  });
  const normalizedLegacyOrder = ["bar", "summary", "heatmap", "habit"] as const;
  const repair = coordinator.scheduleRepair([
    {
      entry: ["statistics_block_order", normalizedLegacyOrder],
      scopes: [],
    },
  ]);
  const periodMutation = coordinator.submit({
    scope: "statisticsOrder:week",
    value: ["habit", "bar", "heatmap", "summary"],
  });

  assert.equal((await periodMutation.completion).status, "committed");
  await coordinator.whenIdle();
  assert.equal(await repair, "committed");
  assert.ok(
    writes.some((batch) => batch[0]?.[0] === "statistics_block_order"),
    "a period-specific reorder must not discard the independent legacy compatibility repair",
  );
}

async function auditNewerRepairSupersedesOlderSameKey(): Promise<void> {
  const { coordinator, writes } = createHarness({
    scheduleRepair() {
      return { cancel() {} };
    },
  });
  const older = coordinator.scheduleRepair([
    { entry: ["statistics_block_order", ["summary"]], scopes: [] },
  ]);
  const newer = coordinator.scheduleRepair([
    { entry: ["statistics_block_order", ["bar"]], scopes: [] },
  ]);

  await coordinator.whenIdle();
  assert.equal(await older, "superseded");
  assert.equal(await newer, "committed");
  assert.deepEqual(
    writes,
    [[["statistics_block_order", ["bar"]]]],
    "an older repair for the same key must recheck its token before writing",
  );
}

async function auditStaleLoadAndRepair(): Promise<void> {
  const { coordinator, writes } = createHarness();
  const staleLoad = coordinator.captureLoadToken();
  const mutation = coordinator.submit({
    scope: "askSkipReason",
    value: false,
  });
  assert.equal(
    coordinator.replaceConfirmedSnapshot(
      createSettingsMutationSnapshot(DEFAULT_SETTINGS),
      staleLoad,
    ),
    false,
    "a read started before a local intent must not replace visible baselines",
  );
  await mutation.completion;

  const repair = coordinator.scheduleRepair([
    {
      entry: ["ask_skip_reason", true],
      scopes: ["askSkipReason"],
    },
  ]);
  const newerIntent = coordinator.submit({
    scope: "askSkipReason",
    value: true,
  });
  assert.equal(await repair, "superseded");
  await newerIntent.completion;
  await coordinator.whenIdle();
  assert.equal(
    writes.filter((batch) => batch[0]?.[0] === "ask_skip_reason").length,
    2,
    "the stale repair must not add a third settings write",
  );

  const resetRepair = coordinator.scheduleRepair([
    { entry: ["theme", "dark"], scopes: ["theme"] },
  ]);
  coordinator.replaceConfirmedSnapshot(
    createSettingsMutationSnapshot({ ...DEFAULT_SETTINGS, theme: "light" }),
  );
  assert.equal(await resetRepair, "superseded");
}

async function auditLoadCannotOvertakeRegisteredMutation(): Promise<void> {
  const write = deferred<void>();
  let writeStarted = false;
  const { coordinator } = createHarness({
    async write() {
      writeStarted = true;
      await write.promise;
    },
  });
  const pendingMutation = coordinator.submit({
    scope: "theme",
    value: "dark",
  });

  let tokenResolved = false;
  const tokenPromise = coordinator.captureSettledLoadToken().then((token) => {
    tokenResolved = true;
    return token;
  });
  await flushMicrotasks();
  assert.equal(writeStarted, true);
  assert.equal(
    tokenResolved,
    false,
    "a load token must not resolve while an older registered write is pending",
  );

  write.resolve();
  await pendingMutation.completion;
  const token = await tokenPromise;
  assert.equal(coordinator.isLoadTokenCurrent(token), true);
  assert.equal(coordinator.getConfirmedValue("theme"), "dark");
}

async function auditDurabilityDoesNotWaitForNativeEffect(): Promise<void> {
  const languageEffect = deferred<void>();
  let effectStarted = false;
  const { coordinator } = createHarness({
    async changeLanguage() {
      effectStarted = true;
      return languageEffect.promise;
    },
  });

  const submission = coordinator.submit({
    scope: "language",
    value: "pl",
  });
  const result = await submission.completion;
  assert.equal(result.status, "committed");
  await coordinator.whenIdle();
  await flushMicrotasks();
  assert.equal(effectStarted, true);
  assert.equal(
    coordinator.getConfirmedValue("language"),
    "pl",
    "durable baseline must settle independently from a slow global side effect",
  );
  languageEffect.resolve();
  await coordinator.whenEffectsIdle();
}

async function auditSideEffectLastIntentWins(): Promise<void> {
  const firstEffect = deferred<void>();
  const appliedLanguages: string[] = [];
  let effectCount = 0;
  const { coordinator } = createHarness({
    async changeLanguage(language) {
      appliedLanguages.push(language);
      effectCount += 1;
      if (effectCount === 1) await firstEffect.promise;
    },
  });

  const first = coordinator.submit({
    scope: "language",
    value: "pl",
  });
  await first.completion;
  await flushMicrotasks();
  assert.deepEqual(appliedLanguages, ["pl"]);

  const latest = coordinator.submit({
    scope: "language",
    value: "de",
  });
  assert.equal((await latest.completion).status, "committed");
  firstEffect.resolve();
  await coordinator.whenEffectsIdle();
  assert.deepEqual(
    appliedLanguages,
    ["pl", "de"],
    "a newer global side effect must reconcile after an older in-flight one",
  );
}

async function auditFailedSideEffectReconciliation(): Promise<void> {
  const appliedLanguages: string[] = [];
  let fail = true;
  const { coordinator, effectErrors } = createHarness({
    async changeLanguage(language) {
      appliedLanguages.push(language);
      if (fail) throw new Error("native language apply failed");
    },
  });

  const submission = coordinator.submit({ scope: "language", value: "de" });
  assert.equal((await submission.completion).status, "committed");
  await coordinator.whenEffectsIdle();
  assert.deepEqual(appliedLanguages, ["de"]);
  assert.equal(effectErrors.length, 1);

  await coordinator.whenEffectsIdle();
  assert.deepEqual(
    appliedLanguages,
    ["de"],
    "a failed native effect must remain dormant instead of hot-looping",
  );

  fail = false;
  coordinator.retryFailedSideEffects();
  await coordinator.whenEffectsIdle();
  assert.deepEqual(
    appliedLanguages,
    ["de", "de"],
    "foreground reconciliation must retry the latest failed effect once",
  );

  coordinator.retryFailedSideEffects();
  await coordinator.whenEffectsIdle();
  assert.deepEqual(
    appliedLanguages,
    ["de", "de"],
    "a successful reconciliation must retire its dirty marker",
  );
}

async function auditNewIntentSupersedesFailedSideEffect(): Promise<void> {
  const appliedLanguages: string[] = [];
  let first = true;
  const { coordinator } = createHarness({
    async changeLanguage(language) {
      appliedLanguages.push(language);
      if (first) {
        first = false;
        throw new Error("old language failed");
      }
    },
  });

  await coordinator.submit({ scope: "language", value: "de" }).completion;
  await coordinator.whenEffectsIdle();
  await coordinator.submit({ scope: "language", value: "pl" }).completion;
  await coordinator.whenEffectsIdle();
  coordinator.retryFailedSideEffects();
  await coordinator.whenEffectsIdle();

  assert.deepEqual(
    appliedLanguages,
    ["de", "pl"],
    "a newer successful intent must supersede, not replay, an older failed effect",
  );
}

async function auditLoadedReminderEffectIsTracked(): Promise<void> {
  const { coordinator, reminderEffects } = createHarness();
  const loaded = createSettingsMutationSnapshot({
    ...DEFAULT_SETTINGS,
    reminderNotificationsEnabled:
      !DEFAULT_SETTINGS.reminderNotificationsEnabled,
  });
  coordinator.replaceConfirmedSnapshot(loaded);
  coordinator.reconcileConfirmedSideEffect("reminderNotifications");
  await coordinator.whenEffectsIdle();
  assert.deepEqual(reminderEffects, [
    {
      enabled: !DEFAULT_SETTINGS.reminderNotificationsEnabled,
      phase: "reconcile",
    },
  ]);
}

function auditOwnership(): void {
  const root = path.resolve(__dirname, "..");
  const store = fs.readFileSync(
    path.join(root, "src", "stores", "settings-store.ts"),
    "utf8",
  );
  const repository = fs.readFileSync(
    path.join(root, "src", "data", "sqlite", "settings-repository.ts"),
    "utf8",
  );
  const repositoryPort = fs.readFileSync(
    path.join(
      root,
      "src",
      "application",
      "settings",
      "settings-repository-port.ts",
    ),
    "utf8",
  );
  const composition = fs.readFileSync(
    path.join(root, "src", "composition", "settings.ts"),
    "utf8",
  );
  const coordinator = fs.readFileSync(
    path.join(
      root,
      "src",
      "application",
      "settings",
      "settings-mutation-coordinator.ts",
    ),
    "utf8",
  );
  const inlineDescription = fs.readFileSync(
    path.join(
      root,
      "src",
      "features",
      "habit-detail",
      "components",
      "InlineDescription.tsx",
    ),
    "utf8",
  );
  const habitStore = fs.readFileSync(
    path.join(root, "src", "stores", "habit-store.ts"),
    "utf8",
  );
  const removedUtilityPath = path.join(
    root,
    "src",
    "utils",
    "habit-description-settings.ts",
  );
  assert.match(store, /settingsMutationCoordinator\.submit/);
  assert.match(store, /readPersistedSettings\(\)/);
  assert.match(
    store,
    /await settingsMutationCoordinator\.captureSettledLoadToken\(\)[\s\S]{0,120}readPersistedSettings\(\)/,
  );
  assert.match(
    composition,
    /export async function waitForAllPendingSettingsEffects[\s\S]{0,140}settingsMutationCoordinator\.whenEffectsIdle\(\)/,
  );
  assert.match(
    composition,
    /export function capturePendingSettingsWriteFence[\s\S]{0,120}settingsMutationCoordinator\.captureDurableFence\(\)/,
  );
  assert.match(
    composition,
    /export async function waitForPendingSettingsWritesThrough[\s\S]{0,180}settingsMutationCoordinator\.whenDurableThrough\(fence\)/,
    "export must have an exact settings cutoff that ignores later intents",
  );
  assert.match(
    composition,
    /export function releasePendingSettingsWriteFence[\s\S]{0,180}mode: SettingsDurableFenceReleaseMode[\s\S]{0,160}settingsMutationCoordinator\.releaseDurableFence\(fence, mode\)/,
    "the snapshot owner must explicitly resume or discard post-cutoff settings writes",
  );
  assert.match(
    store,
    /mode === "settled"[\s\S]{0,100}settingsMutationCoordinator\.captureSettledLoadToken\(\)[\s\S]{0,100}: null/,
    "committed import must read its committed rows without waiting on post-cutoff commands held by the import fence",
  );
  assert.match(
    store,
    /const loadSettingsSnapshot = settingsActions\.loadSettings[\s\S]{0,600}export function loadSettingsFromCommittedImport\(\): Promise<boolean> \{[\s\S]{0,100}loadSettingsSnapshot\("committed-import"\)/,
    "committed import must use the dedicated non-deadlocking publication mode",
  );
  assert.match(
    store,
    /interface SettingsStore[\s\S]{0,700}loadSettings\(\): Promise<boolean>/,
    "the public settings store must not expose import-only load modes",
  );
  assert.match(
    coordinator,
    /private async executeCommand[\s\S]*await this\.waitForDurableGate\(durableSequence\)/,
    "commands must cross the active durable fence before repository dispatch",
  );
  assert.match(
    coordinator,
    /!this\.isCurrent\(command\.scope, revision\)\s*&&\s*!this\.isDurableSequencePinned\(durableSequence\)/,
    "a fence must pin accepted pre-cutoff commands even after a newer optimistic intent",
  );
  assert.match(
    coordinator,
    /if \(this\.discardedDurableSequences\.has\(durableSequence\)\)[\s\S]{0,220}return this\.createResult<Scope>\(/,
    "a committed import must discard post-cutoff commands before any repository write",
  );
  const commitOpportunityIndex = coordinator.indexOf(
    "await this.dependencies.waitForCommitOpportunity();",
  );
  const repositoryDispatchIndex = coordinator.indexOf(
    'if (persistence.kind === "write")',
    commitOpportunityIndex,
  );
  assert.ok(
    commitOpportunityIndex >= 0 &&
      repositoryDispatchIndex > commitOpportunityIndex,
    "every settings command must leave a complete paint/background-safe opportunity before SQLite",
  );
  assert.match(
    composition,
    /waitForCommitOpportunity: \(\) =>[\s\S]{0,100}persistenceCommitScheduler\.waitForCommitOpportunity\(\)/,
    "settings must reuse the shared AppState-safe persistence scheduler",
  );
  assert.equal(
    fs.existsSync(removedUtilityPath),
    false,
    "the former direct-SQL description cache must be deleted, not retained as an alias",
  );
  assert.match(
    inlineDescription,
    /from "@\/composition\/settings"/,
    "InlineDescription must reach persistence only through composition/application",
  );
  assert.doesNotMatch(inlineDescription, /@\/data\/|@\/db\/|runtimeDb/);
  let deletionBoundary = habitStore.indexOf(
    "await habitPersistence.deleteHabits(deletedIdList);",
  );
  assert.ok(deletionBoundary >= 0, "habit deletion must await its atomic row commit");
  for (const publication of [
    "forgetHabitScheduleWriteRevisions(deletedIdList);",
    'invalidateNotesProjection(id, { kind: "habit-deleted" });',
    "publishDeletedHabitDescriptionLines(deletedIds);",
  ]) {
    const position = habitStore.indexOf(publication, deletionBoundary);
    assert.ok(
      position > deletionBoundary,
      "habit deletion must publish cache cleanup only after its atomic row deletion commits",
    );
    deletionBoundary = position;
  }
  assert.match(
    store,
    /const habitDescriptionLines = parsePersistedDescriptionLines\(rows\);[\s\S]{0,8000}createSettingsMutationSnapshot\([\s\S]{0,100}loadedSettings,[\s\S]{0,100}habitDescriptionLines/,
    "bootstrap/import must parse description rows without mutating live cache before token acceptance",
  );
  assert.doesNotMatch(
    store,
    /latestSettingMutationIds|confirmedTheme|pendingSettingsPersistence|reminderLocalizationRefreshTask/,
  );
  assert.doesNotMatch(
    store,
    /whenEffectsIdle\(\)\.then/,
    "the language setter must not register global reminder work after the effect fence resolves",
  );
  assert.match(
    composition,
    /Promise\.resolve\(change\)\.then\(\s*\(\) => \{[\s\S]{0,500}scheduleReminderNotificationLocalizationRefresh\(\)/,
    "language apply and rollback must register global reminder work before their settings effect settles",
  );
  const loadedSnapshotPublish = store.search(/set\(\{\s*\.\.\.loadedSettings,/);
  const loadedPlatformRegistration = store.indexOf(
    "registerLoadedSettingsPlatformEffects();",
    loadedSnapshotPublish,
  );
  assert.ok(
    loadedSnapshotPublish >= 0 &&
      loadedPlatformRegistration > loadedSnapshotPublish &&
      loadedPlatformRegistration - loadedSnapshotPublish < 500,
    "a loaded snapshot must synchronously register its tracked platform reconciliation",
  );
  assert.match(
    composition,
    /registerLoadedSettingsPlatformEffects[\s\S]{0,220}scheduleReminderNotificationLocalizationRefresh\(\);[\s\S]{0,180}reconcileConfirmedSideEffect\([\s\S]{0,80}"reminderNotifications"/,
    "load-time reminder master work must enter the coordinator effect registry",
  );
  assert.doesNotMatch(
    store,
    /@\/data\/|@\/db\/|@\/i18n\/config|@\/utils\/reminder-notifications|new SettingsMutationCoordinator/,
    "the settings store must not compose concrete persistence, i18n, or reminder adapters",
  );
  assert.match(
    store,
    /case SETTINGS_KEYS\.STATISTICS_BLOCK_ORDER:\s*[\s\S]{0,320}return \[\];/,
    "the legacy statistics compatibility row must remain independent from visible period mutations",
  );
  assert.match(
    store,
    /type RepairableSettingsKey[\s\S]{0,120}typeof SETTINGS_KEYS[\s\S]{0,120}function assertNeverRepairKey/,
    "future settings keys must be added to an exhaustive repair ownership map",
  );
  assert.match(
    store,
    /default:\s*return assertNeverRepairKey\(key\);/,
    "unknown future repair keys must fail fast instead of becoming stale unowned repairs",
  );
  assert.match(
    store,
    /scopes: getRepairMutationScopes\(entry\[0\]\)/,
    "load repairs must use the audited ownership mapping from persisted key to mutation scope",
  );
  assert.doesNotMatch(
    coordinator,
    /command\.entries|command\.effect/,
    "SQLite rows and native effects must be derived from one typed command value",
  );
  assert.doesNotMatch(store, /runAfterUiPaint/);
  assert.doesNotMatch(
    coordinator,
    /requestAnimationFrame|runAfterUiPaint|setTimeout/,
    "durable settings work must not depend on a timer/RAF that can pause in background",
  );
  assert.match(repository, /INSERT INTO settings/);
  assert.match(repository, /ON CONFLICT\(key\) DO UPDATE/);
  assert.match(
    repository,
    /deleteSqliteRowsByValues\([\s\S]{0,160}table: "settings", column: "key"/,
    "large settings cleanup must stay below SQLite's bind-variable limit",
  );
  assert.match(
    repository,
    /keys\.length <= SQLITE_DELETE_BIND_CHUNK_SIZE[\s\S]{0,220}runtimeDb\.transaction\(deleteFrom\)/,
    "multi-chunk settings cleanup must preserve the old all-or-nothing delete",
  );
  assert.doesNotMatch(repository, /DELETE FROM settings WHERE key IN/);
  assert.match(
    repository,
    /from "@\/application\/settings\/settings-repository-port"/,
    "the SQLite adapter must depend on the inward application port",
  );
  assert.match(
    repository,
    /settingsRepository: SettingsRepositoryPort = \{[\s\S]{0,120}readAll,[\s\S]{0,80}write,[\s\S]{0,80}delete: deleteKeys/,
    "the SQLite adapter must implement the inward application port",
  );
  assert.doesNotMatch(
    repository,
    /export (?:type SettingsWriteEntry|interface SettingsRepository\b)/,
    "the SQLite adapter must not define a parallel persistence contract",
  );
  assert.match(repositoryPort, /export interface SettingsRepositoryPort/);
  assert.match(
    repositoryPort,
    /delete\(keys: readonly string\[\]\): Promise<void>/,
  );
}

async function main(): Promise<void> {
  await auditAtoBtoA();
  await auditOldCommitLatestFailure();
  await auditSharedCommitOpportunity();
  await auditDescriptionLinesExactFence();
  await auditDescriptionLinesFirstFailureAndRapidSupersession();
  await auditDescriptionLinesCommittedImportWins();
  await auditDescriptionLinesRollbackAndStaleLoad();
  await auditDescriptionLinesDeletionCleanup();
  await auditColorBundle();
  await auditColorSelectionCannotSkipChangedStructure();
  await auditQueuedCommandOwnsItsPayload();
  await auditStaleLoadAndRepair();
  await auditDeferredRepairFlushNow();
  await auditDurableFenceCutoff();
  await auditDurableFenceFlushesRegisteredRepair();
  await auditFencePinsPreCutoffIntent();
  await auditCommittedImportDiscardsPostCutoffIntent();
  await auditCommittedImportDiscardsPostCutoffRepair();
  await auditOverlappingFencesFailFast();
  await auditColorSelectionAbsorbsDirtyStructure();
  await auditLegacyStatisticsRepairIsIndependent();
  await auditNewerRepairSupersedesOlderSameKey();
  await auditLoadCannotOvertakeRegisteredMutation();
  await auditDurabilityDoesNotWaitForNativeEffect();
  await auditSideEffectLastIntentWins();
  await auditFailedSideEffectReconciliation();
  await auditNewIntentSupersedesFailedSideEffect();
  await auditLoadedReminderEffectIsTracked();
  auditOwnership();
  console.log("Settings mutation coordinator audit passed.");
}

void withAuditDeadline(main, "Settings mutation coordinator audit").catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
