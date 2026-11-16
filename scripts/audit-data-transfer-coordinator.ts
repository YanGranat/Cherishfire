import assert from "node:assert/strict";
import { withAuditDeadline } from "./fixtures/with-audit-deadline";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";

import {
  DataTransferCoordinator,
  DataTransferBusyError,
  DataTransferPublicationBlockedError,
  bindDurableMutationFenceOwner,
  createCompositeDurableMutationFencePort,
  readExportSnapshotAtFence,
  replaceImportedDataAtFence,
  type DurableMutationFenceOutcome,
  type DurableMutationFencePort,
} from "../src/application/data-transfer/data-transfer-coordinator";
import { DataTransferService } from "../src/application/data-transfer/data-transfer-service";
import type { NormalizedImportData } from "../src/application/data-transfer/data-transfer-model";
import { shouldPublishHabitLoadError } from "../src/stores/habit-load-options";
import { canConsumeHabitStoreError } from "../src/stores/habit-error-consumption";
import {
  closeDataTransferOverlay,
  createEmptyDataTransferOverlaySlot,
  createSynchronousActionFence,
  enqueueDataTransferOverlay,
  settleDataTransferOverlayDismissal,
} from "../src/features/habits/utils/data-transfer-overlay-slot";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function auditExactExportCutoff(): Promise<void> {
  const order: string[] = [];
  let currentRevision = 4;
  const durableMutations: DurableMutationFencePort<number> = {
    capture() {
      order.push(`capture:${currentRevision}`);
      return currentRevision;
    },
    async waitThrough(fence) {
      order.push(`wait:${fence}`);
      // A later accepted intent must not move the already captured cutoff.
      currentRevision = 5;
    },
    release(fence, outcome) {
      order.push(`release:${fence}:${outcome}`);
    },
  };

  const snapshot = await readExportSnapshotAtFence({
    durableMutations,
    async readConsistentSnapshot() {
      order.push("snapshot");
      return "database-revision-4";
    },
  });

  assert.equal(snapshot, "database-revision-4");
  assert.deepEqual(order, [
    "capture:4",
    "wait:4",
    "snapshot",
    "release:4:export-finished",
  ]);

  order.length = 0;
  await assert.rejects(
    readExportSnapshotAtFence({
      durableMutations,
      readConsistentSnapshot: async () => {
        throw new Error("snapshot failed");
      },
    }),
    /snapshot failed/,
  );
  assert.equal(
    order.at(-1),
    "release:5:export-finished",
    "snapshot failures must reopen the durable gate",
  );
}

async function auditCompositeFence(): Promise<void> {
  const order: string[] = [];
  const owner = (name: string): DurableMutationFencePort<string> => ({
    capture() {
      order.push(`capture:${name}`);
      return name;
    },
    async waitThrough() {
      order.push(`wait:${name}`);
    },
    release(_fence, outcome) {
      order.push(`release:${name}:${outcome}`);
    },
  });
  const composite = createCompositeDurableMutationFencePort([
    bindDurableMutationFenceOwner(owner("habit")),
    bindDurableMutationFenceOwner(owner("notes")),
    bindDurableMutationFenceOwner(owner("settings")),
  ]);
  const fence = composite.capture();
  assert.deepEqual(order, [
    "capture:habit",
    "capture:notes",
    "capture:settings",
  ]);
  await composite.waitThrough(fence);
  composite.release(fence, "export-finished");
  assert.deepEqual(order.slice(-3), [
    "release:settings:export-finished",
    "release:notes:export-finished",
    "release:habit:export-finished",
  ]);

  order.length = 0;
  const brokenOwner: DurableMutationFencePort<string> = {
    capture() {
      throw new Error("capture failed");
    },
    waitThrough: async () => undefined,
    release() {},
  };
  const partial = createCompositeDurableMutationFencePort([
    bindDurableMutationFenceOwner(owner("first")),
    bindDurableMutationFenceOwner(brokenOwner),
  ]);
  assert.throws(() => partial.capture(), /capture failed/);
  assert.deepEqual(order, ["capture:first", "release:first:import-aborted"]);
}

async function auditSuccessfulImportOrdering(): Promise<void> {
  const order: string[] = [];
  const applicationEffect = deferred<void>();
  const platformEffect = deferred<void>();

  const outcome = await replaceImportedDataAtFence({
    durableMutations: {
      capture() {
        order.push("capture");
        return 12;
      },
      async waitThrough(fence) {
        assert.equal(fence, 12);
        order.push("durable:start");
        applicationEffect.resolve();
        order.push("durable:end");
      },
      release(_fence, result) {
        order.push(`release:${result}`);
      },
    },
    async waitForApplicationEffects() {
      order.push("application:start");
      await applicationEffect.promise;
      platformEffect.resolve();
      order.push("application:end");
    },
    async enterPlatformReplacementBoundary() {
      order.push("platform:start");
      await platformEffect.promise;
      order.push("platform:end");
      return {
        async release(outcome) {
          order.push(`platform-release:${outcome}`);
        },
      };
    },
    async replaceAtomically() {
      order.push("replace");
      return "committed" as const;
    },
    async publishCommittedSnapshot() {
      order.push("publish");
    },
    async reconcileCommittedPlatformState() {
      order.push("reconcile");
    },
  });

  assert.deepEqual(outcome, { status: "published", result: "committed" });
  assert.deepEqual(order, [
    "capture",
    "durable:start",
    "durable:end",
    "application:start",
    "application:end",
    "platform:start",
    "platform:end",
    "replace",
    "publish",
    "release:import-committed",
    "platform-release:import-committed",
    "reconcile",
  ]);
}

async function auditPreCommitFailures(): Promise<void> {
  let published = false;
  let releaseOutcome: DurableMutationFenceOutcome | null = null;
  await assert.rejects(
    replaceImportedDataAtFence({
      durableMutations: {
        capture: () => 1,
        waitThrough: async () => undefined,
        release(_fence, outcome) {
          releaseOutcome = outcome;
        },
      },
      waitForApplicationEffects: async () => undefined,
      enterPlatformReplacementBoundary: async () => ({
        async release(outcome) {
          assert.equal(outcome, "import-aborted");
        },
      }),
      replaceAtomically: async () => {
        throw new Error("transaction rollback");
      },
      async publishCommittedSnapshot() {
        published = true;
      },
      reconcileCommittedPlatformState: async () => undefined,
    }),
    /transaction rollback/,
  );
  assert.equal(published, false);
  assert.equal(releaseOutcome, "import-aborted");

  let replacementStarted = false;
  await assert.rejects(
    replaceImportedDataAtFence({
      durableMutations: {
        capture: () => 1,
        waitThrough: async () => undefined,
        release(_fence, outcome) {
          assert.equal(outcome, "import-aborted");
        },
      },
      waitForApplicationEffects: async () => undefined,
      enterPlatformReplacementBoundary: async () => {
        throw new Error("platform fence failed");
      },
      replaceAtomically: async () => {
        replacementStarted = true;
      },
      publishCommittedSnapshot: async () => undefined,
      reconcileCommittedPlatformState: async () => undefined,
    }),
    /platform fence failed/,
  );
  assert.equal(replacementStarted, false);
}

async function auditPublicationRecoveryAndReusedIds(): Promise<void> {
  let databaseRow = "old-id-1";
  let releaseOutcome: DurableMutationFenceOutcome | null = null;
  let platformReleaseOutcome: string | null = null;
  let publicationAttempts = 0;
  let platformReconciliations = 0;
  const postCutoffReleased = deferred<boolean>();

  const outcome = await replaceImportedDataAtFence({
    durableMutations: {
      capture: () => ({ cutoff: 1 }),
      waitThrough: async () => undefined,
      release(_fence, result) {
        releaseOutcome = result;
        postCutoffReleased.resolve(result === "import-committed");
      },
    },
    waitForApplicationEffects: async () => undefined,
    enterPlatformReplacementBoundary: async () => ({
      async release(outcome) {
        platformReleaseOutcome = outcome;
      },
    }),
    async replaceAtomically() {
      databaseRow = "imported-id-1";
      return { importedId: 1 };
    },
    async publishCommittedSnapshot() {
      publicationAttempts += 1;
      if (publicationAttempts === 1) throw new Error("reload failed");
    },
    async reconcileCommittedPlatformState() {
      platformReconciliations += 1;
    },
  });

  assert.equal(outcome.status, "publication-blocked");
  assert.equal(
    releaseOutcome,
    null,
    "a failed publication must keep the gate closed",
  );
  assert.equal(
    platformReleaseOutcome,
    null,
    "a failed publication must keep native reminder admission frozen",
  );

  // This models a rapid command against the old in-memory object whose ID is
  // reused by imported data. It must remain gated and then be discarded.
  let oldCommandMutatedImportedRow = false;
  const oldCommand = postCutoffReleased.promise.then((discarded) => {
    if (!discarded) {
      databaseRow = "late-old-command";
      oldCommandMutatedImportedRow = true;
    }
  });
  await Promise.resolve();
  assert.equal(databaseRow, "imported-id-1");

  if (outcome.status !== "publication-blocked") {
    throw new Error("Expected blocked publication outcome");
  }
  await outcome.retryPublication();
  await oldCommand;
  assert.equal(publicationAttempts, 2);
  assert.equal(releaseOutcome, "import-committed");
  assert.equal(platformReleaseOutcome, "import-committed");
  assert.equal(platformReconciliations, 1);
  assert.equal(oldCommandMutatedImportedRow, false);
  assert.equal(databaseRow, "imported-id-1");
}

async function auditSingleFlightTransfers(): Promise<void> {
  const firstSnapshotGate = deferred<void>();
  const events: string[] = [];
  let revision = 0;
  const coordinator = new DataTransferCoordinator({
    capture() {
      const fence = ++revision;
      events.push(`capture:${fence}`);
      return fence;
    },
    waitThrough: async () => undefined,
    release(fence) {
      events.push(`release:${fence}`);
    },
  });

  const first = coordinator.readExportSnapshot({
    async readConsistentSnapshot() {
      events.push("snapshot:1:start");
      await firstSnapshotGate.promise;
      events.push("snapshot:1:end");
      return 1;
    },
  });
  await Promise.resolve();
  assert.deepEqual(events, ["capture:1", "snapshot:1:start"]);
  await assert.rejects(
    coordinator.readExportSnapshot({
      async readConsistentSnapshot() {
        events.push("snapshot:duplicate");
        return 2;
      },
    }),
    DataTransferBusyError,
  );
  await assert.rejects(
    coordinator.replaceImportedData({
      waitForApplicationEffects: async () => {
        throw new Error("unreachable");
      },
      enterPlatformReplacementBoundary: async () => {
        throw new Error("unreachable");
      },
      replaceAtomically: async () => {
        throw new Error("unreachable");
      },
      publishCommittedSnapshot: async () => {
        throw new Error("unreachable");
      },
      reconcileCommittedPlatformState: async () => {
        throw new Error("unreachable");
      },
    }),
    DataTransferBusyError,
  );
  assert.deepEqual(
    events,
    ["capture:1", "snapshot:1:start"],
    "a duplicate request must be rejected before a second fence or snapshot",
  );
  firstSnapshotGate.resolve();
  assert.equal(await first, 1);
  assert.deepEqual(events, [
    "capture:1",
    "snapshot:1:start",
    "snapshot:1:end",
    "release:1",
  ]);

  let attempts = 0;
  const blocked = await coordinator.replaceImportedData({
    waitForApplicationEffects: async () => undefined,
    enterPlatformReplacementBoundary: async () => ({
      release: async () => undefined,
    }),
    replaceAtomically: async () => "imported",
    async publishCommittedSnapshot() {
      attempts += 1;
      if (attempts === 1) throw new Error("publish failed");
    },
    reconcileCommittedPlatformState: async () => undefined,
  });
  assert.equal(blocked.status, "publication-blocked");
  await assert.rejects(
    coordinator.readExportSnapshot({
      readConsistentSnapshot: async () => 3,
    }),
    DataTransferPublicationBlockedError,
  );
  if (blocked.status !== "publication-blocked") {
    throw new Error("Expected blocked publication outcome");
  }
  await Promise.all([blocked.retryPublication(), blocked.retryPublication()]);
  assert.equal(attempts, 2, "publication recovery must be single-flight");
  assert.equal(
    await coordinator.readExportSnapshot({
      readConsistentSnapshot: async () => 3,
    }),
    3,
  );

  let failCapture = true;
  const captureRecovery = new DataTransferCoordinator({
    capture() {
      if (failCapture) {
        failCapture = false;
        throw new Error("capture failed once");
      }
      return 1;
    },
    waitThrough: async () => undefined,
    release: () => undefined,
  });
  await assert.rejects(
    captureRecovery.readExportSnapshot({
      readConsistentSnapshot: async () => "unreachable",
    }),
    /capture failed once/,
  );
  assert.equal(
    await captureRecovery.readExportSnapshot({
      readConsistentSnapshot: async () => "recovered",
    }),
    "recovered",
    "a failed composite capture must not leave the single-flight admission locked",
  );
}

async function auditExportUseCaseCapturesBeforePlatformWork(): Promise<void> {
  const events: string[] = [];
  const service = new DataTransferService<{ fileName: string }>({
    readConsistentSnapshot() {
      events.push("snapshot-cutoff:capture");
      return Promise.resolve({
        habits: [],
        dayRecords: [],
        notes: [],
        settings: [],
      });
    },
    replaceSnapshot: async () => ({ status: "published", result: undefined }),
    async prepareExport(fileName, json) {
      events.push(`platform:prepare:${fileName}:${json.length > 0}`);
      return { fileName };
    },
    async sharePreparedExport(file) {
      events.push(`platform:share:${file.fileName}`);
    },
    now: () => new Date(2026, 7, 29, 12, 0, 0),
  });

  const request = service.exportAllData();
  const duplicate = service.exportAllData();
  assert.equal(
    duplicate,
    request,
    "two synchronous public use-case calls must coalesce into one export",
  );
  assert.deepEqual(
    events,
    ["snapshot-cutoff:capture"],
    "the exact export cutoff must be captured in the confirm call before any async platform work",
  );
  await request;
  assert.deepEqual(events, [
    "snapshot-cutoff:capture",
    "platform:prepare:cherishfire_export_2026-08-29.json:true",
    "platform:share:cherishfire_export_2026-08-29.json",
  ]);
  assert.equal(
    events.filter((event) => event.startsWith("platform:share:")).length,
    1,
    "a coalesced duplicate must not create a second share lifecycle",
  );
  await service.exportAllData();
  assert.equal(
    events.filter((event) => event === "snapshot-cutoff:capture").length,
    2,
    "the coalescing slot must reopen after the first share flow settles",
  );

  let failSharing = true;
  let shareAttempts = 0;
  const coldShareFailure = new DataTransferService<{ fileName: string }>({
    readConsistentSnapshot: async () => ({
      habits: [],
      dayRecords: [],
      notes: [],
      settings: [],
    }),
    replaceSnapshot: async () => ({ status: "published", result: undefined }),
    prepareExport: async (fileName) => ({ fileName }),
    async sharePreparedExport() {
      // Models a rejected cold platform import before shareAsync is callable.
      shareAttempts += 1;
      if (failSharing) throw new Error("sharing module unavailable");
    },
    now: () => new Date(2026, 7, 29, 12, 0, 0),
  });
  await assert.rejects(
    coldShareFailure.exportAllData(),
    /sharing module unavailable/,
  );
  failSharing = false;
  await coldShareFailure.exportAllData();
  assert.equal(
    shareAttempts,
    2,
    "a failed share must release the export slot for retry",
  );
}

async function auditImportUseCaseCoalescesRapidApply(): Promise<void> {
  const replacementGate = deferred<void>();
  let replacements = 0;
  const service = new DataTransferService<never>({
    readConsistentSnapshot: async () => ({
      habits: [],
      dayRecords: [],
      notes: [],
      settings: [],
    }),
    async replaceSnapshot() {
      replacements += 1;
      await replacementGate.promise;
      return { status: "published", result: undefined };
    },
    prepareExport: async () => {
      throw new Error("unreachable");
    },
    sharePreparedExport: async () => undefined,
    now: () => new Date(2026, 7, 29, 12, 0, 0),
  });
  const data = {} as NormalizedImportData;
  const publish = async () => undefined;
  const first = service.importNormalizedData(data, publish);
  const duplicate = service.importNormalizedData(data, publish);
  assert.equal(
    duplicate,
    first,
    "rapid Apply taps must share one database replacement flow",
  );
  assert.deepEqual(
    await service.importNormalizedData({} as NormalizedImportData, publish),
    {
      success: false,
      error: "Another data transfer is already in progress",
    },
    "a different import must not receive the first file's eventual result",
  );
  assert.equal(replacements, 1);
  replacementGate.resolve();
  assert.deepEqual(await first, { success: true });
}

function auditExclusiveOverlaySlotAndStatusQueue(): void {
  type Request = {
    readonly kind: "status" | "preview";
    readonly id: number;
  };
  let slot = createEmptyDataTransferOverlaySlot<Request>();
  slot = enqueueDataTransferOverlay(slot, { kind: "status", id: 1 });
  slot = enqueueDataTransferOverlay(slot, { kind: "status", id: 2 });
  slot = enqueueDataTransferOverlay(slot, { kind: "preview", id: 3 });
  assert.equal(slot.phase, "visible");
  assert.deepEqual(slot.current, { kind: "status", id: 1 });
  assert.deepEqual(slot.queue, [
    { kind: "status", id: 2 },
    { kind: "preview", id: 3 },
  ]);

  const wrongClose = closeDataTransferOverlay(slot, "preview");
  assert.equal(
    wrongClose,
    slot,
    "a stale dialog callback must not close its neighbour",
  );
  slot = closeDataTransferOverlay(slot, "status");
  assert.equal(slot.phase, "closing");
  assert.deepEqual(
    slot.current,
    { kind: "status", id: 1 },
    "the fading dialog must retain its own payload",
  );
  slot = enqueueDataTransferOverlay(slot, { kind: "status", id: 4 });
  assert.deepEqual(
    slot.queue.map((request) => request.id),
    [2, 3, 4],
    "a new status must be retained FIFO while another dialog dismisses",
  );

  const wrongDismiss = settleDataTransferOverlayDismissal(slot, "preview");
  assert.equal(
    wrongDismiss,
    slot,
    "a late onDismiss from another surface must not advance the queue",
  );
  slot = settleDataTransferOverlayDismissal(slot, "status");
  assert.equal(slot.phase, "visible");
  assert.deepEqual(slot.current, { kind: "status", id: 2 });
  slot = settleDataTransferOverlayDismissal(
    closeDataTransferOverlay(slot, "status"),
    "status",
  );
  assert.deepEqual(slot.current, { kind: "preview", id: 3 });
  slot = settleDataTransferOverlayDismissal(
    closeDataTransferOverlay(slot, "preview"),
    "preview",
  );
  assert.deepEqual(slot.current, { kind: "status", id: 4 });
  slot = settleDataTransferOverlayDismissal(
    closeDataTransferOverlay(slot, "status"),
    "status",
  );
  assert.deepEqual(slot, createEmptyDataTransferOverlaySlot<Request>());
}

function auditFirstOwnerSynchronousFence(): void {
  const fence = createSynchronousActionFence();
  const first = fence.tryAcquire();
  assert.ok(first != null && first > 0);
  assert.equal(fence.tryAcquire(), null);
  assert.equal(
    fence.getOwner(),
    first,
    "a duplicate must never supersede an already-started owner",
  );
  fence.release(first + 1);
  assert.equal(
    fence.tryAcquire(),
    null,
    "only the owner may release the fence",
  );
  fence.release(first);
  assert.equal(fence.getOwner(), null);
  const second = fence.tryAcquire();
  assert.ok(second != null && second > first);
  fence.release(first);
  assert.equal(
    fence.getOwner(),
    second,
    "a stale completion must not release a later owner",
  );
  fence.release(second);
}

async function auditCommittedImportUiOwnership(): Promise<void> {
  type Request =
    | { kind: "import-preview"; data: NormalizedImportData }
    | { kind: "status"; importRequestToken?: number };
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      "../src/features/habits/components/HomeDataTransferOverlayController.tsx",
    ),
    "utf8",
  );
  const tree = ts.createSourceFile(
    "controller.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const effectBodies: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "useLayoutEffect"
    ) {
      const callback = node.arguments[0]?.getText(tree);
      if (callback?.includes("pendingImportApplyTokenRef"))
        effectBodies.push(callback);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.equal(
    effectBodies.length,
    1,
    "one committed layout effect must own import admission release",
  );
  const slotContainsStatusForImport = loadSourceCallableForAudit<
    (
      slot: ReturnType<typeof createEmptyDataTransferOverlaySlot<Request>>,
      token: number,
    ) => boolean
  >(source, "slotContainsStatusForImport", {});
  const translate = (key: string) => key;
  const createStatusRequest = loadSourceCallableForAudit<
    (
      status: Record<string, unknown>,
      translator: typeof translate,
      token?: number,
    ) => Request
  >(source, "createStatusRequest", {
    currentTransferTranslator: () => translate,
  });

  const publicationSteps: unknown[][] = [];
  const publishImportedSnapshot = loadSourceCallableForAudit<() => Promise<void>>(
    source, "publishImportedSnapshot", {
      selectedDateRef: { current: "2031-04-05" },
      IMPORT_PRELOAD_DAY_RADIUS: 1,
      loadSettingsFromCommittedImport: async () => true,
      useHabitStore: { getState: () => ({
        resetInMemoryCaches: () => publicationSteps.push(["reset"]),
        loadHabits: async (options: unknown) => {
          publicationSteps.push(["habits", JSON.parse(JSON.stringify(options))]);
          return true;
        },
        loadAllDayRecords: async () => true,
        loadDayRecords: async (date: string) => {
          publicationSteps.push(["date", date]);
          return true;
        },
        preloadDayRecordsWindow: (date: string, radius: number) => {
          publicationSteps.push(["preload", date, radius]);
        },
      }) },
    },
  );
  await publishImportedSnapshot();
  assert.deepEqual(publicationSteps, [
    ["reset"],
    ["habits", { mode: "committed-import" }],
    ["date", "2031-04-05"],
    ["preload", "2031-04-05", 1],
  ], "only the committed-import publisher bypasses inherited write barriers");

  for (const recovery of [false, true]) {
    const applyImportFence = createSynchronousActionFence();
    const pendingImportApplyTokenRef = { current: null as number | null };
    const pendingImportPublicationRecoveryRef = {
      current: null as (() => Promise<void>) | null,
    };
    const overlaySlotRef = {
      current: enqueueDataTransferOverlay(
        createEmptyDataTransferOverlaySlot<Request>(),
        { kind: "import-preview", data: {} as NormalizedImportData },
      ),
    };
    let isImporting = false;
    let pendingImportError: string | null = null;
    let replacements = 0;
    let retries = 0;
    const gate = deferred<void>();
    const apply = loadSourceCallableForAudit<() => Promise<void>>(
      source,
      "applyImport",
      {
        applyImportFence,
        pendingImportApplyTokenRef,
        pendingImportPublicationRecoveryRef,
        overlaySlotRef,
        setIsImporting: (value: boolean) => {
          isImporting = value;
        },
        setPendingImportError: (value: string | null) => {
          pendingImportError = value;
        },
        currentTransferTranslator: () => translate,
        createStatusRequest,
        closeAndEnqueueOverlay(kind: Request["kind"], request: Request) {
          overlaySlotRef.current = closeDataTransferOverlay(
            enqueueDataTransferOverlay(overlaySlotRef.current, request),
            kind,
          );
        },
        async importNormalizedData() {
          replacements += 1;
          await gate.promise;
          return recovery
            ? {
                success: false,
                committed: true,
                error: "publication unavailable",
                retryPublication: async () => {
                  retries += 1;
                },
              }
            : { success: true };
        },
        console: { error: () => undefined },
      },
    );
    const commit = (slot = overlaySlotRef.current) => {
      loadSourceCallableForAudit<() => void>(
        `const settle = ${effectBodies[0]}`,
        "settle",
        {
          applyImportFence,
          pendingImportApplyTokenRef,
          isImporting,
          pendingImportError,
          overlaySlot: slot,
          slotContainsStatusForImport,
        },
      )();
    };
    const request = apply();
    const firstOwner = applyImportFence.getOwner();
    assert.ok(firstOwner != null);
    await apply();
    assert.equal(
      replacements,
      1,
      "duplicate Apply must not start another replacement",
    );
    commit();
    assert.equal(
      applyImportFence.getOwner(),
      firstOwner,
      "busy commit cannot release accepted import",
    );
    gate.resolve();
    await request;
    assert.equal(isImporting, false);
    assert.equal(
      applyImportFence.getOwner(),
      firstOwner,
      "an async result must not release admission before its terminal UI commits",
    );
    await apply();
    assert.equal(replacements, 1);
    if (!recovery) {
      commit(
        enqueueDataTransferOverlay(
          createEmptyDataTransferOverlaySlot<Request>(),
          { kind: "status", importRequestToken: firstOwner + 1 },
        ),
      );
      assert.equal(
        applyImportFence.getOwner(),
        firstOwner,
        "a foreign status cannot release import",
      );
    }
    commit();
    assert.equal(applyImportFence.getOwner(), null);
    assert.equal(pendingImportApplyTokenRef.current, null);
    if (recovery) {
      assert.ok(pendingImportPublicationRecoveryRef.current);
      await apply();
      assert.equal(
        replacements,
        1,
        "publication retry must not repeat committed database replacement",
      );
      assert.equal(retries, 1);
      assert.equal(pendingImportPublicationRecoveryRef.current, null);
      assert.ok(applyImportFence.getOwner() != null);
      commit();
      assert.equal(applyImportFence.getOwner(), null);
    }
  }
}

function auditRetryLoadErrorOwnership(): void {
  assert.equal(shouldPublishHabitLoadError(), true);
  assert.equal(shouldPublishHabitLoadError({}), true);
  assert.equal(
    shouldPublishHabitLoadError({ publishError: false }),
    false,
    "a retry whose controller owns the dialog must not publish a duplicate store error",
  );
  assert.equal(canConsumeHabitStoreError("A", 4, 4), true);
  assert.equal(
    canConsumeHabitStoreError("B", 5, 4),
    false,
    "a stale consumer for error A must not clear a later error B",
  );
  assert.equal(
    canConsumeHabitStoreError("same message", 6, 5),
    false,
    "revision ownership must preserve even a later error with identical text",
  );
  assert.equal(canConsumeHabitStoreError(null, 6, 6), false);
}

function auditHomeDataTransferPresentationContracts(): void {
  const root = path.resolve(__dirname, "..");
  const read = (relativePath: string) =>
    fs.readFileSync(path.join(root, relativePath), "utf8");
  const controller = read(
    "src/features/habits/components/HomeDataTransferOverlayController.tsx",
  );
  const home = read("app/index.tsx");
  const homeSnapshot = read(
    "src/features/habits/presentation/home-snapshot.ts",
  );
  const habitStore = read("src/stores/habit-store.ts");

  assert.match(controller, /onRetry\?: \(\) => Promise<boolean>/);
  assert.match(
    controller,
    /useLayoutEffect\(\(\) => \{\s*selectedDateRef\.current = selectedDate;\s*\}, \[selectedDate\]\)/,
    "selectedDateRef must only publish a committed selected-date render",
  );
  assert.doesNotMatch(
    controller,
    /const selectedDateRef = useRef\(selectedDate\);\s*selectedDateRef\.current = selectedDate/,
    "a render that React later abandons must not leak selectedDate into import publication",
  );
  assert.equal(
    (controller.match(/visible=\{overlayVisible &&/g) ?? []).length,
    4,
    "export, file, status and preview dialogs must share one exclusive visible slot",
  );
  assert.equal(
    (controller.match(/onDismiss=\{\(\) => settleOverlayDismissal\(/g) ?? [])
      .length,
    4,
    "the next queued dialog must wait for each real AppModal dismissal",
  );
  assert.doesNotMatch(
    controller,
    /set(?:Export|Import|Status)Dialog|setPendingImport\(/,
    "independent dialog booleans would reintroduce simultaneous modal ownership",
  );
  assert.match(
    controller,
    /const translate = currentTransferTranslator\(\);[\s\S]{0,500}title: translate\("import\.title"\)[\s\S]{0,200}message: translate\("import\.success"\)/,
    "import completion text must come from one post-import language snapshot",
  );
  assert.match(
    controller,
    /!habitsLoaded[\s\S]{0,120}!dayRecordsLoaded[\s\S]{0,120}!settingsLoaded[\s\S]{0,120}!selectedDayLoaded/,
    "every imported snapshot load, including selected-day publication, must report success",
  );
  for (const fence of [
    "exportFence",
    "chooseFileFence",
    "applyImportFence",
    "statusRetryFence",
  ]) {
    assert.match(
      controller,
      new RegExp(`${fence}\\.tryAcquire\\(\\)`),
      `${fence} must retain synchronous duplicate admission`,
    );
  }
  assert.match(
    controller,
    /if \(!succeeded\)\s+enqueueOverlay\(status\)/,
    "a resolved false retry must remain a visible error, not a false success",
  );
  assert.match(
    controller,
    /statusRetryFence\.tryAcquire\(\)[\s\S]{0,500}currentSlot\.current !== status/,
    "rapid Retry taps must keep the first accepted retry as the only load owner",
  );
  assert.match(
    home,
    /const \[habitsLoaded, selectedDayLoaded, allDayRecordsLoaded\][\s\S]{0,500}habitsLoaded && selectedDayLoaded && allDayRecordsLoaded/,
    "Home retry must return the conjunction of every load result",
  );
  assert.match(home, /loadHabits\(\{ publishError: false \}\)/);
  assert.match(
    home,
    /loadDayRecords\(selectedDate, \{ publishError: false \}\)/,
  );
  assert.match(home, /loadAllDayRecords\(\{ publishError: false \}\)/);
  assert.doesNotMatch(
    home,
    /isHabitDataRetryInFlightRef/,
    "retry suppression must not erase unrelated store errors by time window",
  );
  assert.match(
    homeSnapshot,
    /previous\.errorRevision !== current\.errorRevision/,
    "Home must observe a later store error even when its text is identical",
  );
  assert.match(
    home,
    /clearHabitStoreError\(habitStoreErrorRevision\)/,
    "an effect that presented error A must only consume error A",
  );
  assert.match(
    habitStore,
    /clearError\(expectedRevision\)[\s\S]{0,300}canConsumeHabitStoreError\([\s\S]{0,120}expectedRevision/,
    "store error consumption must compare the captured revision atomically inside set",
  );
  const unsupportedErrorAssignments = habitStore
    .split(/\r?\n/)
    .filter((line) => /\berror\s*:/.test(line))
    .filter(
      (line) =>
        !/\berror\s*:\s*string(?:\s*\|\s*null)?;/.test(line) &&
        !/\berror\s*:\s*message\b/.test(line) &&
        !/\berror\s*:\s*null\b/.test(line),
    );
  assert.deepEqual(
    unsupportedErrorAssignments,
    [],
    "every non-null habit-store error must advance errorRevision through createHabitErrorUpdate",
  );
  assert.match(
    habitStore,
    /async loadHabits\(options\)[\s\S]{0,150}shouldPublishHabitLoadError\(options\)[\s\S]{0,250}publishError\s*\? \{ isLoading: true, error: null \}[\s\S]{0,80}: \{ isLoading: true \}/,
    "silent retry loading must preserve an unrelated existing store error",
  );
  assert.match(
    habitStore,
    /if \(publishError && requestToken === dayRecordsRequestToken\)/,
  );
  const fullHistoryLoad = habitStore.slice(
    habitStore.indexOf("async loadAllDayRecords(options)"),
    habitStore.indexOf("async createHabit(input"),
  );
  assert.match(
    fullHistoryLoad,
    /const publishError = shouldPublishHabitLoadError\(options\)/,
  );
  assert.match(
    fullHistoryLoad,
    /catch \(e\) \{\s*if \(requestEpoch !== dataCacheEpoch\)\s*return false;\s*if \(publishError\) \{\s*set\(\s*createHabitErrorUpdate\(/,
    "only an owned foreground full-history failure may publish a store error",
  );
}

function auditDescriptionSettingsTransferOwnership(): void {
  const root = path.resolve(__dirname, "..");
  const read = (relativePath: string) =>
    fs.readFileSync(path.join(root, relativePath), "utf8");
  const dataTransferComposition = read("src/composition/data-transfer.ts");
  const settingsComposition = read("src/composition/settings.ts");
  const settingsStore = read("src/stores/settings-store.ts");
  const homeDataTransferOverlay = read(
    "src/features/habits/components/HomeDataTransferOverlayController.tsx",
  );
  const exportCodec = read(
    "src/application/data-transfer/data-transfer-codec.ts",
  );
  const shareExportAdapter = read(
    "src/platform/data-transfer/share-export-file.ts",
  );

  assert.match(
    dataTransferComposition,
    /capturePendingSettingsWriteFence[\s\S]{0,500}waitForPendingSettingsWritesThrough[\s\S]{0,500}releasePendingSettingsWriteFence/,
    "the composite snapshot fence must include every dynamic description-lines command through Settings",
  );
  assert.match(
    settingsComposition,
    /capturePendingSettingsWriteFence[\s\S]{0,120}settingsMutationCoordinator\.captureDurableFence\(\)/,
  );
  assert.match(
    settingsStore,
    /parsePersistedDescriptionLines\(rows\)[\s\S]{0,8000}createSettingsMutationSnapshot\([\s\S]{0,120}habitDescriptionLines/,
    "committed import publication must place imported description rows in the coordinator snapshot before fence release",
  );
  assert.match(
    exportCodec,
    /removeOrphanedHabitDescriptionSettings[\s\S]{0,700}DESCRIPTION_LINES_KEY_PREFIX/,
  );
  assert.match(
    exportCodec,
    /row\.key\.startsWith\(DESCRIPTION_LINES_KEY_PREFIX\)[\s\S]{0,500}isValidDescriptionLinesValue/,
    "description rows must remain schema-validated export/import data",
  );

  const confirmStart = homeDataTransferOverlay.indexOf("const confirmExport");
  const exportCall = homeDataTransferOverlay.indexOf(
    "await exportAllData()",
    confirmStart,
  );
  assert.ok(confirmStart >= 0 && exportCall > confirmStart);
  assert.doesNotMatch(
    homeDataTransferOverlay.slice(confirmStart, exportCall),
    /\bawait\b|\bimport\s*\(/,
    "the UI confirm handler must reach the synchronous export cutoff before any await or cold import",
  );
  assert.match(
    homeDataTransferOverlay,
    /onPress: \(\) => void applyImport\(\)/,
    "import apply must reach the guarded application use case directly",
  );
  const coldImportIndex = shareExportAdapter.indexOf(
    'await import("expo-sharing")',
  );
  const nativeRequestIndex = shareExportAdapter.indexOf("Sharing.shareAsync(");
  const requestAwaitIndex = shareExportAdapter.indexOf("await request;");
  assert.ok(
    coldImportIndex >= 0 &&
      nativeRequestIndex > coldImportIndex &&
      requestAwaitIndex > nativeRequestIndex,
    "native share must start after its module is ready and settle that exact promise",
  );
  assert.match(
    shareExportAdapter,
    /Sharing\.shareAsync\([\s\S]{0,180}mimeType: "application\/json",[\s\S]{0,120}UTI: "public\.json"/,
    "JSON export must declare both the Android MIME type and the iOS Uniform Type Identifier",
  );
}

async function main(): Promise<void> {
  await auditExactExportCutoff();
  await auditCompositeFence();
  await auditSuccessfulImportOrdering();
  await auditPreCommitFailures();
  await auditPublicationRecoveryAndReusedIds();
  await auditSingleFlightTransfers();
  await auditExportUseCaseCapturesBeforePlatformWork();
  await auditImportUseCaseCoalescesRapidApply();
  auditExclusiveOverlaySlotAndStatusQueue();
  auditFirstOwnerSynchronousFence();
  await auditCommittedImportUiOwnership();
  auditRetryLoadErrorOwnership();
  auditHomeDataTransferPresentationContracts();
  auditDescriptionSettingsTransferOwnership();
  console.log("Data-transfer coordinator audit passed.");
}

void withAuditDeadline(main, "Data-transfer coordinator audit").catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
