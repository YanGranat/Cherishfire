import assert from "node:assert/strict";
import { withAuditDeadline } from "./fixtures/with-audit-deadline";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXPORT_SCHEMA_VERSION,
  MIN_SUPPORTED_EXPORT_SCHEMA_VERSION,
  buildExportJsonFromRows as buildExportJsonFromRowsAt,
  normalizeImportData,
  previewImportData,
  validateImportData,
  verifyRestoredImportRows,
} from "../src/application/data-transfer/data-transfer-codec";
import { createHabitPersistenceApplication } from "../src/application/habits/habit-persistence";
import { isDateInArchiveHistory, normalizeArchiveHistory } from "../src/domain/habits/archive-periods";
import { loadSqliteRepositoriesForAudit } from "./fixtures/load-sqlite-repositories-for-audit";
import type { DataTransferRows } from "../src/application/data-transfer/data-transfer-model";
import type { ArchivePeriod } from "../src/types/habit";
import {
  MAX_DATA_TRANSFER_IMPORT_BYTES,
  DataTransferImportSizeError,
  DataTransferImportSizeUnavailableError,
  assertDataTransferImportByteLength,
  assertDataTransferImportTextSize,
  readBoundedDataTransferImportText,
} from "../src/application/data-transfer/data-transfer-limits";
import {
  BUILTIN_COLOR_SCHEMES,
  STATISTICS_BLOCK_ORDER_KEYS,
} from "../src/types/settings";

const root = resolve(import.meta.dirname, "..");
const fixturePath = resolve(
  root,
  "scripts/fixtures/export-v5-baseline.json"
);
const baselineJson = readFileSync(fixturePath, "utf8");
const baselineObject = JSON.parse(baselineJson) as Record<string, unknown>;
type ExportBuildParams = Parameters<typeof buildExportJsonFromRowsAt>[0];

function buildExportJsonFromRows(
  params: Omit<ExportBuildParams, "exportedAt"> & {
    exportedAt?: string;
  },
): string {
  return buildExportJsonFromRowsAt({
    ...params,
    exportedAt:
      params.exportedAt ?? (baselineObject.exported_at as string),
  });
}

assert.equal(EXPORT_SCHEMA_VERSION, 5);
assert.equal(MIN_SUPPORTED_EXPORT_SCHEMA_VERSION, 5);
assert.equal(MAX_DATA_TRANSFER_IMPORT_BYTES, 64 * 1024 * 1024);
assert.equal(assertDataTransferImportTextSize("ascii"), 5);
assert.equal(assertDataTransferImportTextSize("Привет 👋"), 17);
assert.doesNotThrow(() =>
  assertDataTransferImportByteLength(MAX_DATA_TRANSFER_IMPORT_BYTES),
);
assert.throws(
  () =>
    assertDataTransferImportByteLength(MAX_DATA_TRANSFER_IMPORT_BYTES + 1),
  /supported size limit/,
);
assert.equal(validateImportData(baselineJson).valid, true);
assert.deepEqual(previewImportData(baselineJson), {
  habitsCount: 2,
  archivedHabitsCount: 1,
  dayRecordsCount: 3,
  notesCount: 2,
});

const normalized = normalizeImportData(baselineJson);
const rebuiltJson = buildExportJsonFromRows({
  habits: normalized.habits,
  dayRecords: normalized.day_records,
  notes: normalized.notes,
  settings: normalized.settings,
  exportedAt: baselineObject.exported_at as string,
});
assert.deepEqual(JSON.parse(rebuiltJson), baselineObject);
assert.equal(
  rebuiltJson,
  baselineJson.trimEnd(),
  "schema-v5 export bytes must remain stable apart from the fixture's final newline",
);
assert.equal(validateImportData(rebuiltJson).valid, true);

const periodSpecificOrders = {
  week: ["summary", "bar", "heatmap", "habit"],
  month: ["heatmap", "habit", "summary", "bar"],
  year: ["habit", "summary", "heatmap", "bar"],
} as const;
const exportWithPeriodSpecificOrders = buildExportJsonFromRows({
  habits: normalized.habits,
  dayRecords: normalized.day_records,
  notes: normalized.notes,
  settings: normalized.settings.concat(
    ...(["week", "month", "year"] as const).map((period) => ({
      key: STATISTICS_BLOCK_ORDER_KEYS[period],
      value: JSON.stringify(periodSpecificOrders[period]),
    }))
  ),
});
const importedPeriodSpecificOrders = new Map(
  normalizeImportData(exportWithPeriodSpecificOrders).settings.map((row) => [
    row.key,
    JSON.parse(row.value),
  ])
);
for (const period of ["week", "month", "year"] as const) {
  assert.deepEqual(
    importedPeriodSpecificOrders.get(STATISTICS_BLOCK_ORDER_KEYS[period]),
    periodSpecificOrders[period],
    `${period} statistics order must survive export/import independently`
  );
}

assert.throws(
  () =>
    buildExportJsonFromRows({
      habits: normalized.habits,
      dayRecords: normalized.day_records,
      notes: normalized.notes,
      settings: normalized.settings.concat({
        key: STATISTICS_BLOCK_ORDER_KEYS.month,
        value: JSON.stringify(["summary", "summary", "heatmap", "habit"]),
      }),
    }),
  /statistics_block_order_month/
);

const existingHabitId = normalized.habits[0].id;
const exportWithStaleDescriptionMetadata = buildExportJsonFromRows({
  habits: normalized.habits,
  dayRecords: normalized.day_records,
  notes: normalized.notes,
  settings: normalized.settings.concat(
    {
      key: `habit_description_lines_v1:${existingHabitId}`,
      value: JSON.stringify(4),
    },
    {
      key: "habit_description_lines_v1:999999",
      value: JSON.stringify(7),
    }
  ),
});
const repairedDescriptionSettings = normalizeImportData(
  exportWithStaleDescriptionMetadata
).settings;
assert.equal(
  repairedDescriptionSettings.some(
    (row) => row.key === `habit_description_lines_v1:${existingHabitId}`
  ),
  true,
  "description height for an existing habit must remain exportable"
);
assert.equal(
  repairedDescriptionSettings.some(
    (row) => row.key === "habit_description_lines_v1:999999"
  ),
  false,
  "stale description height for a deleted habit must not break export"
);
assert.throws(
  () =>
    buildExportJsonFromRows({
      habits: normalized.habits,
      dayRecords: normalized.day_records,
      notes: normalized.notes,
      settings: normalized.settings.concat({
        key: "habit_description_lines_v1:broken",
        value: JSON.stringify(4),
      }),
    }),
  /description size/,
  "malformed scoped settings must still be rejected as corruption"
);

const editableColorSettings = normalized.settings
  .map((row) => {
    if (row.key === "color_scheme") {
      return { ...row, value: JSON.stringify("#123456") };
    }
    if (row.key === "custom_colors") {
      return { ...row, value: JSON.stringify(["#123456"]) };
    }
    return row;
  })
  .concat({
    key: "color_scheme_options",
    value: JSON.stringify(["#123456", "amethyst"]),
  });
const editableColorExport = buildExportJsonFromRows({
  habits: normalized.habits,
  dayRecords: normalized.day_records,
  notes: normalized.notes,
  settings: editableColorSettings,
});
assert.deepEqual(
  normalizeImportData(editableColorExport).settings.find(
    (row) => row.key === "color_scheme_options"
  ),
  {
    key: "color_scheme_options",
    value: JSON.stringify(["#123456", ...BUILTIN_COLOR_SCHEMES]),
  }
);

const builtinOverrideSettings = normalized.settings
  .map((row) => {
    if (row.key === "color_scheme") {
      return { ...row, value: JSON.stringify("#123456") };
    }
    if (row.key === "custom_colors") {
      return {
        ...row,
        value: JSON.stringify(["#654321", "#123456"]),
      };
    }
    return row;
  })
  .concat(
    {
      key: "color_scheme_options",
      value: JSON.stringify(["#654321", "#123456", "amethyst"]),
    },
    {
      key: "color_scheme_builtin_overrides",
      value: JSON.stringify({ orange: "#123456" }),
    }
  );
const builtinOverrideExport = buildExportJsonFromRows({
  habits: normalized.habits,
  dayRecords: normalized.day_records,
  notes: normalized.notes,
  settings: builtinOverrideSettings,
});
const builtinOverrideImport = normalizeImportData(builtinOverrideExport);
const transferredSettings = new Map(
  builtinOverrideImport.settings.map((row) => [row.key, JSON.parse(row.value)])
);
const transferredOptions = transferredSettings.get(
  "color_scheme_options"
) as string[];
assert.deepEqual(transferredOptions.slice(0, 4), [
  "#654321",
  "#123456",
  "sunset",
  "amber",
]);
assert.equal(transferredOptions.includes("orange"), false);
assert.equal(transferredOptions.includes("blue"), true);
assert.equal(transferredOptions.includes("amethyst"), true);
assert.equal(
  transferredOptions.length,
  BUILTIN_COLOR_SCHEMES.length + 1,
  "deleted unmodified presets must be restored by export/import"
);
assert.deepEqual(transferredSettings.get("custom_colors"), [
  "#654321",
  "#123456",
]);
assert.deepEqual(
  transferredSettings.get("color_scheme_builtin_overrides"),
  { orange: "#123456" }
);

assert.throws(
  () =>
    buildExportJsonFromRows({
      habits: normalized.habits,
      dayRecords: normalized.day_records,
      notes: normalized.notes,
      settings: builtinOverrideSettings.map((row) =>
        row.key === "color_scheme_builtin_overrides"
          ? { ...row, value: JSON.stringify({ orange: "#ABCDEF" }) }
          : row
      ),
    }),
  /color_scheme_builtin_overrides mapping/
);

assert.throws(
  () =>
    buildExportJsonFromRows({
      habits: normalized.habits,
      dayRecords: normalized.day_records,
      notes: normalized.notes,
      settings: editableColorSettings.map((row) =>
        row.key === "color_scheme_options"
          ? { ...row, value: JSON.stringify([]) }
          : row
      ),
    }),
  /Invalid setting color_scheme_options/
);

assert.throws(
  () =>
    buildExportJsonFromRows({
      habits: normalized.habits,
      dayRecords: normalized.day_records,
      notes: normalized.notes,
      settings: editableColorSettings.map((row) =>
        row.key === "color_scheme_options"
          ? { ...row, value: JSON.stringify(["amethyst"]) }
          : row
      ),
    }),
  /color_scheme_options projection|Invalid setting color_scheme/
);

function buildFixtureSettingsSignature(
  rows: { key: string; value: string }[],
): string {
  const input = rows
    .map((row) => JSON.stringify({ key: row.key, value: row.value }))
    .sort()
    .join("\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const tamperedBaselineWithoutOneSetting = JSON.parse(
  baselineJson,
) as Record<string, any>;
tamperedBaselineWithoutOneSetting.settings =
  tamperedBaselineWithoutOneSetting.settings.filter(
  (setting: { key: string }) => setting.key !== "sound_enabled"
);
assert.equal(
  validateImportData(JSON.stringify(tamperedBaselineWithoutOneSetting)).valid,
  false,
  "removing a setting without updating integrity must be rejected",
);

const validOlderBaselineWithoutOneSetting = structuredClone(
  tamperedBaselineWithoutOneSetting,
);
validOlderBaselineWithoutOneSetting.integrity.settings_count =
  validOlderBaselineWithoutOneSetting.settings.length;
validOlderBaselineWithoutOneSetting.integrity.settings_signature =
  buildFixtureSettingsSignature(validOlderBaselineWithoutOneSetting.settings);
assert.equal(
  validateImportData(JSON.stringify(validOlderBaselineWithoutOneSetting)).valid,
  true,
  "new app defaults must be able to fill settings absent from an older supported export"
);

const duplicateSetting = JSON.parse(baselineJson) as Record<string, any>;
duplicateSetting.settings.push({
  key: "theme",
  value: JSON.stringify("light"),
});
const duplicateSettingResult = validateImportData(
  JSON.stringify(duplicateSetting),
);
assert.equal(
  duplicateSettingResult.valid,
  false,
  "a duplicate setting key must not be collapsed before integrity validation",
);
assert.match(duplicateSettingResult.error ?? "", /Invalid settings\[\d+\]\.key/);

function mutateBaseline(
  mutate: (value: Record<string, any>) => void
): ReturnType<typeof validateImportData> {
  const clone = JSON.parse(baselineJson) as Record<string, any>;
  mutate(clone);
  return validateImportData(JSON.stringify(clone));
}

for (const [table, field] of [
  ["habits", "id"],
  ["habits", "displayOrder"],
  ["day_records", "id"],
  ["day_records", "habitId"],
  ["notes", "id"],
  ["notes", "habitId"],
] as const) {
  const invalid = mutateBaseline((value) => {
    value[table][0][field] = Number.MAX_SAFE_INTEGER + 1;
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.error?.includes(`${table}[0].${field}`), "unsafe integer identity must fail field validation before integrity or persistence");
}
assert.throws(
  () => buildExportJsonFromRows({
    habits: normalized.habits.map((habit, index) => index === 0 ? { ...habit, id: Number.MAX_SAFE_INTEGER + 1 } : habit),
    dayRecords: normalized.day_records,
    notes: normalized.notes,
    settings: normalized.settings,
  }),
  /Invalid habits\[0\]\.id/,
  "export validation must not manufacture a valid-integrity file with an unsafe persistent identity",
);
const largestSafeHabit = buildExportJsonFromRows({
  habits: [{ ...normalized.habits[0], id: Number.MAX_SAFE_INTEGER, displayOrder: Number.MAX_SAFE_INTEGER }],
  dayRecords: [],
  notes: [],
  settings: normalized.settings,
});
assert.equal(normalizeImportData(largestSafeHabit).habits[0].id, Number.MAX_SAFE_INTEGER);

const oldVersion = mutateBaseline((value) => {
  value.version = 4;
});
assert.equal(oldVersion.valid, false);
assert.match(oldVersion.error ?? "", /Unsupported old export version: 4/);

const futureVersion = mutateBaseline((value) => {
  value.version = 6;
});
assert.equal(futureVersion.valid, false);
assert.match(futureVersion.error ?? "", /Unsupported future export version: 6/);

assert.equal(
  mutateBaseline((value) => {
    value.dayRecords = value.day_records;
    delete value.day_records;
  }).valid,
  false,
  "legacy camelCase dayRecords must not remain an implicit migration path"
);
assert.equal(
  mutateBaseline((value) => {
    value.habits[0].id = "1";
  }).valid,
  false,
  "legacy numeric strings must not be coerced"
);
assert.equal(
  mutateBaseline((value) => {
    delete value.habits[0].archiveHistory;
  }).valid,
  false,
  "baseline archive history is required"
);
assert.equal(
  mutateBaseline((value) => {
    delete value.habits[0].repeatConfig.scheduleHistory;
  }).valid,
  false,
  "baseline schedule history is required"
);
assert.equal(
  mutateBaseline((value) => {
    delete value.integrity;
  }).valid,
  false,
  "baseline integrity block is required"
);
assert.equal(
  mutateBaseline((value) => {
    value.notes[0].text = "tampered";
  }).valid,
  false,
  "source rows must match the frozen baseline integrity signatures"
);

const invalidTheme = mutateBaseline((value) => {
  const row = value.settings.find(
    (setting: { key: string }) => setting.key === "theme"
  );
  row.value = JSON.stringify("not-a-theme");
});
assert.equal(invalidTheme.valid, false);
assert.match(invalidTheme.error ?? "", /Invalid setting theme/);

const duplicateScheduleBoundary = mutateBaseline((value) => {
  const history = value.habits[0].repeatConfig.scheduleHistory;
  history.push(structuredClone(history[0]));
});
assert.equal(duplicateScheduleBoundary.valid, false);
assert.match(
  duplicateScheduleBoundary.error ?? "",
  /scheduleHistory order/
);

const contradictoryArchiveState = mutateBaseline((value) => {
  value.habits[0].archiveHistory = [
    {
      archivedAt: Date.parse("2026-07-22T10:00:00.000Z"),
      restoredAt: null,
      archivedDate: "2026-07-22",
      restoredDate: null,
    },
  ];
});
assert.equal(contradictoryArchiveState.valid, false);
assert.match(contradictoryArchiveState.error ?? "", /active state/);

const invalidBuilderSettings = normalized.settings.map((row) =>
  row.key === "theme"
    ? { ...row, value: JSON.stringify("not-a-theme") }
    : row
);
assert.throws(
  () =>
    buildExportJsonFromRows({
      habits: normalized.habits,
      dayRecords: normalized.day_records,
      notes: normalized.notes,
      settings: invalidBuilderSettings,
    }),
  /Invalid setting theme/
);

const exportSource = readFileSync(
  resolve(root, "src/application/data-transfer/data-transfer-codec.ts"),
  "utf8",
);
assert.ok(
  exportSource.indexOf("assertDataTransferImportTextSize(jsonString)") <
    exportSource.indexOf("JSON.parse(jsonString)"),
  "every codec caller must hit the size boundary before JSON.parse",
);
assert.doesNotMatch(exportSource, /version < 3|version < 4|version < 5/);
assert.doesNotMatch(exportSource, /parsed\.dayRecords/);

const importReaderSource = readFileSync(
  resolve(root, "src/platform/data-transfer/select-import-file.ts"),
  "utf8",
);
assert.match(
  importReaderSource,
  /type: "\*\/\*"/,
  "the picker must accept valid exports whose provider reports a generic MIME type",
);
assert.match(
  importReaderSource,
  /copyToCacheDirectory: true/,
  "the picker must expose a private local file whose real size can be inspected before reading",
);
assert.match(importReaderSource, /const file = new File\(asset\.uri\)/);
assert.match(importReaderSource, /readBoundedDataTransferImportText\(\{/);
assert.doesNotMatch(importReaderSource, /asset\.size|getInfoAsync|readAsStringAsync/);

const migrationSource = readFileSync(
  resolve(root, "drizzle/0000_lonely_victor_mancha.sql"),
  "utf8"
);
const migrationRegistry = readFileSync(
  resolve(root, "drizzle/migrations.js"),
  "utf8"
);
const migrationJournal = JSON.parse(
  readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")
) as { entries: { idx: number; when: number; tag: string }[] };
assert.match(migrationSource, /`reason_type` text/);
assert.match(migrationSource, /`archive_history` text DEFAULT '\[\]' NOT NULL/);
assert.doesNotMatch(migrationSource, /ALTER TABLE|UPDATE `habits`|DELETE FROM/);
assert.ok(migrationJournal.entries.some((entry) => entry.tag === "0001_habit_display_order"));
for (const entry of migrationJournal.entries) {
  assert.ok(migrationRegistry.includes(`from './${entry.tag}.sql'`),
    "every journal migration must be imported by the native registry");
  assert.match(migrationRegistry, new RegExp(`\\bm${String(entry.idx).padStart(4, "0")}\\b`));
}
const legacyLastMigrationTimestamp = 1784800000000;
for (const entry of migrationJournal.entries.slice(1)) {
  assert.ok(
    entry.when > legacyLastMigrationTimestamp,
    "every post-1.3.55 migration timestamp must sort after previously released migrations"
  );
}

async function auditBoundedImportRead(): Promise<void> {
  let readCalls = 0;
  const accepted = await readBoundedDataTransferImportText({
    getByteLength: () => 5,
    readText: async () => {
      readCalls += 1;
      return "ascii";
    },
  });
  assert.deepEqual(accepted, { text: "ascii", byteLength: 5 });
  assert.equal(readCalls, 1);

  readCalls = 0;
  await assert.rejects(
    readBoundedDataTransferImportText({
      getByteLength: () => undefined,
      readText: async () => {
        readCalls += 1;
        return "must not be read";
      },
    }),
    DataTransferImportSizeUnavailableError,
  );
  assert.equal(
    readCalls,
    0,
    "a file with unknown size must never be loaded into JS memory",
  );

  readCalls = 0;
  await assert.rejects(
    readBoundedDataTransferImportText({
      getByteLength: () => MAX_DATA_TRANSFER_IMPORT_BYTES + 1,
      readText: async () => {
        readCalls += 1;
        return "must not be read";
      },
    }),
    DataTransferImportSizeError,
  );
  assert.equal(
    readCalls,
    0,
    "an oversized file must be rejected before entering JS memory",
  );
}

function canonicalFixtureJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item != null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ))
      : item,
  );
}

function signFixtureHabits(value: Record<string, any>): void {
  const entries = value.habits.map((habit: Record<string, any>) =>
    canonicalFixtureJson({
      ...habit,
      archivedAt: habit.archivedAt == null ? null : Date.parse(habit.archivedAt),
      archiveHistory: normalizeArchiveHistory(habit.archiveHistory),
      createdAt: Date.parse(habit.createdAt),
      updatedAt: Date.parse(habit.updatedAt),
    }),
  ).sort();
  let hash = 0x811c9dc5;
  const input = entries.join("\n");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  value.integrity.habits_signature = (hash >>> 0).toString(16).padStart(8, "0");
  value.integrity.archived_habits_count = value.habits.filter(
    (habit: Record<string, any>) => habit.isArchived,
  ).length;
}

function assertInvalidArchiveHistory(
  json: string,
  mutate: (habit: Record<string, any>) => void,
  expected: RegExp,
): void {
  const value = JSON.parse(json) as Record<string, any>;
  mutate(value.habits[0]);
  signFixtureHabits(value);
  const invalid = validateImportData(JSON.stringify(value));
  assert.equal(invalid.valid, false, "invalid archive chronology must not become importable with a valid signature");
  assert.match(invalid.error ?? "", expected);
  assert.doesNotMatch(invalid.error ?? "", /integrity/i);
}

async function auditArchiveTimezoneRoundTrip(): Promise<void> {
  const previousTimezone = process.env.TZ;
  const fixture = loadSqliteRepositoriesForAudit();
  const application = createHabitPersistenceApplication(fixture.habits);
  const dateKeys = ["2032-04-09", "2032-04-10", "2032-04-11", "2032-04-12"];
  const membership = (history: ArchivePeriod[]) =>
    dateKeys.map((date) => isDateInArchiveHistory(date, history));
  let closedJson = "";
  try {
    const startDate = "2032-04-01";
    const repeatSchedule = { type: "daily" } as const;
    const createdAt = Date.parse(`${startDate}T00:00:00.000Z`);
    const habit = await application.createHabit({
      habit: {
        name: "Practice", description: null, descriptionVisible: true,
        repeatSchedule, scheduleHistory: [{ effectiveFrom: startDate, startDate, repeatSchedule }],
        startDate, reminderEnabled: false, reminderTime: null, displayOrder: 0,
        isArchived: false, archivedAt: null, archiveHistory: [], createdAt, updatedAt: createdAt,
      },
      resolveDisplayOrderFromStorage: true,
    });
    process.env.TZ = "Pacific/Kiritimati";
    await application.archiveHabit(habit.id, Date.parse("2032-04-10T00:00:00.000Z"));
    await application.restoreHabits([habit.id], Date.parse("2032-04-11T00:00:00.000Z"));
    process.env.TZ = "Pacific/Honolulu";
    await application.archiveHabit(habit.id, Date.parse("2032-04-11T05:00:00.000Z"));
    const assertRoundTrip = async (expectedMembership: boolean[]): Promise<string> => {
      const snapshot: DataTransferRows = await fixture.transfers.readConsistentSnapshot();
      const expectedHistory = snapshot.habits[0].archiveHistory;
      assert.equal(expectedHistory[0].restoredDate, "2032-04-11");
      assert.equal(expectedHistory[1].archivedDate, "2032-04-10");
      assert.ok(expectedHistory[1].archivedAt > expectedHistory[0].restoredAt!);
      assert.deepEqual(membership(expectedHistory), expectedMembership);
      let json = "";
      assert.doesNotThrow(() => {
        json = buildExportJsonFromRows({ ...snapshot, exportedAt: "2032-04-13T00:00:00.000Z" });
      }, "chronological archive instants with overlapping local dates must remain exportable");
      const signed = JSON.parse(json) as Record<string, any>;
      const expectedSignature = signed.integrity.habits_signature;
      signFixtureHabits(signed);
      assert.equal(signed.integrity.habits_signature, expectedSignature, "fixture signatures must match ordinary exports before adversarial edits");
      const imported = normalizeImportData(json);
      assert.deepEqual(imported.habits[0].archiveHistory, expectedHistory, "export/import must preserve captured local archive boundaries");
      process.env.TZ = "Europe/Berlin";
      await fixture.transfers.replaceAndVerify(imported, (rows) => verifyRestoredImportRows(imported, rows));
      const restored = await fixture.transfers.readConsistentSnapshot();
      assert.deepEqual(restored.habits[0].archiveHistory, expectedHistory);
      assert.deepEqual(membership(restored.habits[0].archiveHistory), expectedMembership, "timezone changes must preserve union membership after SQLite restoration");
      return json;
    };
    await assertRoundTrip([false, true, true, true]);
    process.env.TZ = "Pacific/Honolulu";
    await application.restoreHabits([habit.id], Date.parse("2032-04-12T05:00:00.000Z"));
    closedJson = await assertRoundTrip([false, true, false, false]);
  } finally {
    fixture.database.close();
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }

  assertInvalidArchiveHistory(closedJson, (habit) => {
    habit.archiveHistory[1].archivedAt = habit.archiveHistory[0].restoredAt - 1;
  }, /archiveHistory overlap/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    habit.archiveHistory[0].restoredAt = habit.archiveHistory[0].archivedAt - 1;
  }, /Invalid habits\[0\]\.archiveHistory/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    habit.archiveHistory[0].restoredAt = null;
    habit.archiveHistory[0].restoredDate = null;
    habit.isArchived = true;
    habit.archivedAt = new Date(habit.archiveHistory[0].archivedAt).toISOString();
  }, /archiveHistory open period/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    for (const period of habit.archiveHistory) {
      period.restoredAt = null;
      period.restoredDate = null;
    }
  }, /archiveHistory open period/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    habit.archiveHistory[1].restoredAt = null;
    habit.archiveHistory[1].restoredDate = null;
  }, /active state/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    habit.isArchived = true;
    habit.archivedAt = new Date(habit.archiveHistory[1].archivedAt).toISOString();
  }, /archived state/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    habit.archiveHistory[1].restoredAt = null;
    habit.archiveHistory[1].restoredDate = null;
    habit.isArchived = true;
    habit.archivedAt = new Date(habit.archiveHistory[1].archivedAt + 1).toISOString();
  }, /archived state/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    habit.archiveHistory[0].archivedDate = "2032-02-30";
  }, /Invalid habits\[0\]\.archiveHistory\[0\]/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    delete habit.archiveHistory[0].archivedDate;
  }, /Invalid habits\[0\]\.archiveHistory\[0\]/);
  assertInvalidArchiveHistory(closedJson, (habit) => {
    habit.archiveHistory[1].restoredAt = null;
  }, /archiveHistory\[1\]\.restoredDate/);
}

void withAuditDeadline(async () => {
  await auditBoundedImportRead();
  await auditArchiveTimezoneRoundTrip();
}, "Export compatibility audit")
  .then(() => {
    console.log("Export compatibility baseline audit passed.");
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
