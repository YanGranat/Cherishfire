import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadSourceCallableForAudit } from "./fixtures/load-source-callable-for-audit";
import {
  accentSchemes,
  createCustomAccentScheme,
  getAccentScheme,
  normalizeHexColor,
} from "../src/theme/colors";
import {
  getColorSchemeBase,
  getCustomColorsFromOptions,
  getSelectionAfterColorRemoval,
  getTransferColorSchemeOptions,
  hasDuplicateColorSchemeBase,
  findOverriddenBuiltinColor,
  normalizeBuiltinColorOverrides,
  normalizeColorSchemeOptions,
  normalizeSelectedColorScheme,
  reconcileBuiltinColorOverrides,
} from "../src/utils/color-scheme-options";
import { BUILTIN_COLOR_SCHEMES } from "../src/types/settings";

async function auditColorSubmissionAdmission(source: string): Promise<void> {
  let complete!: (succeeded: boolean) => void;
  let submissions = 0;
  let deletions = 0;
  const pending = new Promise<boolean>((resolvePending) => {
    complete = resolvePending;
  });
  const environment = {
    normalizedColor: "#123456",
    isDuplicate: false,
    isSubmitting: false,
    submissionInFlightRef: { current: false },
    submittedColorRef: { current: null as string | null },
    setIsSubmitting: () => {},
    canDelete: true,
    onSubmit: () => {
      submissions += 1;
      return pending;
    },
    onDelete: () => {
      deletions += 1;
      return pending;
    },
    console: { error: () => {} },
  };
  const submit = loadSourceCallableForAudit<() => Promise<void>>(
    source,
    "handleSubmit",
    environment,
  );
  const remove = loadSourceCallableForAudit<() => Promise<void>>(
    source,
    "handleDelete",
    environment,
  );
  const first = submit();
  const duplicate = submit();
  const competingDelete = remove();
  complete(true);
  await Promise.all([first, duplicate, competingDelete]);
  assert.equal(submissions, 1, "same-render Save must admit one color write");
  assert.equal(deletions, 0, "Delete must share the pending Save admission fence");
  await submit();
  assert.equal(submissions, 1, "successful Save retains admission until dismissal");

  for (const outcome of ["rejected", "false"] as const) {
    environment.submissionInFlightRef.current = false;
    environment.onSubmit = () => {
      submissions += 1;
      return outcome === "rejected"
        ? Promise.reject(new Error("ColorWriteFailed"))
        : Promise.resolve(false);
    };
    await submit();
    assert.equal(environment.submissionInFlightRef.current, false);
    const beforeRetry: number = submissions;
    await submit();
    assert.equal(submissions, beforeRetry + 1, "failed Save must permit retry");
  }

  environment.submissionInFlightRef.current = false;
  let finishDelete!: (succeeded: boolean) => void;
  const deletionPending = new Promise<boolean>((resolvePending) => {
    finishDelete = resolvePending;
  });
  environment.onDelete = () => {
    deletions += 1;
    return deletionPending;
  };
  const deleting = remove();
  const duplicateDelete = remove();
  const competingSave = submit();
  finishDelete(false);
  await Promise.all([deleting, duplicateDelete, competingSave]);
  assert.equal(deletions, 1, "same-render Delete must admit one color removal");
  assert.equal(environment.submissionInFlightRef.current, false);
}

async function run(): Promise<void> {
  assert.equal(normalizeHexColor(" #1f2464 "), "#1F2464");
  assert.equal(normalizeHexColor("#1F246"), null);
  assert.equal(normalizeHexColor("1F2464"), null);
  assert.equal(normalizeHexColor("#GG2464"), null);

  const custom = createCustomAccentScheme("#1F2464");
  assert.deepEqual(custom, {
    base: "#1F2464",
    pale: "#70739C",
    bright: "#191E52",
  });
  assert.deepEqual(getAccentScheme("#1F2464"), custom);
  assert.deepEqual(getAccentScheme("orange"), accentSchemes.orange);

  assert.deepEqual(
    normalizeColorSchemeOptions(null, ["#1F2464"]),
    ["#1F2464", ...BUILTIN_COLOR_SCHEMES],
    "old custom_colors settings must migrate ahead of the built-in list"
  );
  assert.deepEqual(
    normalizeColorSchemeOptions(["orange", "#1f2464", "orange", "bad"]),
    ["orange", "#1F2464"]
  );
  assert.deepEqual(normalizeColorSchemeOptions([]), ["orange"]);
  assert.deepEqual(
    getCustomColorsFromOptions(["orange", "#1F2464", "amethyst"]),
    ["#1F2464"]
  );
  assert.deepEqual(
    normalizeBuiltinColorOverrides({
      orange: "#123456",
      blue: "#654321",
      invalid: "#ABCDEF",
      sunset: "bad",
      amber: "#123456",
    }),
    { orange: "#123456", blue: "#654321" },
    "only unique valid builtin overrides may survive normalization"
  );
  assert.deepEqual(
    reconcileBuiltinColorOverrides(
      { orange: "#123456", blue: "#654321" },
      ["#123456", "blue", "amethyst"]
    ),
    { orange: "#123456" },
    "stale override metadata must not survive after its color is removed"
  );
  assert.equal(
    findOverriddenBuiltinColor({ orange: "#123456" }, "#123456"),
    "orange"
  );
  const transferOptions = getTransferColorSchemeOptions(
    ["#ABCDEF", "#123456", "amethyst"],
    { orange: "#123456" }
  );
  assert.deepEqual(transferOptions.slice(0, 4), [
    "#ABCDEF",
    "#123456",
    "sunset",
    "amber",
  ]);
  assert.equal(transferOptions.includes("orange"), false);
  assert.equal(transferOptions.includes("blue"), true);
  assert.equal(transferOptions.includes("amethyst"), true);
  assert.equal(
    transferOptions.length,
    BUILTIN_COLOR_SCHEMES.length + 1,
    "transfer keeps custom colors and overrides while restoring deleted builtins"
  );
  assert.equal(
    normalizeSelectedColorScheme("blue", ["orange", "amethyst"]),
    "orange"
  );
  assert.equal(getColorSchemeBase("orange"), accentSchemes.orange.base);
  assert.equal(
    hasDuplicateColorSchemeBase(["orange", "amethyst"], "#F66133"),
    true,
    "custom colors must not duplicate a built-in base color"
  );
  assert.equal(
    hasDuplicateColorSchemeBase(["orange", "amethyst"], "#F66133", 0),
    false,
    "the edited option itself must be excluded from duplicate detection"
  );
  assert.equal(
    getSelectionAfterColorRemoval(
      ["orange", "amethyst", "blue"],
      1,
      "amethyst"
    ),
    "blue",
    "removing the selected option must choose its nearest surviving neighbor"
  );
  assert.equal(
    getSelectionAfterColorRemoval(
      ["orange", "amethyst", "blue"],
      2,
      "blue"
    ),
    "amethyst"
  );
  assert.equal(
    getSelectionAfterColorRemoval(
      ["orange", "amethyst", "blue"],
      0,
      "blue"
    ),
    "blue",
    "removing an inactive option must preserve selection"
  );

  const dialogSource = readFileSync(
    resolve(import.meta.dirname, "../src/features/settings/components/CustomColorDialog.tsx"),
    "utf8",
  );
  await auditColorSubmissionAdmission(dialogSource);
  for (const [target, replacement] of [
    [
      /submissionInFlightRef.current = true;\s*submittedColorRef.current = normalizedColor;/,
      "void submissionInFlightRef; submittedColorRef.current = normalizedColor;",
    ],
    [
      /if \(!saved\) \{\s*submissionInFlightRef.current = false;/,
      "if (!saved) { void submissionInFlightRef;",
    ],
    [
      /submissionInFlightRef.current = true;\s*submittedColorRef.current = null;/,
      "void submissionInFlightRef; submittedColorRef.current = null;",
    ],
  ] as const) {
    assert.equal([...dialogSource.matchAll(new RegExp(target.source, "g"))].length, 1);
    await assert.rejects(
      () => auditColorSubmissionAdmission(dialogSource.replace(target, replacement)),
      { name: "AssertionError" },
      "a missing color admission or retry transition must fail its behavioral proof",
    );
  }
  console.log("custom color audit passed");
}

const auditDeadline = setTimeout(() => {
  console.error("Custom color audit did not complete within 10 seconds");
  process.exitCode = 1;
}, 10_000);
void run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(auditDeadline));
