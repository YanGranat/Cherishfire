import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getNoteCaretScrollDelta, getNoteEditorVisibilityDecision } from "../src/features/notes/utils/editor-visibility";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import { auditNoteEditorRecoveryGeometry } from "./fixtures/audit-note-editor-lifecycle";

const source = readFileSync("app/habit/[id]/notes.tsx", "utf8");
const measure = (width: number, height: number | (() => number), getTop: () => number) => ({
  measure: (callback: (...values: number[]) => void) => callback(0, 0, width, typeof height === "function" ? height() : height, 0, getTop()),
});
const caret = { top: 720, bottom: 740, hostWidth: 300, hostHeight: 1000, textLength: 200, selectionStart: 80, selectionEnd: 80 };

async function auditRoute() {
  const commands: number[] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  let top = -250;
  let queries = 0;
  let wholeEditorMeasurements = 0;
  let editorHeight = 1000;
  let inputHeight = 1000;
  let currentCaret: typeof caret | null = caret;
  const offset = { current: 400 };
  const observedScrollGenerationRef = { current: 0 };
  const activeEditorGeometryRef = { current: null as any };
  const drag = { current: false };
  const momentum = { current: false };
  const completed = { current: null as string | null };
  const runs = { current: new Map() };
  const epoch = { current: 1 };
  const correction = { current: null as any };
  let liveRequestId = 1;
  let resolveQuery: ((value: typeof caret | null) => void) | null = null;
  let deferred = false;
  const input = measure(300, () => inputHeight, () => top);
  const editor = measure(300, () => editorHeight, () => top);
  const actions = measure(300, 32, () => top + editorHeight + 8);
  const entry = {
    requestId: 1,
    metrics: { length: 200, lineCount: 8, heightBucket: 1000, selectionAtEnd: false, contentRevision: 1, selectionStart: 80, selectionEnd: 80 },
    targets: {
      noteId: 7, requestId: 1, getRequestId: () => liveRequestId,
      editor: { measure: (callback: (...values: number[]) => void) => { wholeEditorMeasurements++; editor.measure(callback); } },
      actions: { measure: (callback: (...values: number[]) => void) => { wholeEditorMeasurements++; actions.measure(callback); } }, input,
      caretMetricsAvailable: true,
      readCaretMetrics: () => {
        queries++;
        return deferred ? new Promise<typeof caret | null>((resolve) => { resolveQuery = resolve; }) : Promise.resolve(currentCaret);
      },
    },
  };
  const getKey = loadSourceCallableForAudit<(...args: any[]) => string>(source, "getEditorGeometryKey", {});
  const execute = loadSourceCallableForAudit<(entry: any) => void>(source, "scheduleEditorGeometry", {
    hasNativeNoteEditorViewport: false,
    activeEditorSaveRef: { current: { noteId: 7 } }, activeEditorGeometryRef, keyboardTopRef: { current: 460 },
    clearEditorRevealFrame: () => {}, editorGeometryEnvironmentEpochRef: epoch,
    getEditorGeometryKey: getKey, completedEditorGeometryKeyRef: completed, editorGeometryFramesRef: runs,
    pendingEditorCorrectionRef: correction, getMonotonicNow: () => 100,
    EDITOR_VISIBILITY_MAX_FRAMES: 12, EDITOR_VISIBILITY_MAX_DURATION_MS: 250,
    EDITOR_VISIBILITY_TOLERANCE_DP: 0.5, clearTopScrollSettleTimer: () => {}, scrollOffsetRef: offset,
    observedScrollGenerationRef, isScrollDragActiveRef: drag, isMomentumScrollActiveRef: momentum,
    getNoteCaretScrollDelta,
    getNoteEditorVisibilityDecision,
    noteListRef: { current: {
      getNativeScrollRef: () => measure(300, 360, () => 100),
      scrollToOffset: ({ offset: target }: { offset: number }) => {
        commands.push(target);
        top -= target - offset.current;
        offset.current = target;
        observedScrollGenerationRef.current++;
        correction.current = null;
      },
    } },
    isPageMeasurable: (value: any) => typeof value?.measure === "function",
    requestAnimationFrame: (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id), setTimeout: () => 1, clearTimeout: () => {},
  });
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      const batch = [...frames.values()]; frames.clear();
      for (const callback of batch) callback();
    }
    assert.equal(frames.size, 0, "measurement retries must be bounded");
  };
  execute(entry);
  await settle();
  assert.deepEqual(commands, [442], "reveal only the hidden part of the native caret plus the 12dp gap");
  assert.equal(wholeEditorMeasurements, 4, "native queries must classify both the editor and its card actions before choosing caret-only scrolling");
  assert.equal(queries, 2, "stop after native movement confirms the caret is visible");
  assert.equal(runs.current.size, 0);
  execute(entry); await settle();
  assert.equal(queries, 2, "a completed geometry must not keep polling");
  const publish = loadSourceCallableForAudit<(...args: any[]) => void>(source, "handleNoteEditorGeometry", {
    activeEditorSaveRef: { current: { noteId: 7 } }, scheduleEditorGeometry: execute,
  });
  liveRequestId = 2;
  const duplicateTargets = { ...entry.targets, requestId: 2 };
  publish(2, duplicateTargets, entry.metrics);
  assert.equal(queries, 2, "a duplicate committed geometry must not start another native query");
  assert.equal(activeEditorGeometryRef.current.requestId, 2, "even a duplicate must retain the newest physical request identity");
  const revalidate = loadSourceCallableForAudit<() => void>(source, "revalidateActiveEditorGeometry", {
    clearEditorCorrectionRecheckFrame: () => {}, editorGeometryEnvironmentEpochRef: epoch,
    completedEditorGeometryKeyRef: completed, pendingEditorCorrectionRef: correction,
    activeEditorGeometryRef, scheduleEditorGeometry: execute,
  });
  revalidate(); await settle();
  assert.equal(queries, 3, "a later keyboard or viewport change must revalidate that newest duplicate request");
  liveRequestId = 1;
  const revised = { ...entry, metrics: { ...entry.metrics, contentRevision: 2 } };
  execute(revised); await settle();
  assert.equal(queries, 4, "same-length replacement must remeasure the actual native layout");
  const moved = { ...entry, metrics: { ...entry.metrics, selectionStart: 60, selectionEnd: 60 } };
  execute(moved); await settle();
  assert.equal(queries, 5, "a different interior caret must invalidate a completed measurement");
  deferred = true;
  completed.current = null;
  execute(entry);
  assert.ok(resolveQuery);
  liveRequestId = 2;
  (resolveQuery as (value: typeof caret) => void)(caret);
  await settle();
  assert.deepEqual(commands, [442], "a late native reply cannot move a superseded editor");
  liveRequestId = 1;
  execute(entry);
  observedScrollGenerationRef.current++;
  (resolveQuery as (value: typeof caret) => void)(caret);
  await Promise.resolve();
  assert.deepEqual(commands, [442], "native scrolling between measurements invalidates the old page position");
  deferred = false;
  await settle();
  completed.current = null;
  drag.current = true;
  const beforeDrag = queries;
  execute(entry); await settle();
  assert.equal(queries, beforeDrag, "a manual drag must not be fought by caret corrections");
  drag.current = false;
  momentum.current = true;
  execute(entry); await settle();
  assert.equal(queries, beforeDrag, "momentum scrolling must retain native ownership");
  momentum.current = false;
  completed.current = null;
  currentCaret = null;
  const beforeUnavailable = wholeEditorMeasurements;
  execute(entry); await settle();
  assert.equal(wholeEditorMeasurements, beforeUnavailable,
    "a transient missing native caret must not switch to a distant footer correction");
  assert.deepEqual(commands, [442]);
  for (const [height, selectionAtEnd, expectedOffset] of [
    [1000, true, 742], [80, false, 72], [80, true, 72],
  ] as const) {
    commands.length = 0;
    completed.current = null;
    correction.current = null;
    epoch.current++;
    editorHeight = height;
    inputHeight = height + 20;
    top = height === 1000 ? -250 : 400;
    offset.current = height === 1000 ? 400 : 0;
    currentCaret = {
      ...caret, hostHeight: inputHeight,
      top: height === 1000 ? 960 : selectionAtEnd ? 60 : 20,
      bottom: height === 1000 ? 980 : selectionAtEnd ? 80 : 40,
      selectionStart: selectionAtEnd ? 200 : 80,
      selectionEnd: selectionAtEnd ? 200 : 80,
    };
    execute({ ...entry, metrics: {
      ...entry.metrics, heightBucket: height, selectionAtEnd,
      contentRevision: epoch.current,
      selectionStart: currentCaret.selectionStart, selectionEnd: currentCaret.selectionEnd,
    } });
    await settle();
    assert.deepEqual(commands, [expectedOffset], "short and end editing must reveal the card Save action, not only its caret");
    assert.ok(top + editorHeight + 8 + 32 <= 460 - 12 + 0.5,
      "the complete card action row must fit above the keyboard gap");
  }
}

const geometry = { viewportTop: 100, viewportHeight: 360, inputTop: -250, caretTop: 720, caretBottom: 740, keyboardTop: 600 };
assert.equal(getNoteCaretScrollDelta(geometry), 42, "the measured list viewport, not only the keyboard, limits the caret");
assert.equal(getNoteCaretScrollDelta({ ...geometry, inputTop: -292 }), 0);
assert.equal(getNoteCaretScrollDelta({ ...geometry, inputTop: -292, caretTop: 380, caretBottom: 400 }), -24);
assert.equal(getNoteCaretScrollDelta({ ...geometry, viewportHeight: 20 }), null);
assert.equal(getNoteCaretScrollDelta({ ...geometry, caretTop: NaN }), null);
assert.equal(getNoteCaretScrollDelta({ ...geometry, caretTop: 740 }), null);
const auditDeadline = setTimeout(() => {
  console.error("Native caret visibility audit timed out.");
  process.exitCode = 1;
}, 10_000);
void (async () => {
  await auditRoute();
  await auditNoteEditorRecoveryGeometry();
})().then(() => {
  clearTimeout(auditDeadline);
  console.log("Native caret visibility audit passed.");
}).catch((error: unknown) => {
  clearTimeout(auditDeadline);
  console.error(error);
  process.exitCode = 1;
});
