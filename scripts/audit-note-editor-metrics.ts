import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { NoteEditorCaretMetrics } from "../src/platform/note-editor-metrics";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "src/platform/note-editor-metrics.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type MetricsReader = {
  hasNoteEditorCaretMetrics: boolean;
  readNoteEditorCaretMetrics(
    viewTag: number,
    eventCount: number | null,
    expectedText?: string | null,
  ): Promise<NoteEditorCaretMetrics | null>;
};

function load(platform: string, loadModule: () => unknown): MetricsReader {
  const module = { exports: {} };
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require(name: string) {
      if (name === "react-native") return { Platform: { OS: platform } };
      assert.equal(name, "expo");
      return {
        requireOptionalNativeModule(name: string) {
          assert.equal(name, "NoteEditorMetrics");
          return loadModule();
        },
      };
    },
  });
  return module.exports as MetricsReader;
}

const valid: NoteEditorCaretMetrics = {
  top: 64,
  bottom: 84,
  hostWidth: 248,
  hostHeight: 172,
  textLength: 18,
  selectionStart: 7,
  selectionEnd: 7,
};

async function audit(): Promise<void> {
  let webModuleLoads = 0;
  const web = load("web", () => { webModuleLoads += 1; return null; });
  assert.equal(web.hasNoteEditorCaretMetrics, false);
  assert.equal(await web.readNoteEditorCaretMetrics(12, null), null);
  assert.equal(webModuleLoads, 0, "web must not load the native module");

  for (const loadModule of [
    () => null,
    () => ({}),
    () => { throw new Error("unavailable"); },
  ]) {
    const absent = load("android", loadModule);
    assert.equal(absent.hasNoteEditorCaretMetrics, false);
    assert.equal(await absent.readNoteEditorCaretMetrics(12, 0), null);
  }

  let response: unknown = valid;
  let calls = 0;
  let lastArguments: unknown[] = [];
  const native = {
    getCaretMetrics(viewTag: number, eventCount: number | null, expectedText: string | null) {
      assert.equal(this, native, "native method receiver must be preserved");
      calls += 1;
      lastArguments = [viewTag, eventCount, expectedText];
      return Promise.resolve(response);
    },
  };
  const reader = load("android", () => native);
  assert.equal(reader.hasNoteEditorCaretMetrics, true);
  assert.equal(await reader.readNoteEditorCaretMetrics(12, 0), valid);
  assert.deepEqual(lastArguments, [12, 0, null]);
  assert.equal(await reader.readNoteEditorCaretMetrics(12, null), valid);
  assert.deepEqual(lastArguments, [12, null, null]);
  for (const expectedText of ["", "Updated paragraph", "a\u0301", "\u00e1", "\ud83d\ude42"]) {
    assert.equal(await reader.readNoteEditorCaretMetrics(12, 4, expectedText), valid);
    assert.deepEqual(lastArguments, [12, 4, expectedText], "programmatic text must be forwarded without normalization");
  }

  const beforeInvalidArguments = calls;
  for (const tag of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await reader.readNoteEditorCaretMetrics(tag, 0), null);
  }
  for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await reader.readNoteEditorCaretMetrics(12, count), null);
  }
  for (const expectedText of [0, false, {}, []]) {
    assert.equal(await reader.readNoteEditorCaretMetrics(12, 0, expectedText as unknown as string), null);
  }
  assert.equal(calls, beforeInvalidArguments, "invalid arguments must not reach native code");

  const invalidResponses: unknown[] = [null, undefined, false, 1, "metrics", {}];
  for (const field of ["top", "bottom", "hostWidth", "hostHeight"] as const) {
    for (const value of [NaN, Infinity, -Infinity, "1", undefined]) {
      invalidResponses.push({ ...valid, [field]: value });
    }
  }
  invalidResponses.push(
    { ...valid, top: -1 },
    { ...valid, bottom: valid.top },
    { ...valid, bottom: valid.top - 1 },
    { ...valid, bottom: valid.hostHeight + 1 },
    { ...valid, hostWidth: 0 },
    { ...valid, hostHeight: 0 },
    { ...valid, textLength: -1 },
    { ...valid, textLength: 1.5 },
    { ...valid, selectionStart: -1, selectionEnd: -1 },
    { ...valid, selectionStart: 1.5, selectionEnd: 1.5 },
    { ...valid, selectionStart: 3, selectionEnd: 6 },
    { ...valid, selectionStart: 19, selectionEnd: 19 },
  );
  for (response of invalidResponses) {
    assert.equal(await reader.readNoteEditorCaretMetrics(12, 3), null);
    assert.equal(reader.hasNoteEditorCaretMetrics, true, "a pending layout is not an absent module");
  }

  response = { ...valid, top: 0, bottom: 20, textLength: 0, selectionStart: 0, selectionEnd: 0 };
  assert.equal(await reader.readNoteEditorCaretMetrics(12, 3), response);

  for (const getCaretMetrics of [
    () => { throw new Error("detached"); },
    () => Promise.reject(new Error("detached")),
  ]) {
    const failing = load("ios", () => ({ getCaretMetrics }));
    assert.equal(failing.hasNoteEditorCaretMetrics, true);
    assert.equal(await failing.readNoteEditorCaretMetrics(12, null), null);
  }
}

const deadline = setTimeout(() => {
  console.error("Note editor metrics wrapper audit timed out.");
  process.exitCode = 1;
}, 10_000);
void audit().then(
  () => {
    clearTimeout(deadline);
    console.log("Note editor metrics wrapper audit passed.");
  },
  (error: unknown) => {
    clearTimeout(deadline);
    console.error(error);
    process.exitCode = 1;
  },
);
