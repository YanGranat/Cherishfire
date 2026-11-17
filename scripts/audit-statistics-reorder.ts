import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import ts from "typescript";
import {
  getAdjacentReorder, getReorderActions, getReorderDirection,
} from "../src/utils/accessibility-reorder";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import {
  getStatisticsAutoScrollOffset,
  getStatisticsBlockTop,
  getStatisticsBlocksHeight,
  getStatisticsDragTargetIndex,
  getStatisticsDraggedTop,
  getStatisticsEdgeScrollVelocity,
  getStatisticsViewportDragTop,
  moveStatisticsBlockCode,
  shouldSettleStatisticsAtTop,
} from "../src/features/statistics/utils/ui-thread-reorder";
import {
  normalizeStatisticsBlockOrder,
  replaceStatisticsBlockOrder,
} from "../src/utils/statistics-block-orders";
import {
  DEFAULT_SETTINGS, DEFAULT_STATISTICS_BLOCK_ORDER,
  type StatisticsBlockId, type StatisticsBlockOrders, type StatisticsPeriod,
} from "../src/types/settings";
import { buildYearHeatmapPathLayout } from "../src/features/statistics/utils/year-heatmap-paths";
import {
  getStatisticsSceneMembershipKey,
  getStatisticsScenePresentationKey,
} from "../src/features/statistics/utils/scene-membership";
import {
  areStatisticsBlockOrdersEqual,
  doesStatisticsPendingSceneMatchTarget,
  doesStatisticsSceneMatchTarget,
  getStatisticsBlockOrderKey,
  getStatisticsSceneRevision,
  isStatisticsSceneRevisionCurrent,
  requiresStatisticsSceneFallback,
  resolveNextStatisticsScenePresentation,
  resolveStatisticsPresentationHeights,
  shouldRebaseCommittedStatisticsDrop,
} from "../src/features/statistics/utils/scene-transition";

const order = [0, 1, 2, 3];
const heights = [118, 146, 214, 682];

assert.equal(getStatisticsBlocksHeight(order, heights), 1160);
assert.equal(getStatisticsBlockTop(order, heights, 0), 0);
assert.equal(getStatisticsBlockTop(order, heights, 1), 118);
assert.equal(getStatisticsBlockTop(order, heights, 2), 264);
assert.equal(getStatisticsBlockTop(order, heights, 3), 478);

for (let fromIndex = 0; fromIndex < order.length; fromIndex += 1) {
  for (let toIndex = 0; toIndex < order.length; toIndex += 1) {
    const moved = moveStatisticsBlockCode(order, fromIndex, toIndex);
    assert.deepEqual([...moved].sort(), order);
    assert.equal(moved[toIndex], order[fromIndex]);

    const activeCode = order[fromIndex];
    const exactTargetTop = getStatisticsBlockTop(moved, heights, activeCode);
    assert.equal(
      getStatisticsDragTargetIndex(
        order,
        heights,
        activeCode,
        exactTargetTop,
        fromIndex,
      ),
      toIndex,
    );

    let previousBottom = 0;
    for (const code of moved) {
      const top = getStatisticsBlockTop(moved, heights, code);
      assert.equal(top, previousBottom);
      previousBottom = top + heights[code];
    }
    assert.equal(previousBottom, getStatisticsBlocksHeight(moved, heights));
  }
}

// Invalid destinations never lose a block.
assert.deepEqual(moveStatisticsBlockCode(order, 1, -1), order);
assert.deepEqual(moveStatisticsBlockCode(order, 1, 8), order);

// During programmatic scrolling, the block moves by the exact same delta
// before ScrollView receives its matching offset. Its screen Y stays fixed.
const dragStartTop = 264;
const dragStartScrollOffset = 180;
const gestureTranslationY = 24;
for (const currentScrollOffset of [180, 187.2, 205.6, 260.4]) {
  const blockTop = getStatisticsDraggedTop(
    dragStartTop,
    gestureTranslationY,
    currentScrollOffset,
    dragStartScrollOffset,
    900,
  );
  assert.equal(
    Math.round(
      getStatisticsViewportDragTop(blockTop, currentScrollOffset) * 10,
    ) / 10,
    108,
  );
}

// The held block belongs to a viewport overlay, not the native ScrollView.
// Its screen position therefore depends only on logical content top minus the
// commanded offset; a native ScrollView paint phase cannot move the overlay.
assert.equal(getStatisticsViewportDragTop(264, 180), 84);
assert.equal(getStatisticsViewportDragTop(288.5, 204.5), 84);

// The closest-slot rule works in both directions with very different heights.
assert.equal(getStatisticsDragTargetIndex(order, heights, 0, 1042, 0), 3);
assert.equal(getStatisticsDragTargetIndex(order, heights, 3, 0, 3), 0);

// Edge scrolling uses one smooth proportional ramp in both directions.
assert.equal(getStatisticsEdgeScrollVelocity(300, 100, 500), 0);
assert.equal(getStatisticsEdgeScrollVelocity(128, 100, 500), -0.4);
assert.equal(getStatisticsEdgeScrollVelocity(572, 100, 500), 0.4);
assert.equal(getStatisticsEdgeScrollVelocity(50, 100, 500), -0.8);
assert.equal(getStatisticsEdgeScrollVelocity(650, 100, 500), 0.8);
assert.ok(
  Math.abs(getStatisticsEdgeScrollVelocity(107, 100, 500) + 0.7) < 1e-9,
);
assert.ok(
  Math.abs(getStatisticsEdgeScrollVelocity(593, 100, 500) - 0.7) < 1e-9,
);

// UI-thread scroll steps clamp cleanly at both content boundaries.
assert.equal(getStatisticsAutoScrollOffset(200, 1000, 400, -0.8, 16), 187.2);
assert.equal(getStatisticsAutoScrollOffset(595, 1000, 400, 0.8, 16), 600);
assert.equal(getStatisticsAutoScrollOffset(3, 1000, 400, -0.8, 16), 0);
assert.equal(getStatisticsAutoScrollOffset(10, 1000, 400, 0.01, 4), 10.04);

// A tiny native residual at the top may be normalized only after ordinary
// scrolling has fully released ownership. Reorder/autoscroll must never snap.
assert.equal(shouldSettleStatisticsAtTop(-12, -1, 0, 0, 16), true);
assert.equal(shouldSettleStatisticsAtTop(0, -1, 0, 0, 16), true);
assert.equal(shouldSettleStatisticsAtTop(16, -1, 0, 0, 16), true);
assert.equal(shouldSettleStatisticsAtTop(16.01, -1, 0, 0, 16), false);
assert.equal(shouldSettleStatisticsAtTop(4, 2, 0, 0, 16), false);
assert.equal(shouldSettleStatisticsAtTop(4, -1, 1, 0, 16), false);
assert.equal(shouldSettleStatisticsAtTop(4, -1, 0, 1, 16), false);

// Week, month and year are independent persisted preferences. Migrating the
// former single order must clone it rather than aliasing the same array.
const legacyOrder = normalizeStatisticsBlockOrder([
  "habit",
  "summary",
  "heatmap",
  "bar",
]);
const periodOrders = {
  week: normalizeStatisticsBlockOrder(undefined, legacyOrder),
  month: normalizeStatisticsBlockOrder(undefined, legacyOrder),
  year: normalizeStatisticsBlockOrder(undefined, legacyOrder),
};
assert.deepEqual(periodOrders.week, legacyOrder);
assert.deepEqual(periodOrders.month, legacyOrder);
assert.deepEqual(periodOrders.year, legacyOrder);
assert.notEqual(periodOrders.week, periodOrders.month);
assert.notEqual(periodOrders.month, periodOrders.year);

const weekChanged = replaceStatisticsBlockOrder(periodOrders, "week", [
  "summary",
  "bar",
  "heatmap",
  "habit",
]);
assert.deepEqual(weekChanged.week, ["summary", "bar", "heatmap", "habit"]);
assert.deepEqual(weekChanged.month, legacyOrder);
assert.deepEqual(weekChanged.year, legacyOrder);
assert.equal(weekChanged.month, periodOrders.month);
assert.equal(weekChanged.year, periodOrders.year);
assert.notEqual(
  DEFAULT_SETTINGS.statisticsBlockOrders.week,
  DEFAULT_SETTINGS.statisticsBlockOrders.month,
);

// Reordering the same block membership must not destroy the native drag scene;
// adding/removing the week-only bar still requires a fresh geometry owner.
assert.equal(
  getStatisticsSceneMembershipKey(["summary", "bar", "heatmap", "habit"]),
  getStatisticsSceneMembershipKey(["habit", "heatmap", "summary", "bar"]),
);
assert.notEqual(
  getStatisticsSceneMembershipKey(["summary", "bar", "heatmap", "habit"]),
  getStatisticsSceneMembershipKey(["summary", "heatmap", "habit"]),
);
assert.equal(
  getStatisticsScenePresentationKey(
    ["summary", "bar", "heatmap", "habit"],
    "presentation-7",
  ),
  getStatisticsScenePresentationKey(
    ["habit", "heatmap", "summary", "bar"],
    "presentation-7",
  ),
  "a pure reorder must reuse the existing native scene",
);
assert.notEqual(
  getStatisticsScenePresentationKey(
    ["summary", "heatmap", "habit"],
    "presentation-7",
  ),
  getStatisticsScenePresentationKey(
    ["summary", "heatmap", "habit"],
    "presentation-8",
  ),
  "new content geometry must reset stale native transforms",
);
assert.equal(
  requiresStatisticsSceneFallback(false),
  false,
  "a clean scene owns only zero idle transforms, so React may reorder it directly in Yoga flow",
);
assert.equal(
  requiresStatisticsSceneFallback(true),
  true,
  "non-zero idle transforms left by a drop must be covered during rebase",
);
assert.equal(
  areStatisticsBlockOrdersEqual(
    ["summary", "heatmap", "habit"],
    ["summary", "heatmap", "habit"],
  ),
  true,
);
assert.equal(
  areStatisticsBlockOrdersEqual(
    ["summary", "heatmap", "habit"],
    ["heatmap", "summary", "habit"],
  ),
  false,
);
const transformedMonthOrder = getStatisticsBlockOrderKey([
  "habit",
  "summary",
  "heatmap",
]);
assert.equal(
  doesStatisticsSceneMatchTarget(
    ["summary", "heatmap", "habit"],
    ["habit", "summary", "heatmap"],
    true,
    transformedMonthOrder,
  ),
  true,
  "the optimistic store commit after a drop must reuse the transformed scene",
);
assert.equal(
  doesStatisticsSceneMatchTarget(
    ["summary", "heatmap", "habit"],
    ["heatmap", "summary", "habit"],
    true,
    transformedMonthOrder,
  ),
  false,
  "a rollback or unrelated external order must start a new presentation",
);
assert.equal(
  doesStatisticsSceneMatchTarget(
    ["summary", "heatmap", "habit"],
    ["heatmap", "summary", "habit"],
    false,
    null,
  ),
  false,
  "a clean external order update must start a normal-flow presentation",
);

const acceptedDropOrder = ["habit", "summary", "heatmap"] as const;
const acceptedDropRebase = {
  nativeLayoutDirty: true,
  overlayVisible: false,
  sceneReady: true,
  geometryChanged: false,
  transformedOrderKey: getStatisticsBlockOrderKey(acceptedDropOrder),
  targetOrder: acceptedDropOrder,
};
assert.equal(
  shouldRebaseCommittedStatisticsDrop(acceptedDropRebase),
  true,
  "an accepted changed drop must rebase immediately after its overlay settles",
);
assert.equal(
  shouldRebaseCommittedStatisticsDrop({
    ...acceptedDropRebase,
    overlayVisible: true,
  }),
  false,
  "drop settling remains owned by the existing overlay and tuned animation",
);
assert.equal(
  shouldRebaseCommittedStatisticsDrop({
    ...acceptedDropRebase,
    sceneReady: false,
  }),
  false,
  "a scene already preparing the rebase must not start another attempt",
);
assert.equal(
  shouldRebaseCommittedStatisticsDrop({
    ...acceptedDropRebase,
    geometryChanged: true,
  }),
  false,
  "a simultaneous period or viewport change remains owned by the target handoff",
);
assert.equal(
  shouldRebaseCommittedStatisticsDrop({
    ...acceptedDropRebase,
    transformedOrderKey: getStatisticsBlockOrderKey([
      "summary",
      "habit",
      "heatmap",
    ]),
  }),
  false,
  "a persistence rollback or external order change must not be mistaken for an accepted drop",
);
assert.equal(
  shouldRebaseCommittedStatisticsDrop({
    ...acceptedDropRebase,
    nativeLayoutDirty: false,
  }),
  false,
  "a clean scene cannot schedule a redundant post-drop handoff",
);

// Rapid A -> B -> C: a late B callback cannot publish geometry or retire C's
// fallback after C became the committed presentation revision.
const revisionB = getStatisticsSceneRevision("period-7", [
  "summary",
  "heatmap",
  "habit",
]);
const revisionC = getStatisticsSceneRevision("period-7", [
  "heatmap",
  "summary",
  "habit",
]);
assert.equal(isStatisticsSceneRevisionCurrent(revisionC, revisionB), false);
assert.equal(isStatisticsSceneRevisionCurrent(revisionC, revisionC), true);

const cleanPresentationA = {
  sourceRevision: "period-A",
  revision: JSON.stringify([
    getStatisticsSceneRevision("period-A", [
      "summary",
      "bar",
      "heatmap",
      "habit",
    ]),
    0,
  ]),
  attempt: 0,
  nativeOrder: ["summary", "bar", "heatmap", "habit"] as const,
  phase: "ready" as const,
};
assert.equal(
  resolveNextStatisticsScenePresentation(
    { ...cleanPresentationA, nativeOrder: [...cleanPresentationA.nativeOrder] },
    {
      sourceRevision: "period-A",
      revision: getStatisticsSceneRevision("period-A", [
        "summary",
        "bar",
        "heatmap",
        "habit",
      ]),
      targetOrder: ["summary", "bar", "heatmap", "habit"],
      nativeLayoutDirty: false,
      transformedOrderKey: null,
      overlayVisible: false,
    },
  ),
  null,
  "a clean mount or remount already owns its first target without a handoff render",
);
const cleanPresentationB = resolveNextStatisticsScenePresentation(
  { ...cleanPresentationA, nativeOrder: [...cleanPresentationA.nativeOrder] },
  {
    sourceRevision: "period-B",
    revision: getStatisticsSceneRevision("period-B", [
      "summary",
      "heatmap",
      "habit",
    ]),
    targetOrder: ["summary", "heatmap", "habit"],
    nativeLayoutDirty: false,
    transformedOrderKey: null,
    overlayVisible: false,
  },
);
assert.ok(cleanPresentationB != null);
assert.equal(cleanPresentationB.phase, "preparing-visible");
assert.deepEqual(cleanPresentationB.nativeOrder, [
  "summary",
  "heatmap",
  "habit",
]);

const cleanPresentationC = resolveNextStatisticsScenePresentation(
  cleanPresentationB,
  {
    sourceRevision: "period-C",
    revision: getStatisticsSceneRevision("period-C", [
      "heatmap",
      "summary",
      "habit",
    ]),
    targetOrder: ["heatmap", "summary", "habit"],
    nativeLayoutDirty: false,
    transformedOrderKey: null,
    overlayVisible: false,
  },
);
assert.ok(cleanPresentationC != null);
assert.equal(cleanPresentationC.attempt, 2);
assert.deepEqual(cleanPresentationC.nativeOrder, [
  "heatmap",
  "summary",
  "habit",
]);
assert.equal(
  resolveNextStatisticsScenePresentation(cleanPresentationC, {
    sourceRevision: "period-C",
    revision: getStatisticsSceneRevision("period-C", [
      "heatmap",
      "summary",
      "habit",
    ]),
    targetOrder: ["heatmap", "summary", "habit"],
    nativeLayoutDirty: false,
    transformedOrderKey: null,
    overlayVisible: false,
  }),
  null,
  "an A -> B -> C switch must settle on C without another render-phase retry",
);

const cleanPresentationBackToA = resolveNextStatisticsScenePresentation(
  cleanPresentationC,
  {
    sourceRevision: "period-A",
    revision: getStatisticsSceneRevision("period-A", [
      "summary",
      "bar",
      "heatmap",
      "habit",
    ]),
    targetOrder: ["summary", "bar", "heatmap", "habit"],
    nativeLayoutDirty: false,
    transformedOrderKey: null,
    overlayVisible: false,
  },
);
assert.ok(cleanPresentationBackToA != null);
assert.equal(cleanPresentationBackToA.attempt, 3);
assert.deepEqual(cleanPresentationBackToA.nativeOrder, [
  "summary",
  "bar",
  "heatmap",
  "habit",
]);

const postDropPresentation = resolveNextStatisticsScenePresentation(
  {
    sourceRevision: "period-month",
    revision: "month-ready",
    attempt: 4,
    nativeOrder: ["summary", "heatmap", "habit"],
    phase: "ready",
  },
  {
    sourceRevision: "period-month",
    revision: getStatisticsSceneRevision("period-month", acceptedDropOrder),
    targetOrder: acceptedDropOrder,
    nativeLayoutDirty: true,
    transformedOrderKey: getStatisticsBlockOrderKey(acceptedDropOrder),
    overlayVisible: false,
  },
);
assert.ok(postDropPresentation != null);
assert.equal(postDropPresentation.phase, "preparing-hidden");
assert.deepEqual(postDropPresentation.nativeOrder, acceptedDropOrder);
assert.equal(
  resolveNextStatisticsScenePresentation(
    {
      sourceRevision: "period-month",
      revision: "month-drop-settling",
      attempt: 4,
      nativeOrder: ["summary", "heatmap", "habit"],
      phase: "ready",
    },
    {
      sourceRevision: "period-month",
      revision: getStatisticsSceneRevision("period-month", acceptedDropOrder),
      targetOrder: acceptedDropOrder,
      nativeLayoutDirty: true,
      transformedOrderKey: getStatisticsBlockOrderKey(acceptedDropOrder),
      overlayVisible: true,
    },
  ),
  null,
  "the tuned drop overlay must finish before the accepted transformed scene rebases",
);

assert.equal(
  doesStatisticsPendingSceneMatchTarget(
    "period-7",
    "period-7",
    ["summary", "heatmap", "habit"],
    ["summary", "heatmap", "habit"],
    true,
  ),
  true,
  "a dirty scene already preparing the current target must not start an endless new attempt",
);
assert.equal(
  doesStatisticsPendingSceneMatchTarget(
    "period-7",
    "period-7",
    ["summary", "heatmap", "habit"],
    ["summary", "heatmap", "habit"],
    false,
  ),
  false,
);
assert.equal(
  doesStatisticsPendingSceneMatchTarget(
    "period-7",
    "period-7",
    ["summary", "heatmap", "habit"],
    ["summary", "habit"],
    true,
  ),
  false,
  "removing the heatmap while another target prepares must start a new attempt",
);
assert.equal(
  doesStatisticsPendingSceneMatchTarget(
    "period-7",
    "period-8",
    ["summary", "heatmap", "habit"],
    ["summary", "heatmap", "habit"],
    true,
  ),
  false,
);

const weekHeights = [118, 146, 214, 682];
const monthHeights = [118, 176, 0, 534];
const weekRevision = "week-attempt-4";
const weekSamples = {
  summary: { revision: weekRevision, height: 118 },
  heatmap: { revision: weekRevision, height: 146 },
  bar: { revision: weekRevision, height: 214 },
  habit: { revision: weekRevision, height: 682 },
};
assert.deepEqual(
  resolveStatisticsPresentationHeights(
    ["summary", "bar", "heatmap", "habit"],
    weekRevision,
    weekSamples,
    null,
    0.75,
  ),
  [118, 214, 146, 682],
);
assert.equal(
  resolveStatisticsPresentationHeights(
    ["summary", "bar", "heatmap", "habit"],
    weekRevision,
    {
      ...weekSamples,
      bar: { revision: "stale-month", height: 214 },
    },
    null,
    0.75,
  ),
  null,
  "month -> week cannot publish until the newly mounted bar proves the current revision",
);
assert.deepEqual(
  resolveStatisticsPresentationHeights(
    ["summary", "heatmap", "habit"],
    weekRevision,
    weekSamples,
    null,
    0.75,
  ),
  [118, 146, 682],
  "week -> month ignores the detached bar instead of looking it up natively",
);
assert.equal(
  resolveStatisticsPresentationHeights(
    ["summary", "heatmap", "habit"],
    weekRevision,
    weekSamples,
    {
      summary: { revision: weekRevision, height: 118 },
      heatmap: { revision: weekRevision, height: 150 },
      habit: { revision: weekRevision, height: 682 },
    },
    0.75,
  ),
  null,
  "a dirty transformed scene stays covered until native and fallback heights agree",
);
assert.deepEqual(
  resolveStatisticsPresentationHeights(
    ["summary", "heatmap", "habit"],
    weekRevision,
    weekSamples,
    {
      summary: { revision: weekRevision, height: 118 },
      heatmap: { revision: weekRevision, height: 146 },
      habit: { revision: weekRevision, height: 682 },
    },
    0.75,
  ),
  [118, 146, 682],
);
assert.deepEqual(
  resolveStatisticsPresentationHeights(
    ["summary", "habit"],
    weekRevision,
    weekSamples,
    null,
    0.75,
  ),
  [118, 682],
  "removing a heatmap never inspects its detached native node",
);
assert.equal(
  resolveStatisticsPresentationHeights(
    ["summary", "heatmap", "habit"],
    weekRevision,
    {
      ...weekSamples,
      heatmap: { revision: "stale-empty-state", height: 146 },
    },
    null,
    0.75,
  ),
  null,
  "adding the heatmap requires a current keyed layout proof",
);
assert.equal(
  resolveStatisticsPresentationHeights(
    ["summary", "heatmap", "habit"],
    revisionC,
    weekSamples,
    null,
    0.75,
  ),
  null,
  "a late A/B layout event cannot promote the current C presentation",
);

// Regression: month -> week may insert the bar before the heatmap. Once the
// shared UI-thread geometry has switched, every row must derive its idle top
// from that same target order; the heatmap must not retain the month's top for
// one frame and overlap the bar.
const monthOrder = [0, 1, 3];
const weekOrder = [0, 2, 1, 3];
assert.equal(getStatisticsBlockTop(monthOrder, monthHeights, 1), 118);
assert.deepEqual(
  weekOrder.map((code) => getStatisticsBlockTop(weekOrder, weekHeights, code)),
  [0, 118, 332, 478],
);

// Performance guards: the first correct Yoga-flow presentation must not pay
// for native drag handlers or an always-running frame callback. These checks
// intentionally protect structure; the pure helpers above protect geometry.
const reorderSource = readFileSync(
  "src/features/statistics/components/ReorderableStatisticsBlocks.tsx",
  "utf8",
);
const sceneTransitionSource = readFileSync(
  "src/features/statistics/utils/scene-transition.ts",
  "utf8",
);
const controllerStart = reorderSource.indexOf("const StatisticsDragController");
const rowStart = reorderSource.indexOf("const ReorderableStatisticsRow");
const overlayStart = reorderSource.indexOf("function StatisticsDragOverlay");
const fallbackStart = reorderSource.indexOf(
  "const StatisticsPresentationFallback",
);
const sceneStart = reorderSource.indexOf("const ReorderableStatisticsScene");
const publicComponentStart = reorderSource.indexOf(
  "export function ReorderableStatisticsBlocks",
);
assert.ok(controllerStart >= 0);
assert.ok(rowStart > controllerStart);
assert.ok(overlayStart > rowStart);
assert.ok(fallbackStart > overlayStart);
assert.ok(sceneStart > fallbackStart);
assert.ok(publicComponentStart > sceneStart);

const rowSource = reorderSource.slice(rowStart, overlayStart);
const controllerSource = reorderSource.slice(controllerStart, rowStart);
const fallbackSource = reorderSource.slice(fallbackStart, sceneStart);
const sceneSource = reorderSource.slice(sceneStart, publicComponentStart);
const publicComponentSource = reorderSource.slice(publicComponentStart);

function extractHookCallback(source: string, variableName: string): string {
  const sourceFile = ts.createSourceFile(
    "ReorderableStatisticsBlocks.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callback: ts.ArrowFunction | ts.FunctionExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer != null &&
      ts.isCallExpression(node.initializer)
    ) {
      const candidate = node.initializer.arguments[0];
      if (
        candidate != null &&
        (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
      ) {
        callback = candidate;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(callback, `${variableName} must remain source-extractable`);
  return (callback as ts.ArrowFunction | ts.FunctionExpression).getText(
    sourceFile,
  );
}

function extractLayoutEffectCallback(source: string, marker: string): string {
  const sourceFile = ts.createSourceFile(
    "ReorderableStatisticsBlocks.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callback: ts.ArrowFunction | ts.FunctionExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "useLayoutEffect" &&
      node.getText(sourceFile).includes(marker)
    ) {
      const candidate = node.arguments[0];
      if (
        candidate != null &&
        (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))
      ) {
        callback = candidate;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(callback, `${marker} layout effect must remain source-extractable`);
  return (callback as ts.ArrowFunction | ts.FunctionExpression).getText(
    sourceFile,
  );
}

function compileCallbackFactory<T>(
  callbackSource: string,
  bindings: readonly string[],
): (environment: Record<string, unknown>) => T {
  const output = ts.transpileModule(
    `module.exports = (environment) => { const { ${bindings.join(", ")} } = environment; return (${callbackSource}); };`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const loaded = { exports: {} as unknown };
  Function("module", "exports", output)(loaded, loaded.exports);
  return loaded.exports as (environment: Record<string, unknown>) => T;
}

function assertDragStartAdmission(source: string): void {
  const admissionRef = { current: null as object | null };
  const tokenA = {};
  const tokenB = {};
  const effectFactory = compileCallbackFactory<() => void | (() => void)>(
    extractLayoutEffectCallback(
      source,
      "sceneInteractionAdmissionRef.current = sceneInteractionAdmissionToken",
    ),
    [
      "active",
      "sceneInteractionAdmissionRef",
      "sceneInteractionAdmissionToken",
    ],
  );
  const cleanupA = effectFactory({
    active: true,
    sceneInteractionAdmissionRef: admissionRef,
    sceneInteractionAdmissionToken: tokenA,
  })();
  assert.equal(admissionRef.current, tokenA);
  cleanupA?.();
  assert.equal(admissionRef.current, null);
  assert.equal(
    effectFactory({
      active: false,
      sceneInteractionAdmissionRef: admissionRef,
      sceneInteractionAdmissionToken: tokenB,
    })(),
    undefined,
  );
  assert.equal(admissionRef.current, null);
  const cleanupB = effectFactory({
    active: true,
    sceneInteractionAdmissionRef: admissionRef,
    sceneInteractionAdmissionToken: tokenB,
  })();
  assert.equal(admissionRef.current, tokenB);
  cleanupA?.();
  assert.equal(
    admissionRef.current,
    tokenB,
    "an old cleanup cannot revoke the new scene's admission",
  );

  const activeDropOwnerRef = {
    current: null as null | Record<string, unknown>,
  };
  const autoScrollFrame = {
    isActive: false,
    calls: [] as boolean[],
    setActive(next: boolean) {
      this.isActive = next;
      this.calls.push(next);
    },
  };
  const overlays: unknown[] = [];
  const committedOrders: unknown[][] = [];
  const onReorder = (...args: unknown[]) => committedOrders.push(args);
  const handlerFactory = compileCallbackFactory<
    (id: string, startedAt: number) => void
  >(extractHookCallback(source, "handleDragStart"), [
    "sceneInteractionAdmissionRef",
    "sceneInteractionAdmissionToken",
    "activeDropOwnerRef",
    "scenePresentation",
    "onReorder",
    "autoScrollFrame",
    "setOverlayId",
  ]);
  const environment = {
    sceneInteractionAdmissionRef: admissionRef,
    activeDropOwnerRef,
    scenePresentation: { nativeOrder: ["summary", "heatmap"] },
    onReorder,
    autoScrollFrame,
    setOverlayId: (id: unknown) => overlays.push(id),
  };
  const staleHandler = handlerFactory({
    ...environment,
    sceneInteractionAdmissionToken: tokenA,
  });
  staleHandler("summary", 101);
  assert.deepEqual(activeDropOwnerRef.current, {
    startedAtEpochMs: 101,
    target: "summary",
    nativeOrder: ["summary", "heatmap"],
    commit: onReorder,
    accepted: false,
  });
  assert.equal(autoScrollFrame.calls.length, 0);
  assert.equal(overlays.length, 0);

  const drop = compileCallbackFactory<
    (codes: number[], changed: boolean, startedAt: number) => void
  >(extractHookCallback(source, "handleDrop"), [
    "activeDropOwnerRef",
    "BLOCK_IDS",
    "areStatisticsBlockOrdersEqual",
    "presentationMountedRef",
    "nativeLayoutDirtyRef",
    "transformedOrderKeyRef",
    "setNativeLayoutDirty",
    "getStatisticsBlockOrderKey",
  ])({
    activeDropOwnerRef,
    BLOCK_IDS: ["summary", "heatmap", "bar", "habit"],
    areStatisticsBlockOrdersEqual,
    presentationMountedRef: { current: false },
    nativeLayoutDirtyRef: { current: false },
    transformedOrderKeyRef: { current: null },
    setNativeLayoutDirty: () => {
      throw new Error("a detached scene must not publish layout state");
    },
    getStatisticsBlockOrderKey,
  });
  drop([1, 0], true, 101);
  assert.deepEqual(
    committedOrders,
    [[["heatmap", "summary"]]],
    "an accepted drop keeps its captured product callback after the scene is detached",
  );
  assert.equal(activeDropOwnerRef.current, null);
  drop([1, 0], true, 101);
  assert.equal(
    committedOrders.length,
    1,
    "duplicate release must not repeat the product command",
  );

  const currentHandler = handlerFactory({
    ...environment,
    sceneInteractionAdmissionToken: tokenB,
  });
  currentHandler("heatmap", 202);
  assert.notEqual(
    Reflect.get(activeDropOwnerRef.current ?? {}, "nativeOrder"),
    environment.scenePresentation.nativeOrder,
  );
  assert.deepEqual(autoScrollFrame.calls, [true]);
  assert.deepEqual(overlays, ["heatmap"]);
  drop([1, 0], true, 101);
  assert.equal(
    committedOrders.length,
    1,
    "an older release cannot commit against a newer drag owner",
  );
  assert.equal(
    Reflect.get(activeDropOwnerRef.current ?? {}, "startedAtEpochMs"),
    202,
  );
  drop([0, 1], false, 202);
  assert.equal(activeDropOwnerRef.current, null);
  assert.equal(
    committedOrders.length,
    1,
    "an unchanged drop must not persist an order",
  );

  let reentrantCommits = 0;
  handlerFactory({
    ...environment,
    sceneInteractionAdmissionToken: tokenB,
    onReorder: () => {
      reentrantCommits += 1;
      if (reentrantCommits === 1) drop([1, 0], true, 303);
    },
  })("summary", 303);
  drop([1, 0], true, 303);
  assert.equal(
    reentrantCommits,
    1,
    "the owner must accept a reentrant release only once",
  );
  assert.equal(activeDropOwnerRef.current, null);
  handlerFactory({
    ...environment,
    sceneInteractionAdmissionToken: tokenB,
    onReorder: () => {
      throw new Error("Synthetic product callback failure");
    },
  })("summary", 304);
  assert.throws(
    () => drop([1, 0], true, 304),
    /Synthetic product callback failure/,
  );
  assert.equal(
    activeDropOwnerRef.current,
    null,
    "a throwing command must still retire its exact owner",
  );

  const timerRef = { current: null as number | null };
  const settledOffsets: number[] = [];
  const clearedTimers: string[] = [];
  const scheduledTimers: number[] = [];
  const scheduleFactory = compileCallbackFactory<(offset: number) => void>(
    extractHookCallback(source, "scheduleTopScrollSettle"),
    [
      "sceneInteractionAdmissionRef",
      "sceneInteractionAdmissionToken",
      "TOP_SCROLL_SETTLE_THRESHOLD_DP",
      "onScrollSettled",
      "clearTopScrollSettleTimer",
      "topScrollSettleTimerRef",
      "setTimeout",
      "settleAtTop",
      "TOP_SCROLL_SETTLE_DELAY_MS",
    ],
  );
  const scrollEnvironment = {
    sceneInteractionAdmissionRef: admissionRef,
    TOP_SCROLL_SETTLE_THRESHOLD_DP: 16,
    onScrollSettled: (offset: number) => settledOffsets.push(offset),
    clearTopScrollSettleTimer: () => clearedTimers.push("clear"),
    topScrollSettleTimerRef: timerRef,
    setTimeout: (_callback: () => void, delay: number) => {
      scheduledTimers.push(delay);
      return 55;
    },
    settleAtTop: () => {},
    TOP_SCROLL_SETTLE_DELAY_MS: 30,
  };
  const staleSchedule = scheduleFactory({
    ...scrollEnvironment,
    sceneInteractionAdmissionToken: tokenA,
  });
  staleSchedule(4);
  assert.deepEqual(settledOffsets, []);
  assert.equal(timerRef.current, null);
  const currentSchedule = scheduleFactory({
    ...scrollEnvironment,
    sceneInteractionAdmissionToken: tokenB,
  });
  currentSchedule(4);
  assert.deepEqual(settledOffsets, [0]);
  assert.deepEqual(clearedTimers, ["clear"]);
  assert.deepEqual(scheduledTimers, [30]);
  assert.equal(timerRef.current, 55);
  currentSchedule(40);
  assert.deepEqual(settledOffsets, [0, 40]);
  assert.deepEqual(
    scheduledTimers,
    [30],
    "ordinary scroll positions must not schedule a top snap",
  );

  const scrollOffset = { value: 4 };
  const draggingCode = { value: -1 };
  const nativeScrollDragActive = { value: 0 };
  const nativeScrollMomentumActive = { value: 0 };
  const nativeScrollCalls: unknown[][] = [];
  const scrollRef = {};
  let workletCalls = 0;
  const settleFactory = compileCallbackFactory<() => void>(
    extractHookCallback(source, "settleAtTop"),
    [
      "sceneInteractionAdmissionRef",
      "sceneInteractionAdmissionToken",
      "runOnUI",
      "shouldSettleStatisticsAtTop",
      "TOP_SCROLL_SETTLE_THRESHOLD_DP",
      "scrollTo",
      "scrollRef",
      "scrollOffset",
      "draggingCode",
      "nativeScrollDragActive",
      "nativeScrollMomentumActive",
    ],
  );
  const settleEnvironment = {
    sceneInteractionAdmissionRef: admissionRef,
    runOnUI:
      (callback: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        workletCalls += 1;
        callback(...args);
      },
    shouldSettleStatisticsAtTop,
    TOP_SCROLL_SETTLE_THRESHOLD_DP: 16,
    scrollTo: (...args: unknown[]) => nativeScrollCalls.push(args),
    scrollRef,
    scrollOffset,
    draggingCode,
    nativeScrollDragActive,
    nativeScrollMomentumActive,
  };
  settleFactory({
    ...settleEnvironment,
    sceneInteractionAdmissionToken: tokenA,
  })();
  assert.equal(workletCalls, 0);
  const settle = settleFactory({
    ...settleEnvironment,
    sceneInteractionAdmissionToken: tokenB,
  });
  for (const [offset, dragCode, dragActive, momentumActive] of [
    [4, 2, 0, 0],
    [4, -1, 1, 0],
    [4, -1, 0, 1],
    [17, -1, 0, 0],
  ]) {
    scrollOffset.value = offset;
    draggingCode.value = dragCode;
    nativeScrollDragActive.value = dragActive;
    nativeScrollMomentumActive.value = momentumActive;
    settle();
    assert.equal(
      scrollOffset.value,
      offset,
      "drag, momentum and ordinary positions cannot be snapped",
    );
  }
  assert.deepEqual(nativeScrollCalls, []);
  draggingCode.value = -1;
  nativeScrollDragActive.value = 0;
  nativeScrollMomentumActive.value = 0;
  scrollOffset.value = 4;
  settle();
  assert.equal(scrollOffset.value, 0);
  assert.deepEqual(nativeScrollCalls, [[scrollRef, 0, 0, false]]);
  scrollOffset.value = 0.2;
  settle();
  assert.equal(scrollOffset.value, 0);
  assert.equal(
    nativeScrollCalls.length,
    1,
    "an already-top residual must not dispatch a redundant native scroll",
  );

  const ownedOffsets: number[] = [];
  const offsetFactory = compileCallbackFactory<(offset: number) => void>(
    extractHookCallback(source, "publishOwnedScrollOffset"),
    [
      "sceneInteractionAdmissionRef",
      "sceneInteractionAdmissionToken",
      "onScrollSettled",
    ],
  );
  for (const [token, value] of [
    [tokenA, 12],
    [tokenB, 13],
  ] as const) {
    offsetFactory({
      sceneInteractionAdmissionRef: admissionRef,
      sceneInteractionAdmissionToken: token,
      onScrollSettled: (offset: number) => ownedOffsets.push(offset),
    })(value);
  }
  assert.deepEqual(ownedOffsets, [13]);
  const clearCalls: string[] = [];
  const clearFactory = compileCallbackFactory<() => void>(
    extractHookCallback(source, "clearOwnedTopScrollSettleTimer"),
    [
      "sceneInteractionAdmissionRef",
      "sceneInteractionAdmissionToken",
      "clearTopScrollSettleTimer",
    ],
  );
  for (const token of [tokenA, tokenB]) {
    clearFactory({
      sceneInteractionAdmissionRef: admissionRef,
      sceneInteractionAdmissionToken: token,
      clearTopScrollSettleTimer: () => clearCalls.push("clear"),
    })();
  }
  assert.deepEqual(clearCalls, ["clear"]);

  const finishFrame = {
    isActive: true,
    calls: [] as boolean[],
    setActive(next: boolean) {
      this.isActive = next;
      this.calls.push(next);
    },
  };
  const finishOverlays: unknown[] = [];
  activeDropOwnerRef.current = { target: "summary", startedAtEpochMs: 401 };
  const finishFactory = compileCallbackFactory<
    (id: string, startedAt: number) => void
  >(extractHookCallback(source, "handleDragFinished"), [
    "sceneInteractionAdmissionRef",
    "sceneInteractionAdmissionToken",
    "activeDropOwnerRef",
    "autoScrollFrame",
    "setOverlayId",
  ]);
  const finishEnvironment = {
    sceneInteractionAdmissionRef: admissionRef,
    activeDropOwnerRef,
    autoScrollFrame: finishFrame,
    setOverlayId: (updater: unknown) => finishOverlays.push(updater),
  };
  finishFactory({
    ...finishEnvironment,
    sceneInteractionAdmissionToken: tokenA,
  })("summary", 401);
  assert.notEqual(activeDropOwnerRef.current, null);
  assert.deepEqual(finishFrame.calls, []);
  const finish = finishFactory({
    ...finishEnvironment,
    sceneInteractionAdmissionToken: tokenB,
  });
  finish("summary", 400);
  assert.notEqual(activeDropOwnerRef.current, null);
  finish("summary", 401);
  assert.equal(activeDropOwnerRef.current, null);
  assert.deepEqual(finishFrame.calls, [false]);
  assert.equal(finishOverlays.length, 1);

  const overlayReady = { value: 0 };
  draggingCode.value = 0;
  const readyFactory = compileCallbackFactory<(code: number) => void>(
    extractHookCallback(source, "handleOverlayReady"),
    [
      "sceneInteractionAdmissionRef",
      "sceneInteractionAdmissionToken",
      "runOnUI",
      "draggingCode",
      "overlayReady",
    ],
  );
  const readyEnvironment = {
    sceneInteractionAdmissionRef: admissionRef,
    runOnUI: (callback: (...args: unknown[]) => void) => callback,
    draggingCode,
    overlayReady,
  };
  readyFactory({ ...readyEnvironment, sceneInteractionAdmissionToken: tokenA })(
    0,
  );
  assert.equal(overlayReady.value, 0);
  const ready = readyFactory({
    ...readyEnvironment,
    sceneInteractionAdmissionToken: tokenB,
  });
  ready(1);
  assert.equal(
    overlayReady.value,
    0,
    "a stale overlay cannot mark a different dragged row ready",
  );
  ready(0);
  assert.equal(overlayReady.value, 1);

  cleanupB?.();
  assert.equal(admissionRef.current, null);
  const overlayCount = overlays.length;
  currentHandler("heatmap", 503);
  currentSchedule(2);
  assert.equal(overlays.length, overlayCount);
  assert.deepEqual(scheduledTimers, [30]);
}

function replaceHookCallbackSource(
  source: string,
  variableName: string,
  before: string | RegExp,
  after: string,
): string {
  const callback = extractHookCallback(source, variableName);
  const occurrenceCount =
    typeof before === "string"
      ? callback.split(before).length - 1
      : [...callback.matchAll(new RegExp(before.source, `${before.flags}g`))]
          .length;
  assert.equal(occurrenceCount, 1);
  assert.equal(source.split(callback).length - 1, 1);
  return source.replace(callback, callback.replace(before, after));
}

function assertAdmissionMutationRejected(source: string): void {
  let rejection: unknown = null;
  try {
    assertDragStartAdmission(source);
  } catch (error) {
    rejection = error;
  }
  if (
    rejection == null ||
    typeof rejection !== "object" ||
    !("code" in rejection) ||
    rejection.code !== "ERR_ASSERTION"
  ) {
    throw new Error(
      "the drag-start admission mutation was not rejected by an observable assertion",
    );
  }
}

function removeAdmissionGuard(source: string, variableName: string): string {
  const callback = extractHookCallback(source, variableName);
  const tree = ts.createSourceFile(
    "callback.ts",
    `const callback = ${callback};`,
    ts.ScriptTarget.Latest,
    true,
  );
  let guard: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) &&
      node.expression
        .getText(tree)
        .includes("sceneInteractionAdmissionRef.current")
    ) {
      assert.equal(
        guard,
        null,
        "the admission guard must be unique within its callback",
      );
      guard = node.getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(guard);
  return source.replace(callback, callback.replace(guard, ""));
}

assertDragStartAdmission(reorderSource);
for (const callback of [
  "handleDragStart",
  "scheduleTopScrollSettle",
  "settleAtTop",
  "publishOwnedScrollOffset",
  "handleDragFinished",
  "handleOverlayReady",
  "clearOwnedTopScrollSettleTimer",
]) {
  assertAdmissionMutationRejected(
    removeAdmissionGuard(reorderSource, callback),
  );
}
assertAdmissionMutationRejected(
  replaceHookCallbackSource(
    reorderSource,
    "handleDrop",
    "owner.startedAtEpochMs !== dragStartedAtEpochMs ||",
    "",
  ),
);
assertAdmissionMutationRejected(
  replaceHookCallbackSource(
    reorderSource,
    "handleDrop",
    /owner\.accepted\s*\)/,
    "false)",
  ),
);
assertAdmissionMutationRejected(
  replaceHookCallbackSource(
    reorderSource,
    "handleDragStart",
    "scenePresentation.nativeOrder.slice()",
    "scenePresentation.nativeOrder",
  ),
);
const startCallback = extractHookCallback(reorderSource, "handleDragStart");
const startTree = ts.createSourceFile(
  "start.ts",
  `const start = ${startCallback};`,
  ts.ScriptTarget.Latest,
  true,
);
let dragStartGuard: string | null = null;
const findStartGuard = (node: ts.Node): void => {
  if (
    ts.isIfStatement(node) &&
    node.expression
      .getText(startTree)
      .includes("sceneInteractionAdmissionRef.current")
  ) {
    dragStartGuard = node.getText(startTree);
  }
  ts.forEachChild(node, findStartGuard);
};
findStartGuard(startTree);
assert.ok(dragStartGuard);
const unguardedStart = extractHookCallback(
  removeAdmissionGuard(reorderSource, "handleDragStart"),
  "handleDragStart",
);
const bodyStart = unguardedStart.indexOf("{", unguardedStart.indexOf("=>"));
assert.ok(bodyStart >= 0);
assertAdmissionMutationRejected(
  reorderSource.replace(
    startCallback,
    `${unguardedStart.slice(0, bodyStart + 1)}\n${dragStartGuard}\n${unguardedStart.slice(bodyStart + 1)}`,
  ),
);
const admissionEffect = extractLayoutEffectCallback(
  reorderSource,
  "sceneInteractionAdmissionRef.current = sceneInteractionAdmissionToken",
);
assertAdmissionMutationRejected(
  reorderSource.replace(
    admissionEffect,
    admissionEffect.replace("if (!active)", "if (active)"),
  ),
);
assertAdmissionMutationRejected(
  reorderSource.replace(
    admissionEffect,
    admissionEffect.replace(
      "sceneInteractionAdmissionRef.current = null;",
      "sceneInteractionAdmissionRef.current = sceneInteractionAdmissionToken;",
    ),
  ),
);
const presentationProofStart = sceneSource.indexOf(
  "const schedulePresentationProof",
);
const presentationProofEnd = sceneSource.indexOf(
  "const recordPresentationLayout",
  presentationProofStart,
);
const autoScrollStart = sceneSource.indexOf(
  "const autoScrollFrame = useFrameCallback",
);
assert.ok(
  presentationProofStart >= 0 &&
    presentationProofEnd > presentationProofStart &&
    autoScrollStart > presentationProofEnd,
);
const presentationProofSource = sceneSource.slice(
  presentationProofStart,
  presentationProofEnd,
);
assert.match(
  rowSource,
  /\{controllerMounted \? \(\s*<StatisticsDragController[\s\S]{0,120}enabled=\{enabled\}/,
  "gesture controllers may disable during geometry handoff but must not remount on every presentation",
);
assert.doesNotMatch(rowSource, /Gesture\.Pan\(/);
assert.match(
  rowSource,
  /pointerEvents="none"[\s\S]*?<MaterialIcons name="drag-handle"/,
);
assert.match(
  fallbackSource,
  /<View\s+pointerEvents="none"\s+accessible=\{false\}\s+accessibilityElementsHidden\s+importantForAccessibility="no-hide-descendants"\s+style=\{styles\.presentationFallback\}/,
  "the visible geometry fallback must never intercept touches or duplicate the statistics controls for accessibility",
);
assert.match(sceneSource, /const autoScrollFrame = useFrameCallback\(/);
assert.equal(
  (reorderSource.match(/useFrameCallback\(/g) ?? []).length,
  1,
  "only active drag autoscroll may own a frame callback",
);
assert.doesNotMatch(
  sceneSource,
  /measure\(/,
  "period presentation must never measure transient native row refs",
);
assert.match(
  presentationProofSource,
  /const currentScrollView = mountedScrollRef\.current;[\s\S]{0,260}currentScrollView\.scrollTo\(/,
  "presentation clamping must use a mounted React ref that clears on unmount",
);
assert.match(
  sceneSource,
  /const attachScrollRef = React\.useCallback\([\s\S]{0,220}mountedScrollRef\.current = node;[\s\S]{0,80}scrollRef\(node\);[\s\S]*?<Animated\.ScrollView[\s\S]{0,120}ref=\{attachScrollRef\}/,
  "React must synchronously clear the ordinary ScrollView ref before a delayed presentation callback can dispatch",
);
assert.doesNotMatch(
  presentationProofSource,
  /(^|[^.])\bscrollTo\(/m,
  "an asynchronous presentation worklet must not dispatch through Reanimated's stale animated-ref wrapper",
);
assert.match(
  controllerSource,
  /const viewport = measure\(scrollRef\)/,
  "the sole native measure is allowed only after a drag gesture starts on the attached ScrollView",
);
assert.match(sceneSource, /useFrameCallback\([\s\S]*?,\s*false\s*\);/);
assert.match(sceneSource, /autoScrollFrame\.setActive\(true\)/);
assert.match(sceneSource, /autoScrollFrame\.setActive\(false\)/);
assert.match(
  controllerSource,
  /const acceptDrop = React\.useCallback\([\s\S]{0,500}onDrop\(nextOrder, changed, observedDragStartedAtEpochMs\);/,
  "one release bridge must publish the exact accepted product drop",
);
const acceptedDropIndex = controllerSource.indexOf("runOnJS(acceptDrop)(");
const dropSettleIndex = controllerSource.indexOf(
  "dragTop.value = withTiming(",
  acceptedDropIndex,
);
assert.ok(
  acceptedDropIndex >= 0 && dropSettleIndex > acceptedDropIndex,
  "the product drop must be accepted before the optional 180 ms visual settle begins",
);
assert.match(
  controllerSource,
  /dragTop\.value = withTiming\([\s\S]{0,900}runOnJS\(finishDropVisuals\)\(/,
  "visual settle completion may finish overlay/scroll state but must not own the product drop",
);
assert.doesNotMatch(
  controllerSource,
  /\.onEnd\([\s\S]{0,1600}runOnJS\(onDragRelease\)/,
  "drop completion must not race a second independent release callback",
);
assert.doesNotMatch(
  controllerSource,
  /\.onFinalize\([\s\S]{0,900}runOnJS\(onDragRelease\)/,
  "cancel completion must not race a second independent release callback",
);
assert.match(sceneSource, /const pendingHeightByIdRef = React\.useRef/);
assert.match(
  sceneSource,
  /const heightCommitScheduledRef = React\.useRef\(false\)/,
);
assert.match(
  sceneSource,
  /heightCommitFrameRef\.current = raf\(flushPendingHeights\)/,
);
assert.equal(
  (sceneSource.match(/setHeightById\(/g) ?? []).length,
  2,
  "row onLayout measurements need one frame-batched commit and one atomic target-presentation commit",
);
assert.match(
  sceneSource,
  /const flushPendingHeights[\s\S]{0,600}setHeightById\(/,
);
assert.match(
  sceneSource,
  /const reportPresentationReady[\s\S]{0,500}setHeightById\(/,
);
assert.match(
  sceneSource,
  /cancelAnimationFrame\?\.\(heightCommitFrameRef\.current\)/,
);
assert.doesNotMatch(sceneSource, /useSafeAreaInsets\(/);
assert.match(publicComponentSource, /useSafeAreaInsets\(/);
assert.match(reorderSource, /t\("accessibility\.reorderItem", \{[\s\S]{0,200}position: visibleOrder\.indexOf\(id\) \+ 1,[\s\S]{0,80}count: visibleOrder\.length/);
assert.match(reorderSource, /const DRAG_ACTIVATE_MS = 180;/);
assert.match(reorderSource, /const NEIGHBOR_SHIFT_MS = 150;/);
assert.match(reorderSource, /const DROP_SETTLE_MS = 180;/);
assert.doesNotMatch(
  publicComponentSource,
  /<ReorderableStatisticsScene[\s\S]{0,120}key=\{presentationKey\}/,
  "period changes must reuse the ScrollView, native rows and gesture controllers",
);
assert.match(
  publicComponentSource,
  /<ReorderableStatisticsScene[\s\S]{0,180}geometryRevision=\{presentationKey\}/,
);
assert.match(
  publicComponentSource,
  /const presentationKey = React\.useMemo\([\s\S]{0,260}getStatisticsScenePresentationKey\([\s\S]{0,120}props\.visibleOrder[\s\S]{0,120}props\.geometryRevision/,
);
assert.match(
  publicComponentSource,
  /pure reorder and every later content presentation reuse one native scene/,
  "period changes and pure reorders must reuse the existing native scene",
);
assert.match(
  publicComponentSource,
  /useWindowDimensions\(\)[\s\S]{0,900}props\.geometryRevision/,
  "content and viewport geometry revisions must reset stale transforms",
);
assert.match(
  sceneTransitionSource,
  /resolveNextStatisticsScenePresentation\([\s\S]{0,900}shouldRebaseCommittedStatisticsDrop\([\s\S]{0,500}doesStatisticsPendingSceneMatchTarget\(/,
  "a settled accepted drop must use the same guarded presentation owner before another period is selected",
);
assert.match(
  sceneSource,
  /const nextScenePresentation = resolveNextStatisticsScenePresentation\([\s\S]{0,500}const effectiveScenePresentation =\s*nextScenePresentation \?\? scenePresentation/,
);
assert.match(
  sceneTransitionSource,
  /phase: requiresStatisticsSceneFallback\(request\.nativeLayoutDirty\)[\s\S]{0,100}"preparing-hidden"[\s\S]{0,80}"preparing-visible"/,
  "the first target commit must either be safe normal flow or an exact target fallback",
);
assert.match(
  sceneSource,
  /if \(nextScenePresentation != null\) \{\s*setScenePresentation\(nextScenePresentation\);\s*\}[\s\S]{0,80}return \(/,
  "target scene state must be adjusted before React renders the returned child tree",
);
const presentationInitializationStart = sceneSource.indexOf(
  "initializedPresentationRevisionRef.current = scenePresentation.revision",
);
const presentationInitializationEnd = sceneSource.indexOf(
  "if (presentationChanged)",
  presentationInitializationStart,
);
assert.ok(
  presentationInitializationStart >= 0 &&
    presentationInitializationEnd > presentationInitializationStart,
);
assert.doesNotMatch(
  sceneSource.slice(
    presentationInitializationStart,
    presentationInitializationEnd,
  ),
  /setScenePresentation\(/,
  "presentation initialization must not synchronously render the full target tree a second time",
);
assert.match(
  sceneSource,
  /const activeDropOwnerRef = React\.useRef<[\s\S]{0,500}commit: ReorderableStatisticsBlocksProps\["onReorder"\][\s\S]{0,220}accepted: boolean/,
  "each drag must own one immutable product callback and native-order baseline",
);
assert.match(
  sceneSource,
  /const handleDragStart = React\.useCallback\([\s\S]{0,260}activeDropOwnerRef\.current = \{[\s\S]{0,220}startedAtEpochMs: observedAtEpochMs[\s\S]{0,220}nativeOrder: scenePresentation\.nativeOrder\.slice\(\)[\s\S]{0,160}commit: onReorder/,
  "drag start must capture the period-specific reorder owner before a later presentation can replace it",
);
assert.match(
  sceneSource,
  /try \{\s*owner\.commit\(nextIds\);\s*\}\s*finally \{[\s\S]{0,180}activeDropOwnerRef\.current = null;/,
  "the exact product reorder owner must retire even if its callback throws",
);
assert.match(
  sceneSource,
  /<StatisticsPresentationFallback[\s\S]{0,180}visibleOrder=\{visibleOrder\}/,
);
assert.match(
  sceneSource,
  /resolveStatisticsPresentationHeights\([\s\S]{0,300}PRESENTATION_READY_TOLERANCE_DP/,
  "a hidden transformed scene must be proven from revision-tagged layout events",
);
assert.match(
  rowSource,
  /key=\{`layout-proof:\$\{layoutRevision\}`\}[\s\S]{0,220}collapsable=\{false\}[\s\S]{0,220}onLayout=/,
  "each persistent row needs a lightweight revision-keyed layout proof without remounting its content",
);
assert.match(
  fallbackSource,
  /key=\{`\$\{layoutRevision\}:\$\{id\}`\}[\s\S]{0,160}onLayout=/,
  "each fallback row must emit layout for the current presentation attempt",
);
assert.match(sceneSource, /phase: usedFallback \? "overlap" : "ready"/);
assert.match(
  sceneSource,
  /scenePresentation\.phase !== "overlap"[\s\S]{0,500}requestAnimationFrame/,
  "the exact target fallback must overlap the prepared drag scene for one native frame",
);
assert.match(
  rowSource,
  /geometryReady\.value !== 1 \|\|[\s\S]{0,120}geometryReadyRevision\.value !== expectedGeometryRevision/,
  "a late A or B worklet may not apply stale transforms to the current C rows",
);
assert.match(
  reorderSource.slice(controllerStart, rowStart),
  /geometryReady\.value !== 1 \|\|[\s\S]{0,120}geometryReadyRevision\.value !== expectedGeometryRevision[\s\S]{0,120}return;/,
  "a gesture cannot start while its captured presentation revision is stale",
);
assert.match(
  sceneSource,
  /readyRevision\.value = targetRevision;[\s\S]{0,80}ready\.value = 1;/,
  "current revision ownership must be published before transformed geometry becomes visible",
);
assert.match(
  sceneSource,
  /activeRevision\.value = targetRevision;[\s\S]{0,120}geometry\.value = 0;[\s\S]{0,120}readyRevision\.value = null;/,
  "a new requested presentation must revoke the previous UI-thread geometry owner",
);
assert.match(
  sceneSource,
  /onLayout=\{handleViewportLayout\}/,
  "presentation scroll clamping must use the attached ScrollView layout event instead of native measure",
);
assert.match(
  sceneSource,
  /presentationMountedRef\.current = false;[\s\S]{0,120}cancelPresentationProofFrame\(\);[\s\S]{0,220}__statistics-scene-unmounted__/,
  "layout cleanup must cancel pending JS proof before refs detach and enqueue UI-thread ownership revocation",
);
assert.match(
  sceneSource,
  /for \(const revision of presentationProofsRef\.current\.keys\(\)\)[\s\S]{0,220}presentationProofsRef\.current\.delete\(revision\)/,
  "rapid period changes must not retain an unbounded history of layout proofs",
);
const recordPresentationLayoutSource = sceneSource.slice(
  sceneSource.indexOf("const recordPresentationLayout"),
  sceneSource.indexOf("const handleHeight"),
);
assert.doesNotMatch(
  recordPresentationLayoutSource,
  /\.size|\.delete\(/,
  "late old onLayout events must never evict the already-recorded current proof before its double-frame publication",
);
assert.match(
  sceneSource,
  /recordPresentationLayout\("native", id, height, layoutRevision\);[\s\S]{0,120}layoutRevision !== presentationTargetRef\.current\.revision[\s\S]{0,100}pendingHeightByIdRef\.current\[id\] = height/,
  "a late layout event may be retained as bounded evidence but must not overwrite the current height batch",
);
assert.match(
  sceneSource,
  /cancelPresentationProofFrame\(\);[\s\S]{0,260}heightCommitScheduledRef\.current = false;[\s\S]{0,100}pendingHeightByIdRef\.current = \{\}/,
  "every new presentation must discard an unfinished height batch from the previous revision",
);
assert.match(
  sceneSource,
  /React\.useLayoutEffect\([\s\S]{0,120}clearTopScrollSettleTimer\(\);[\s\S]{0,120}autoScrollFrame\.setActive\(false\);[\s\S]{0,300}dragCode\.value = -1;[\s\S]{0,120}edgeScrollVelocity\.value = 0;/,
  "unmount must cancel delayed scroll commands, stop autoscroll and invalidate drag ownership before the ScrollView detaches",
);

const heatmapSource = readFileSync(
  "src/features/statistics/components/Heatmap.tsx",
  "utf8",
);
assert.equal(heatmapSource.match(/\.sort\(/g)?.length, 1);
assert.match(heatmapSource, /todayStr:\s*string/);
assert.doesNotMatch(
  heatmapSource,
  /format\(new Date\(\), "yyyy-MM-dd"\)/,
  "the Heatmap current-day highlight must use its presentation source date",
);
const loadHeatmapDateComparator = (
  source: string,
): ((left: { date: string }, right: { date: string }) => number) => {
  const match = source.match(
    /return \[\.\.\.data\]\.sort\(\(a, b\) =>\s*(a\.date[\s\S]*?: 0)\s*,?\s*\);/,
  );
  assert.ok(
    match,
    "the Heatmap date comparator must remain source-extractable",
  );
  return Function("a", "b", `return ${match[1]};`) as (
    left: { date: string },
    right: { date: string },
  ) => number;
};
const assertHeatmapDateOrdering = (
  comparator: (left: { date: string }, right: { date: string }) => number,
): void => {
  const dates = [
    "9999-12-31",
    "2026-10-02",
    "0001-01-01",
    "2011-12-30",
    "2024-02-29",
  ];
  assert.deepEqual(
    dates
      .map((date) => ({ date }))
      .sort(comparator)
      .map(({ date }) => date),
    ["0001-01-01", "2011-12-30", "2024-02-29", "2026-10-02", "9999-12-31"],
    "Heatmap date keys must sort in civil chronological order",
  );
  assert.equal(
    comparator({ date: "2011-12-30" }, { date: "2011-12-30" }),
    0,
    "equal Heatmap date keys must compare as equal",
  );
};
assertHeatmapDateOrdering(loadHeatmapDateComparator(heatmapSource));
const reversedHeatmapDateSource = heatmapSource.replace(
  /a\.date < b\.date \? -1 : a\.date > b\.date \? 1 : 0/,
  "a.date > b.date ? -1 : a.date < b.date ? 1 : 0",
);
assert.notEqual(
  reversedHeatmapDateSource,
  heatmapSource,
  "the reverse-order Heatmap mutation target must exist exactly in production source",
);
let reversedHeatmapDateRejected = false;
try {
  assertHeatmapDateOrdering(
    loadHeatmapDateComparator(reversedHeatmapDateSource),
  );
} catch (error) {
  if (!(error instanceof assert.AssertionError)) throw error;
  assert.match(error.message, /civil chronological order/);
  reversedHeatmapDateRejected = true;
}
assert.equal(
  reversedHeatmapDateRejected,
  true,
  "the Heatmap ordering fixture must reject a reversed comparator",
);
assert.match(heatmapSource, /calendarCellStylesByColor\.get\(/);
assert.match(heatmapSource, /from "react-native-svg"/);
assert.match(heatmapSource, /buildYearHeatmapPathLayout\(/);
assert.match(heatmapSource, /<Svg width="100%"/);
assert.doesNotMatch(heatmapSource, /yearCellStylesByColor/);
assert.match(heatmapSource, /style=\{legendCellStyles\[index\]\}/);

const singleColorYearLayout = buildYearHeatmapPathLayout({
  colors: Array<string>(32).fill("#123456"),
  availableWidth: 347.7,
  cellSize: 10,
  gap: 1,
  radius: 2,
});
assert.equal(singleColorYearLayout.columns, 31);
assert.equal(singleColorYearLayout.rows, 2);
assert.equal(singleColorYearLayout.height, 21);
assert.equal(singleColorYearLayout.groups.length, 1);
assert.equal(
  singleColorYearLayout.groups[0].path.match(/M/g)?.length,
  32,
  "every former native cell must remain one rounded SVG subpath",
);
assert.match(singleColorYearLayout.groups[0].path, /^M2 0H8A2 2/);
assert.match(singleColorYearLayout.groups[0].path, /M2 11H8A2 2/);

const mixedColorYearLayout = buildYearHeatmapPathLayout({
  colors: Array.from({ length: 365 }, (_, index) => `color-${index % 9}`),
  availableWidth: 347.7,
  cellSize: 10,
  gap: 1,
  radius: 2,
});
assert.equal(mixedColorYearLayout.columns, 31);
assert.equal(mixedColorYearLayout.rows, 12);
assert.equal(mixedColorYearLayout.height, 131);
assert.equal(mixedColorYearLayout.groups.length, 9);
assert.equal(
  mixedColorYearLayout.groups.reduce(
    (count, group) => count + (group.path.match(/M/g)?.length ?? 0),
    0,
  ),
  365,
);

function auditAccessibleOrderMath(move = getAdjacentReorder): void {
for (const ids of [["summary"], ["summary", "habit"], ["summary", "bar", "heatmap", "habit"]]) {
  for (let index = 0; index < ids.length; index += 1) {
    for (const direction of ["up", "down"] as const) {
      const next = move(ids, ids[index], direction);
      const to = index + (direction === "up" ? -1 : 1);
      if (to < 0 || to >= ids.length) assert.equal(next, null);
      else {
        assert.equal(next?.[to], ids[index]);
        assert.deepEqual([...next!].sort(), [...ids].sort());
      }
    }
    const actions = getReorderActions(index, ids.length, { up: "Move up", down: "Move down" });
    assert.equal(actions.some((action) => action.name === "decrement"), index > 0);
    assert.equal(actions.some((action) => action.name === "increment"), index < ids.length - 1);
  }
}
assert.equal(move(["summary", "summary"], "summary", "down"), null);
assert.equal(move(["summary"], "missing", "up"), null);
}
auditAccessibleOrderMath();
const accessibleOrderSource = readFileSync(new URL("../src/utils/accessibility-reorder.ts", import.meta.url), "utf8");
for (const [before, after] of [
  ['direction === "up" ? -1 : 1', 'direction === "up" ? 1 : -1'],
  ['if (to < 0 || to >= order.length) return null;', 'if (false) return null;'],
  ['from < 0 || order.lastIndexOf(id) !== from', 'from < 0'],
]) {
  assert.equal(accessibleOrderSource.split(before).length, 2);
  const mutant = loadSourceCallableForAudit<typeof getAdjacentReorder>(
    accessibleOrderSource.replace(before, after), "getAdjacentReorder", {},
  );
  assert.throws(() => auditAccessibleOrderMath(mutant), { name: "AssertionError" });
}
assert.deepEqual(getReorderActions(-1, 2, { up: "Up", down: "Down" }), []);
assert.equal(getReorderDirection("activate"), null);
assert.equal(getReorderDirection("increment"), "down");
assert.equal(getReorderDirection("decrement"), "up");

const statisticsScreenSource = readFileSync(new URL("../app/statistics.tsx", import.meta.url), "utf8");
function createPeriodMoveBlock(
  screenSource: string,
  period: StatisticsPeriod,
  visibleOrder: StatisticsBlockId[],
  readOrders: () => StatisticsBlockOrders,
  writeOrder: (period: StatisticsPeriod, order: StatisticsBlockId[]) => unknown,
) {
  const onReorderPeriod = loadSourceCallableForAudit<(period: StatisticsPeriod, base: StatisticsBlockId[], next: StatisticsBlockId[]) => void>(
    screenSource, "handlePeriodReorder", { setPersistedBlockOrder: writeOrder },
  );
  return loadSourceCallableForAudit<(id: StatisticsBlockId, direction: "up" | "down") => void>(
    screenSource, "handleMoveBlock", {
      period, visibleOrder, blockOrder: readOrders()[period], onReorderPeriod,
      useSettingsStore: { getState: () => ({ statisticsBlockOrders: readOrders() }) },
      normalizeStatisticsBlockOrder, DEFAULT_STATISTICS_BLOCK_ORDER, getAdjacentReorder,
    },
  );
}
function auditAccessibleStatisticsReorder(source: string, screenSource = statisticsScreenSource): void {
  const original: StatisticsBlockOrders = {
    week: ["habit", "summary", "heatmap", "bar"],
    month: ["summary", "bar", "heatmap", "habit"],
    year: ["heatmap", "bar", "habit", "summary"],
  };
  let orders = original;
  const calls: StatisticsPeriod[] = [];
  const writeOrder = (period: StatisticsPeriod, next: StatisticsBlockId[]) => {
    orders = replaceStatisticsBlockOrder(orders, period, next);
    calls.push(period);
  };
  const token = {};
  const base = {
    sceneInteractionAdmissionRef: { current: token }, sceneInteractionAdmissionToken: token,
    sceneInteractive: true, layoutReady: true, activeDropOwnerRef: { current: null },
    draggingCode: { value: -1 }, settling: { value: 0 },
    onMoveBlock: createPeriodMoveBlock(screenSource, "month", ["summary", "heatmap", "habit"], () => orders, writeOrder),
  };
  const load = (changes: Record<string, unknown> = {}) => loadSourceCallableForAudit<
    (id: string, direction: "up" | "down") => void
  >(source, "handleAccessibilityMove", { ...base, ...changes });
  const move = load();
  move("summary", "up");
  move("habit", "down");
  move("missing", "up");
  assert.equal(calls.length, 0, "period-relative bounds must use the requested namespace");
  move("habit", "up");
  assert.deepEqual(orders.month, ["summary", "bar", "habit", "heatmap"],
    "relative moves must preserve the hidden block slots of their period");
  move("habit", "up");
  assert.deepEqual(orders.month, ["habit", "bar", "summary", "heatmap"],
    "rapid statistics moves must read the current period order before React commits");
  move("habit", "down");
  move("habit", "down");
  assert.deepEqual(orders, original, "rapid statistics reversal must reach the original order");
  assert.equal(calls.length, 4);
  for (const changes of [
    { sceneInteractionAdmissionToken: {} }, { sceneInteractive: false },
    { layoutReady: false }, { activeDropOwnerRef: { current: {} } },
    { draggingCode: { value: 2 } }, { settling: { value: 1 } },
  ]) {
    load(changes)("habit", "up");
    assert.equal(calls.length, 4, "inactive, preparing, dragging and settling scenes must reject accessibility reorder");
  }
  const yearToken = {};
  base.sceneInteractionAdmissionRef.current = yearToken;
  move("habit", "up");
  assert.equal(calls.length, 4, "a callback retained by the old period cannot write after its admission expires");
  load({
    sceneInteractionAdmissionToken: yearToken,
    onMoveBlock: createPeriodMoveBlock(screenSource, "year", ["heatmap", "habit", "summary"], () => orders, writeOrder),
  })("summary", "up");
  assert.deepEqual(orders.year, ["heatmap", "bar", "summary", "habit"]);
  assert.deepEqual(orders.month, original.month);
  assert.deepEqual(orders.week, original.week);
  assert.deepEqual(calls, ["month", "month", "month", "month", "year"]);
}
auditAccessibleStatisticsReorder(reorderSource);
assert.throws(() => auditAccessibleStatisticsReorder(
  reorderSource.replace("!sceneInteractive || !layoutReady ||", "false ||"),
), /inactive, preparing/);
assert.throws(() => auditAccessibleStatisticsReorder(reorderSource, statisticsScreenSource.replace(
  "useSettingsStore.getState().statisticsBlockOrders[period]", "blockOrder",
)), /rapid statistics moves/);
assert.throws(() => auditAccessibleStatisticsReorder(reorderSource, statisticsScreenSource.replace(
  "useSettingsStore.getState().statisticsBlockOrders[period]", 'useSettingsStore.getState().statisticsBlockOrders["week"]',
)), /period-relative bounds|hidden block slots/);
assert.doesNotMatch(reorderSource, /accessibilityReorderRevisionRef/);
assert.throws(() => auditAccessibleStatisticsReorder(
  reorderSource.replace("activeDropOwnerRef.current != null || draggingCode.value >= 0 ||", "false ||"),
), /inactive, preparing/);

function auditLocalizedStatisticsActions(source: string): void {
  const tree = ts.createSourceFile("statistics.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const expressions = (attribute: string) => {
    const values: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && node.name.getText(tree) === attribute &&
        node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        values.push(node.initializer.expression.getText(tree));
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.equal(values.length, 1);
    return values[0];
  };
  const bindings = ["enabled", "reorderIndex", "reorderCount", "reorderLabels", "getReorderActions", "Platform"];
  const resolveActions = compileCallbackFactory<() => { name: string; label: string }[]>(
    `() => (${expressions("accessibilityActions")})`, bindings,
  );
  const resolveHandler = compileCallbackFactory<(event: unknown) => void>(
    expressions("onAccessibilityAction"),
    ["enabled", "reorderLabels", "getReorderDirection", "onAccessibilityMove", "id"],
  );
  for (const locale of ["de", "en", "es", "fr", "it", "nl", "pl", "ru", "uk"]) {
    const dictionary = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), "utf8")).accessibility;
    const labels = { up: dictionary.moveUp, down: dictionary.moveDown };
    for (const platform of ["ios", "android"]) {
      const calls: unknown[] = [];
      const environment = {
        enabled: true, reorderLabels: labels, getReorderDirection, id: "heatmap",
        onAccessibilityMove: (id: string, direction: string) => calls.push([id, direction]),
      };
      const handler = resolveHandler(environment);
      for (const index of [0, 1, 2]) {
        const actions = resolveActions({
          enabled: true, reorderIndex: index, reorderCount: 3,
          reorderLabels: labels, getReorderActions, Platform: { OS: platform },
        })();
        for (const action of actions) {
          const direction = action.label === labels.up ? "up" : "down";
          assert.equal(action.name, platform === "ios" ? action.label : direction === "up" ? "decrement" : "increment",
            "the native statistics rotor must receive localized iOS names and stable Android names");
          const before = calls.length;
          handler({ nativeEvent: { actionName: action.name } });
          assert.equal(calls.length, before + 1, "a statistics rotor action must dispatch once");
          assert.deepEqual(calls.at(-1), ["heatmap", direction]);
        }
      }
      for (const actionName of ["increment", "decrement"]) {
        const before = calls.length;
        handler({ nativeEvent: { actionName } });
        assert.equal(calls.length, before + 1);
      }
      const beforeIgnored = calls.length;
      for (const actionName of ["activate", "unrecognized-reorder-action"]) {
        handler({ nativeEvent: { actionName } });
      }
      const blocked = resolveHandler({ ...environment, enabled: false });
      blocked({ nativeEvent: { actionName: labels.up } });
      assert.equal(calls.length, beforeIgnored, "unknown, activation and disabled events must not reorder statistics");
    }
  }
}
auditLocalizedStatisticsActions(reorderSource);
assert.throws(() => auditLocalizedStatisticsActions(reorderSource.replace(
  "getReorderActions(reorderIndex, reorderCount, reorderLabels, true, Platform.OS)",
  "getReorderActions(reorderIndex, reorderCount, reorderLabels, true)",
)), /localized iOS names/);
assert.throws(() => auditLocalizedStatisticsActions(reorderSource.replace(
  "getReorderDirection(event.nativeEvent.actionName, reorderLabels)",
  "getReorderDirection(event.nativeEvent.actionName)",
)), /statistics rotor action must dispatch once/);

function auditSummaryHeaders(source: string): void {
  const jsx = (type: string, props: Record<string, unknown>) => ({ type, props });
  type Element = { type: string; props: Record<string, any> };
  const render = loadSourceCallableForAudit<(props: unknown) => Element>(source, "SummaryCards", {
    exports: {}, require: () => ({ jsx, jsxs: jsx }), View: "View", Text: "Text",
    Entypo: "Entypo", MaterialIcons: "MaterialIcons",
    useTranslation: () => ({ t: (key: string) => key }),
    useVisualColorScheme: () => "blue", useVisualEffectiveMode: () => "dark",
    getAccentScheme: () => ({ base: "#334455" }), lightTheme: {},
  }, true);
  for (const showProgress of [true, false]) {
    const tree = render({ periodProgress: "62", perfectDays: { count: 9, total: 20 }, showProgress });
    const [header, body] = tree.props.children.props.children as Element[];
    assert.equal(header.props.className, "flex-row",
      "both headers must share the same stretching Yoga row");
    const cells = (header.props.children as Element[]).filter(Boolean);
    assert.equal(cells.length, showProgress ? 2 : 1);
    for (const cell of cells) {
      assert.equal(cell.props.className, "flex-1", "column flex owners must not own unequal padding");
    }
    const right = cells.at(-1)!.props.children as Element;
    assert.equal(right.props.style.paddingRight, 44, "the title must reserve the complete inset handle area");
    const title = right.props.children.at(-1) as Element;
    assert.equal(title.props.numberOfLines, 2);
    assert.equal(title.props.style.flexShrink, 1);
    const rightBody = (body.props.children as Element[]).filter(Boolean).at(-1)!;
    for (const cell of (body.props.children as Element[]).filter(Boolean)) {
      assert.equal(cell.props.className, "flex-1", "body column flex owners must not own unequal padding");
    }
    assert.equal(rightBody.props.children.props.className, "items-center px-md pb-md pt-[16px]",
      "perfect-days value must use the aligned16dp top inset");
    assert.equal(rightBody.props.children.props.children.props.style.fontSize, 28);
  }
}
const summaryCardsSource = readFileSync(new URL("../src/features/statistics/components/SummaryCards.tsx", import.meta.url), "utf8");
auditSummaryHeaders(summaryCardsSource);
assert.throws(() => auditSummaryHeaders(summaryCardsSource.replace("paddingRight: 44", "paddingRight: 12")), /complete inset handle area/);
assert.throws(() => auditSummaryHeaders(summaryCardsSource.replaceAll("numberOfLines={2}", "numberOfLines={1}")), /strictly equal/);
assert.throws(() => auditSummaryHeaders(summaryCardsSource.replace("pt-[16px]", "pt-[14px]")), /aligned16dp/);
assert.throws(() => auditSummaryHeaders(summaryCardsSource.replace('className="flex-1"', 'className="flex-1 px-md"')), /unequal padding/);

const settingsStoreSource = readFileSync(new URL("../src/stores/settings-store.ts", import.meta.url), "utf8");
async function auditRelativeStatisticsPersistence(storeSource = settingsStoreSource): Promise<void> {
  const initialOrders: StatisticsBlockOrders = {
    week: ["habit", "summary", "heatmap", "bar"],
    month: ["summary", "bar", "heatmap", "habit"],
    year: ["heatmap", "bar", "habit", "summary"],
  };
  let state = { statisticsBlockOrders: initialOrders, error: null as string | null };
  type Completion = { status: string; confirmedValue?: StatisticsBlockId[]; error?: Error };
  type Submission = { scope: string; completion: Promise<Completion>; resolve: (value: Completion) => void };
  const submissions: Submission[] = [], writes: Promise<boolean>[] = [];
  const latest = new Map<string, Submission>();
  const setStatisticsBlockOrder = loadSourceCallableForAudit<
    (period: StatisticsPeriod, order: StatisticsBlockId[]) => Promise<boolean>
  >(storeSource, "setStatisticsBlockOrder", {
    get: () => state,
    set: (update: typeof state | ((current: typeof state) => typeof state)) => {
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
    },
    normalizeStatisticsBlockOrder, replaceStatisticsBlockOrder,
    settingErrorMessage: () => "Could not save order",
    settingsMutationCoordinator: {
      submit: ({ scope }: { scope: string }) => {
        let resolve!: (value: Completion) => void;
        const completion = new Promise<Completion>((resolveCompletion) => { resolve = resolveCompletion; });
        const submission = { scope, completion, resolve };
        submissions.push(submission);
        latest.set(scope, submission);
        return submission;
      },
      isLatest: (submission: Submission) => latest.get(submission.scope) === submission,
    },
  });
  const onMoveBlock = createPeriodMoveBlock(
    statisticsScreenSource, "month", ["summary", "heatmap", "habit"],
    () => state.statisticsBlockOrders,
    (period, order) => {
      const write = setStatisticsBlockOrder(period, order);
      writes.push(write);
      return write;
    },
  );
  const token = {};
  const admission = { current: token as object | null };
  const move = loadSourceCallableForAudit<(id: string, direction: "up" | "down") => void>(
    reorderSource, "handleAccessibilityMove", {
      sceneInteractionAdmissionRef: admission, sceneInteractionAdmissionToken: token,
      sceneInteractive: true, layoutReady: true,
      activeDropOwnerRef: { current: null }, draggingCode: { value: -1 }, settling: { value: 0 },
      onMoveBlock,
    },
  );
  const expectedLatest = ["heatmap", "bar", "summary", "habit"];
  try {
    move("habit", "up"); move("habit", "up");
    assert.deepEqual(state.statisticsBlockOrders.month, ["habit", "bar", "summary", "heatmap"]);
    move("habit", "down"); move("habit", "down");
    assert.deepEqual(state.statisticsBlockOrders, initialOrders);
    move("heatmap", "up");
    assert.deepEqual(state.statisticsBlockOrders.month, expectedLatest,
      "the actual settings owner must publish all accepted relative commands before persistence");
    assert.equal(writes.length, 5, "every accepted relative command must reach the settings owner");
    admission.current = null;
    move("heatmap", "down");
    assert.equal(writes.length, 5);
    submissions[0].resolve({ status: "failed", confirmedValue: initialOrders.month, error: new Error("Write failed") });
    await writes[0];
    assert.deepEqual(state.statisticsBlockOrders.month, expectedLatest,
      "an older settings completion must not replace the latest accessible order");
  } finally {
    submissions.forEach((submission) => submission.resolve({ status: "committed" }));
    await Promise.all(writes);
  }
  assert.deepEqual(state.statisticsBlockOrders.month, expectedLatest);
  assert.deepEqual(state.statisticsBlockOrders.week, initialOrders.week);
  assert.deepEqual(state.statisticsBlockOrders.year, initialOrders.year);
  assert.ok(submissions.every((submission) => submission.scope === "statisticsOrder:month"));
}
const relativeOrderDeadline = setTimeout(() => {
  console.error("Statistics accessibility persistence audit did not complete within10seconds");
  process.exitCode = 1;
}, 10_000);
void (async () => {
  await auditRelativeStatisticsPersistence();
  assert.equal(settingsStoreSource.split("if (settingsMutationCoordinator.isLatest(submission))").length > 1, true);
  const methodTree = ts.createSourceFile("settings.ts", settingsStoreSource, ts.ScriptTarget.Latest, true);
  let methodRange: { start: number; end: number } | undefined;
  const findMethod = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText(methodTree) === "setStatisticsBlockOrder") {
      methodRange = { start: node.getStart(methodTree), end: node.end };
    }
    ts.forEachChild(node, findMethod);
  };
  findMethod(methodTree);
  assert.ok(methodRange);
  const methodSource = settingsStoreSource.slice(methodRange.start, methodRange.end);
  assert.equal(methodSource.split("if (settingsMutationCoordinator.isLatest(submission))").length, 2);
  const staleCompletionSource = settingsStoreSource.slice(0, methodRange.start) +
    methodSource.replace("if (settingsMutationCoordinator.isLatest(submission))", "if (true)") +
    settingsStoreSource.slice(methodRange.end);
  await assert.rejects(() => auditRelativeStatisticsPersistence(staleCompletionSource), {
    name: "AssertionError", message: /older settings completion/,
  });
  console.log("Statistics block reorder audit passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => clearTimeout(relativeOrderDeadline));
