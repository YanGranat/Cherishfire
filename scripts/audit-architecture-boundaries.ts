import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOTS = [path.join(ROOT, "app"), path.join(ROOT, "src")];
const SYSTEM_APPEARANCE_OWNER = path.join(
  ROOT,
  "src",
  "theme",
  "system-appearance.ts",
);
const SETTINGS_STORE_OWNER = path.join(
  ROOT,
  "src",
  "stores",
  "settings-store.ts",
);
const LEGACY_HABIT_RULE_MODULES = [
  "src/features/habits/utils/display-order.ts",
  "src/utils/archive-periods.ts",
  "src/utils/habit-description-setting.ts",
  "src/utils/habit-description-settings.ts",
  "src/utils/schedule-edit.ts",
  "src/utils/schedule.ts",
  "src/utils/streak-cache.ts",
  "src/utils/streak.ts",
] as const;
const CANONICAL_HABIT_RULE_MODULES = [
  "src/domain/habits/display-order.ts",
  "src/domain/habits/archive-periods.ts",
  "src/domain/habits/schedule-edit.ts",
  "src/domain/habits/schedule.ts",
  "src/domain/habits/streak.ts",
  "src/application/statistics/streak-cache.ts",
  "src/features/habits/presentation/repeat-labels.ts",
  "src/application/settings/habit-description-lines-setting.ts",
] as const;
const CANONICAL_DATA_TRANSFER_MODULES = [
  "src/application/data-transfer/data-transfer-codec.ts",
  "src/application/data-transfer/data-transfer-model.ts",
  "src/application/data-transfer/data-transfer-service.ts",
  "src/application/data-transfer/data-transfer-coordinator.ts",
  "src/application/data-transfer/data-transfer-repository-port.ts",
  "src/data/sqlite/data-transfer-repository.ts",
  "src/platform/data-transfer/select-import-file.ts",
  "src/platform/data-transfer/share-export-file.ts",
  "src/composition/data-transfer.ts",
] as const;
const LEGACY_DATA_TRANSFER_MODULES = ["src/utils/export.ts"] as const;
const CANONICAL_REMINDER_MODULES = [
  "src/application/reminders/reminder-ports.ts",
  "src/application/reminders/reminder-service.ts",
  "src/application/reminders/deferred-reminder-work-coordinator.ts",
  "src/application/reminders/reminder-replacement-gate.ts",
  "src/domain/reminders/reminder-time.ts",
  "src/domain/reminders/reminder-sync-signature.ts",
  "src/domain/reminders/reminder-schedule.ts",
  "src/data/sqlite/reminder-day-record-repository.ts",
  "src/platform/notifications/reminder-notification-adapter-core.ts",
  "src/platform/notifications/expo-reminder-notification-adapter.ts",
  "src/platform/react-native/reminder-work-scheduling.ts",
  "src/platform/time/reminder-clock.ts",
  "src/composition/reminders.ts",
] as const;
const LEGACY_REMINDER_MODULES = [
  "src/utils/reminder-notifications.ts",
  "src/utils/reminder-time.ts",
  "src/utils/reminder-sync-signature.ts",
] as const;
const CANONICAL_NOTES_MODULES = [
  "src/application/notes/note-repository.ts",
  "src/application/notes/notes-cache.ts",
  "src/application/notes/notes-session.ts",
  "src/application/notes/notes-application.ts",
  "src/data/sqlite/note-repository.ts",
  "src/composition/notes.ts",
] as const;
const LEGACY_NOTES_MODULES = [
  "src/features/notes/utils/note-list-state.ts",
] as const;
const CANONICAL_STATISTICS_MODULES = [
  "src/domain/statistics/period-progress.ts",
  "src/application/statistics/statistics-cache.ts",
] as const;
const LEGACY_STATISTICS_MODULES = [
  "src/features/statistics/utils/period-progress.ts",
  "src/features/statistics/utils/statistics-cache.ts",
] as const;

type ArchitecturalLayer =
  | "presentation"
  | "application"
  | "domain"
  | "data"
  | "database"
  | "platform"
  | "composition"
  | "shared"
  | "unknown";

interface Violation {
  file: string;
  reason: string;
}

function collectTypeScriptFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(absolutePath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
}

function projectPath(filePath: string): string {
  return path.relative(ROOT, filePath).replaceAll("\\", "/");
}

function classifyProjectPath(filePath: string): ArchitecturalLayer {
  const relative = projectPath(filePath);
  if (
    relative.startsWith("app/") ||
    relative.startsWith("src/features/") ||
    relative.startsWith("src/components/") ||
    relative.startsWith("src/hooks/") ||
    relative.startsWith("src/stores/") ||
    relative.startsWith("src/theme/")
  ) {
    return "presentation";
  }
  if (relative.startsWith("src/application/")) return "application";
  if (relative.startsWith("src/domain/")) return "domain";
  if (relative.startsWith("src/data/")) return "data";
  if (relative.startsWith("src/db/")) return "database";
  if (
    relative.startsWith("src/platform/") ||
    relative.startsWith("src/i18n/")
  ) {
    return "platform";
  }
  if (relative.startsWith("src/composition/")) return "composition";
  if (
    [
      "src/utils/ui-scheduling.ts",
      "src/utils/system-navigation-bar.ts",
      "src/utils/sound-effects.ts",
    ].includes(relative)
  ) {
    return "platform";
  }
  if (relative.startsWith("src/types/") || relative.startsWith("src/utils/")) {
    return "shared";
  }
  return "unknown";
}

function resolveProjectImport(
  importerPath: string,
  moduleName: string,
): string | null {
  if (moduleName.startsWith("@/")) {
    return path.join(ROOT, "src", moduleName.slice(2));
  }
  if (moduleName.startsWith("@app/")) {
    return path.join(ROOT, "app", moduleName.slice(5));
  }
  if (moduleName.startsWith(".")) {
    return path.resolve(path.dirname(importerPath), moduleName);
  }
  return null;
}

function resolveExistingProjectModule(modulePath: string): string | null {
  const candidates = [
    modulePath,
    `${modulePath}.ts`,
    `${modulePath}.tsx`,
    path.join(modulePath, "index.ts"),
    path.join(modulePath, "index.tsx"),
  ];
  return (
    candidates.find(
      (candidate) =>
        fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    ) ?? null
  );
}

function getModuleSpecifiers(filePath: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      const argument = node.arguments[0];
      if ((isDynamicImport || isRequire) && ts.isStringLiteral(argument)) {
        imports.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

function getStringAndTemplateLiteralTexts(
  filePath: string,
  source: string,
): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const values: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node)) {
      values.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      values.push(node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return values;
}

function containsSqlStatement(value: string): boolean {
  return (
    /\bSELECT\b[\s\S]*\bFROM\b/i.test(value) ||
    /\bINSERT\s+INTO\b/i.test(value) ||
    /\bUPDATE\s+[A-Za-z_]+\s+SET\b/i.test(value) ||
    /\bDELETE\s+FROM\b/i.test(value)
  );
}

function isUiOrPlatformPackage(moduleName: string): boolean {
  return (
    moduleName.startsWith("node:") ||
    moduleName === "react" ||
    moduleName.startsWith("react/") ||
    moduleName === "react-dom" ||
    moduleName.startsWith("react-dom/") ||
    moduleName === "react-native" ||
    moduleName.startsWith("react-native/") ||
    moduleName.startsWith("react-native-") ||
    moduleName === "react-i18next" ||
    moduleName.startsWith("react-i18next/") ||
    moduleName === "i18next" ||
    moduleName.startsWith("i18next/") ||
    moduleName === "zustand" ||
    moduleName.startsWith("zustand/") ||
    moduleName === "nativewind" ||
    moduleName.startsWith("nativewind/") ||
    moduleName === "drizzle-orm" ||
    moduleName.startsWith("drizzle-orm/") ||
    moduleName === "expo" ||
    moduleName.startsWith("expo-") ||
    moduleName.startsWith("expo/") ||
    moduleName.startsWith("@expo/") ||
    moduleName.startsWith("@react-native/") ||
    moduleName.startsWith("@react-navigation/") ||
    moduleName.startsWith("@gorhom/")
  );
}

function findTransitiveOutwardDependency(
  entryPath: string,
  ownerLayer: "domain" | "application",
  visited: Set<string>,
): string[] | null {
  if (visited.has(entryPath)) return null;
  visited.add(entryPath);

  const source = fs.readFileSync(entryPath, "utf8");
  for (const moduleName of getModuleSpecifiers(entryPath, source)) {
    if (isUiOrPlatformPackage(moduleName)) {
      return [projectPath(entryPath), moduleName];
    }

    const unresolvedTarget = resolveProjectImport(entryPath, moduleName);
    if (!unresolvedTarget) continue;
    const targetPath = resolveExistingProjectModule(unresolvedTarget);
    if (!targetPath) continue;
    const targetLayer = classifyProjectPath(targetPath);
    const directViolation = importViolation(
      ownerLayer,
      targetLayer,
      moduleName,
    );
    if (directViolation) {
      return [projectPath(entryPath), moduleName];
    }
    if (!["shared", "unknown"].includes(targetLayer)) continue;

    const nested = findTransitiveOutwardDependency(
      targetPath,
      ownerLayer,
      visited,
    );
    if (nested) return [projectPath(entryPath), moduleName, ...nested];
  }
  return null;
}

function importViolation(
  importerLayer: ArchitecturalLayer,
  targetLayer: ArchitecturalLayer,
  moduleName: string,
): string | null {
  if (
    importerLayer === "presentation" &&
    ["data", "database"].includes(targetLayer)
  ) {
    return `presentation bypasses application/composition via concrete ${targetLayer} module '${moduleName}'`;
  }

  if (importerLayer === "domain") {
    if (isUiOrPlatformPackage(moduleName)) {
      return `domain imports UI/platform package '${moduleName}'`;
    }
    if (
      [
        "presentation",
        "application",
        "data",
        "database",
        "platform",
        "composition",
      ].includes(targetLayer)
    ) {
      return `domain depends outward on ${targetLayer} module '${moduleName}'`;
    }
  }

  if (importerLayer === "application") {
    if (isUiOrPlatformPackage(moduleName)) {
      return `application imports UI/platform package '${moduleName}'`;
    }
    if (
      ["presentation", "data", "database", "platform", "composition"].includes(
        targetLayer,
      )
    ) {
      return `application depends on concrete ${targetLayer} module '${moduleName}'`;
    }
  }

  if (importerLayer === "data") {
    if (
      moduleName === "react" ||
      moduleName.startsWith("react/") ||
      moduleName === "react-native" ||
      moduleName.startsWith("react-native/") ||
      moduleName.startsWith("react-native-") ||
      moduleName === "zustand" ||
      moduleName.startsWith("zustand/") ||
      moduleName.startsWith("@react-navigation/") ||
      moduleName.startsWith("@gorhom/")
    ) {
      return `data imports presentation package '${moduleName}'`;
    }
    if (targetLayer === "presentation") {
      return `data depends on presentation module '${moduleName}'`;
    }
  }

  return null;
}

function auditLayerImports(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    const importerLayer = classifyProjectPath(filePath);
    if (
      !["presentation", "domain", "application", "data"].includes(importerLayer)
    ) {
      continue;
    }

    for (const moduleName of getModuleSpecifiers(filePath, source)) {
      const targetPath = resolveProjectImport(filePath, moduleName);
      const targetLayer = targetPath
        ? classifyProjectPath(targetPath)
        : "unknown";
      const reason = importViolation(importerLayer, targetLayer, moduleName);
      if (reason) {
        violations.push({ file: projectPath(filePath), reason });
        continue;
      }

      if (
        (importerLayer === "domain" || importerLayer === "application") &&
        targetPath &&
        ["shared", "unknown"].includes(targetLayer)
      ) {
        const resolvedTarget = resolveExistingProjectModule(targetPath);
        const outwardPath = resolvedTarget
          ? findTransitiveOutwardDependency(
              resolvedTarget,
              importerLayer,
              new Set<string>(),
            )
          : null;
        if (outwardPath) {
          violations.push({
            file: projectPath(filePath),
            reason: `${importerLayer} reaches UI/platform transitively through '${moduleName}': ${outwardPath.join(" -> ")}`,
          });
        }
      }
    }
  }
  return violations;
}

function auditHabitRuleOwnership(): Violation[] {
  const violations: Violation[] = [];
  for (const relative of CANONICAL_HABIT_RULE_MODULES) {
    if (!fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "canonical habit/application rule owner is missing",
      });
    }
  }
  for (const relative of LEGACY_HABIT_RULE_MODULES) {
    if (fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason:
          "legacy shared utility duplicates the canonical habit/application rule owner",
      });
    }
  }
  const schedulePath = path.join(
    ROOT,
    "src",
    "domain",
    "habits",
    "schedule.ts",
  );
  if (fs.existsSync(schedulePath)) {
    const source = fs.readFileSync(schedulePath, "utf8");
    if (
      /\b(?:TFunction|getRepeatLabel|getEveryNDaysLabel|WEEKDAY_SHORT_KEYS)\b|weekdaysShort\.|repeat\.everyNDays/.test(
        source,
      )
    ) {
      violations.push({
        file: projectPath(schedulePath),
        reason: "domain schedule owns localized presentation labels",
      });
    }
  }
  return violations;
}

function auditStatisticsRuleOwnership(): Violation[] {
  const violations: Violation[] = [];
  for (const relative of CANONICAL_STATISTICS_MODULES) {
    if (!fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "canonical statistics rule/cache owner is missing",
      });
    }
  }
  for (const relative of LEGACY_STATISTICS_MODULES) {
    if (fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "legacy statistics utility duplicates the canonical owner",
      });
    }
  }
  return violations;
}

function auditDataTransferOwnership(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const relative of CANONICAL_DATA_TRANSFER_MODULES) {
    if (!fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "canonical data-transfer boundary is missing",
      });
    }
  }
  for (const relative of LEGACY_DATA_TRANSFER_MODULES) {
    if (fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "legacy shared utility duplicates the data-transfer owner",
      });
    }
  }

  const sharedUtilsRoot = path.join(ROOT, "src", "utils");
  for (const filePath of collectTypeScriptFiles(sharedUtilsRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    if (
      /\b(?:EXPORT_SCHEMA_VERSION|MIN_SUPPORTED_EXPORT_SCHEMA_VERSION|buildExportJsonFromRows|normalizeImportData|importNormalizedData|exportAllData)\b/.test(
        source,
      )
    ) {
      violations.push({
        file: projectPath(filePath),
        reason:
          "shared utility must not own the data-transfer codec or use case",
      });
    }
  }

  const serviceModule = "@/application/data-transfer/data-transfer-service";
  const codecModule = "@/application/data-transfer/data-transfer-codec";
  const compositionModule = "@/composition/data-transfer";
  const importFileAdapterModule = "@/platform/data-transfer/select-import-file";
  const shareFileAdapterModule = "@/platform/data-transfer/share-export-file";
  const nativeImportPackages = new Set([
    "expo-document-picker",
    "expo-file-system/legacy",
  ]);
  for (const filePath of files) {
    const imports = getModuleSpecifiers(
      filePath,
      fs.readFileSync(filePath, "utf8"),
    );
    if (
      imports.includes(serviceModule) &&
      projectPath(filePath) !== "src/composition/data-transfer.ts"
    ) {
      violations.push({
        file: projectPath(filePath),
        reason:
          "data-transfer runtime service must be wired only by composition",
      });
    }
    if (classifyProjectPath(filePath) === "presentation") {
      for (const moduleName of imports) {
        if (!nativeImportPackages.has(moduleName)) continue;
        violations.push({
          file: projectPath(filePath),
          reason: `presentation bypasses the data-transfer platform adapter via '${moduleName}'`,
        });
      }
    }
  }

  const compositionPath = path.join(
    ROOT,
    "src",
    "composition",
    "data-transfer.ts",
  );
  const compositionImports = getModuleSpecifiers(
    compositionPath,
    fs.readFileSync(compositionPath, "utf8"),
  );
  if (!compositionImports.includes(importFileAdapterModule)) {
    violations.push({
      file: projectPath(compositionPath),
      reason: "composition must expose the native import-file adapter",
    });
  }
  if (!compositionImports.includes(shareFileAdapterModule)) {
    violations.push({
      file: projectPath(compositionPath),
      reason: "composition must own the native export-file/share adapter",
    });
  }

  const dataTransferPresentationPath = path.join(
    ROOT,
    "src",
    "features",
    "habits",
    "components",
    "HomeDataTransferOverlayController.tsx",
  );
  const dataTransferPresentationImports = getModuleSpecifiers(
    dataTransferPresentationPath,
    fs.readFileSync(dataTransferPresentationPath, "utf8"),
  );
  if (!dataTransferPresentationImports.includes(codecModule)) {
    violations.push({
      file: projectPath(dataTransferPresentationPath),
      reason:
        "presentation must import pure data-transfer parsing from application",
    });
  }
  if (!dataTransferPresentationImports.includes(compositionModule)) {
    violations.push({
      file: projectPath(dataTransferPresentationPath),
      reason: "presentation must invoke export/import through composition",
    });
  }
  return violations;
}

function auditReminderOwnership(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const relative of CANONICAL_REMINDER_MODULES) {
    if (!fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "canonical reminder boundary is missing",
      });
    }
  }
  for (const relative of LEGACY_REMINDER_MODULES) {
    if (fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "legacy shared reminder owner still exists",
      });
    }
  }

  const reminderServiceModule = "@/application/reminders/reminder-service";
  const reminderRepositoryModule =
    "@/data/sqlite/reminder-day-record-repository";
  const expoAdapterModule =
    "@/platform/notifications/expo-reminder-notification-adapter";
  const compositionModule = "@/composition/reminders";
  const compositionPath = path.join(ROOT, "src", "composition", "reminders.ts");
  const compositionSource = fs.readFileSync(compositionPath, "utf8");
  const compositionImports = getModuleSpecifiers(
    compositionPath,
    compositionSource,
  );
  const forbiddenCompositionImports = compositionImports.filter(
    (moduleName) =>
      moduleName.startsWith("@/domain/") ||
      moduleName.startsWith("@/db/") ||
      moduleName.startsWith("@/features/") ||
      moduleName.startsWith("@/stores/") ||
      moduleName.startsWith("@/utils/") ||
      moduleName === "@/i18n/config" ||
      isUiOrPlatformPackage(moduleName),
  );
  for (const moduleName of forbiddenCompositionImports) {
    violations.push({
      file: projectPath(compositionPath),
      reason: `reminder composition contains non-wiring dependency '${moduleName}'`,
    });
  }
  if (
    (compositionSource.match(/createReminderService\(/g) ?? []).length !== 1
  ) {
    violations.push({
      file: projectPath(compositionPath),
      reason:
        "reminder composition must wire exactly one application singleton",
    });
  }
  if (/\b(?:if|for|while|switch|try|catch)\s*[({]/.test(compositionSource)) {
    violations.push({
      file: projectPath(compositionPath),
      reason: "reminder composition contains orchestration instead of wiring",
    });
  }

  const notificationRoot = path.join(ROOT, "src", "platform", "notifications");
  for (const filePath of collectTypeScriptFiles(notificationRoot)) {
    const imports = getModuleSpecifiers(
      filePath,
      fs.readFileSync(filePath, "utf8"),
    );
    for (const moduleName of imports) {
      if (
        moduleName.startsWith("@/data/") ||
        moduleName.startsWith("@/composition/") ||
        moduleName.startsWith("@/stores/")
      ) {
        violations.push({
          file: projectPath(filePath),
          reason: `notification platform adapter depends inward on '${moduleName}'`,
        });
      }
    }
  }

  const sharedUtilsRoot = path.join(ROOT, "src", "utils");
  for (const filePath of collectTypeScriptFiles(sharedUtilsRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    if (
      /\b(?:scheduleHabitRemindersSync|buildUpcomingReminderDates|REMINDER_NOTIFICATION_KIND|REMINDER_LOOKAHEAD_DAYS)\b/.test(
        source,
      )
    ) {
      violations.push({
        file: projectPath(filePath),
        reason: "shared utility owns reminder orchestration or scheduling",
      });
    }
  }

  const concreteRuntimeModules = new Set([
    reminderServiceModule,
    reminderRepositoryModule,
    expoAdapterModule,
    "@/platform/react-native/reminder-work-scheduling",
    "@/platform/time/reminder-clock",
    "@/platform/diagnostics/reminder-diagnostics",
  ]);
  for (const filePath of files) {
    const imports = getModuleSpecifiers(
      filePath,
      fs.readFileSync(filePath, "utf8"),
    );
    for (const moduleName of imports) {
      if (
        concreteRuntimeModules.has(moduleName) &&
        projectPath(filePath) !== "src/composition/reminders.ts"
      ) {
        violations.push({
          file: projectPath(filePath),
          reason: `concrete reminder runtime '${moduleName}' must be wired only by composition`,
        });
      }
      if (
        LEGACY_REMINDER_MODULES.some((relative) => {
          const legacyModule = `@/${relative.slice("src/".length, -".ts".length)}`;
          return moduleName === legacyModule;
        })
      ) {
        violations.push({
          file: projectPath(filePath),
          reason: `imports removed legacy reminder owner '${moduleName}'`,
        });
      }
    }
  }

  for (const relative of [
    "app/_layout.tsx",
    "src/stores/habit-store.ts",
    "src/composition/settings.ts",
    "src/composition/data-transfer.ts",
  ]) {
    const filePath = path.join(ROOT, relative);
    const imports = getModuleSpecifiers(
      filePath,
      fs.readFileSync(filePath, "utf8"),
    );
    if (!imports.includes(compositionModule)) {
      violations.push({
        file: relative,
        reason: "reminder consumer bypasses the narrow composition facade",
      });
    }
  }

  return violations;
}

function auditNotesOwnership(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const relative of CANONICAL_NOTES_MODULES) {
    if (!fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "canonical Notes boundary is missing",
      });
    }
  }
  for (const relative of LEGACY_NOTES_MODULES) {
    if (fs.existsSync(path.join(ROOT, relative))) {
      violations.push({
        file: relative,
        reason: "legacy presentation helper duplicates NotesSession ownership",
      });
    }
  }

  const applicationModule = "@/application/notes/notes-application";
  const concreteRepositoryModule = "@/data/sqlite/note-repository";
  const compositionModule = "@/composition/notes";
  for (const filePath of files) {
    const relative = projectPath(filePath);
    const source = fs.readFileSync(filePath, "utf8");
    const imports = getModuleSpecifiers(filePath, source);
    if (
      classifyProjectPath(filePath) === "presentation" &&
      imports.some((moduleName) =>
        moduleName.startsWith("@/application/notes/"),
      )
    ) {
      violations.push({
        file: relative,
        reason: "Notes presentation must consume only the composition facade",
      });
    }
    if (
      imports.includes(applicationModule) &&
      relative !== "src/composition/notes.ts"
    ) {
      violations.push({
        file: relative,
        reason:
          "Notes application factory must be instantiated only by composition",
      });
    }
    if (
      imports.includes(concreteRepositoryModule) &&
      relative !== "src/composition/notes.ts"
    ) {
      violations.push({
        file: relative,
        reason: "concrete note repository must be wired only by composition",
      });
    }
    if (
      classifyProjectPath(filePath) === "presentation" &&
      /\bnotesApplication\s*\./.test(source) &&
      !imports.includes(compositionModule)
    ) {
      violations.push({
        file: relative,
        reason: "Notes presentation consumer bypasses the composition facade",
      });
    }
  }

  const screenPath = path.join(ROOT, "app", "habit", "[id]", "notes.tsx");
  const screenSource = fs.readFileSync(screenPath, "utf8");
  const screenImports = getModuleSpecifiers(screenPath, screenSource);
  for (const moduleName of screenImports) {
    if (
      moduleName.startsWith("@/application/notes/") ||
      moduleName.startsWith("@/data/sqlite/")
    ) {
      violations.push({
        file: projectPath(screenPath),
        reason: `Notes route bypasses its composition facade via '${moduleName}'`,
      });
    }
  }
  for (const duplicateOwner of [
    "setNoteList",
    "nextOptimisticNoteIdRef",
    "confirmedNoteStatesRef",
    "noteWriteTokensRef",
    "notePersistenceIdsRef",
    "pendingMutationRollbackRef",
    "persistenceCommitScheduler",
  ]) {
    if (screenSource.includes(duplicateOwner)) {
      violations.push({
        file: projectPath(screenPath),
        reason: `presentation retains duplicate NotesSession ownership '${duplicateOwner}'`,
      });
    }
  }
  if (
    !/useSyncExternalStore\([\s\S]{0,180}notesSession\.subscribe/.test(
      screenSource,
    ) ||
    !screenSource.includes("notesApplication.getSession(habitId)")
  ) {
    violations.push({
      file: projectPath(screenPath),
      reason:
        "Notes route must consume the application-owned per-habit session",
    });
  }

  return violations;
}

function auditPresentationPersistence(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of files) {
    if (classifyProjectPath(filePath) !== "presentation") continue;
    const source = fs.readFileSync(filePath, "utf8");
    if (/from\s+["']@\/db\/runtime["']|\bruntimeDb\b/.test(source)) {
      violations.push({
        file: projectPath(filePath),
        reason:
          "presentation bypasses an application/repository boundary via runtimeDb",
      });
    }
    const ownsSql = getStringAndTemplateLiteralTexts(filePath, source).some(
      containsSqlStatement,
    );
    if (ownsSql) {
      violations.push({
        file: projectPath(filePath),
        reason: "presentation owns raw SQL",
      });
    }
  }
  return violations;
}

function auditPersistenceAdapterOwnership(
  files: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of files) {
    const layer = classifyProjectPath(filePath);
    if (
      !["presentation", "shared", "application", "domain", "platform"].includes(
        layer,
      )
    ) {
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    if (/from\s+["']@\/db\/runtime["']|\bruntimeDb\b/.test(source)) {
      violations.push({
        file: projectPath(filePath),
        reason: `${layer} bypasses a repository adapter via runtimeDb`,
      });
    }
    if (
      getStringAndTemplateLiteralTexts(filePath, source).some(
        containsSqlStatement,
      )
    ) {
      violations.push({
        file: projectPath(filePath),
        reason: `${layer} owns raw SQL outside a data/database adapter`,
      });
    }
  }
  return violations;
}

function auditSystemAppearanceOwnership(files: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of files) {
    if (filePath === SYSTEM_APPEARANCE_OWNER) continue;
    const source = fs.readFileSync(filePath, "utf8");
    if (/\bAppearance\.|\buseColorScheme\b/.test(source)) {
      violations.push({
        file: projectPath(filePath),
        reason:
          "observes native system appearance outside the process-wide owner",
      });
    }
  }

  const ownerSource = fs.readFileSync(SYSTEM_APPEARANCE_OWNER, "utf8");
  const nativeSubscriptions =
    ownerSource.match(/=\s*Appearance\.addChangeListener\(/g)?.length ?? 0;
  if (nativeSubscriptions !== 1) {
    violations.push({
      file: projectPath(SYSTEM_APPEARANCE_OWNER),
      reason: `must contain exactly one native Appearance subscription, found ${nativeSubscriptions}`,
    });
  }
  return violations;
}

function auditSettingsCompositionOwnership(): Violation[] {
  const source = fs.readFileSync(SETTINGS_STORE_OWNER, "utf8");
  const imports = getModuleSpecifiers(SETTINGS_STORE_OWNER, source);
  const forbidden = imports.filter(
    (moduleName) =>
      moduleName.startsWith("@/data/") ||
      moduleName.startsWith("@/db/") ||
      moduleName === "@/i18n/config" ||
      moduleName === "@/utils/reminder-notifications" ||
      moduleName === "@/utils/ui-scheduling",
  );
  const violations = forbidden.map((moduleName) => ({
    file: projectPath(SETTINGS_STORE_OWNER),
    reason: `settings store bypasses its composition facade via '${moduleName}'`,
  }));
  if (!imports.includes("@/composition/settings")) {
    violations.push({
      file: projectPath(SETTINGS_STORE_OWNER),
      reason:
        "settings store must receive persistence and platform adapters from @/composition/settings",
    });
  }
  return violations;
}

function auditRuleSelfChecks(): void {
  assert.equal(containsSqlStatement("select-theme"), false);
  assert.equal(containsSqlStatement("A SELECT that started before"), false);
  assert.equal(containsSqlStatement("SELECT id FROM habits"), true);
  assert.equal(
    classifyProjectPath(path.join(ROOT, "src", "utils", "ui-scheduling.ts")),
    "platform",
  );
  assert.equal(
    classifyProjectPath(
      path.join(ROOT, "src", "utils", "system-navigation-bar.ts"),
    ),
    "platform",
  );
  assert.match(
    importViolation("domain", "unknown", "react-native") ?? "",
    /domain imports UI\/platform/,
  );
  assert.match(
    importViolation("domain", "data", "@/data/sqlite/habit-repository") ?? "",
    /depends outward/,
  );
  assert.match(
    importViolation("application", "presentation", "@/features/habits/view") ??
      "",
    /concrete presentation/,
  );
  assert.match(
    importViolation("presentation", "data", "@/data/sqlite/note-repository") ??
      "",
    /presentation bypasses application\/composition/,
  );
  assert.equal(importViolation("domain", "unknown", "date-fns/format"), null);
  assert.match(
    importViolation("domain", "unknown", "@expo/vector-icons") ?? "",
    /domain imports UI\/platform/,
  );
  assert.match(
    importViolation("domain", "unknown", "react-native-reanimated") ?? "",
    /domain imports UI\/platform/,
  );
  assert.match(
    importViolation("application", "unknown", "react-i18next") ?? "",
    /application imports UI\/platform/,
  );
  assert.equal(
    classifyProjectPath(
      path.join(ROOT, "src", "domain", "habits", "schedule.ts"),
    ),
    "domain",
  );
  assert.equal(
    classifyProjectPath(
      path.join(
        ROOT,
        "src",
        "features",
        "habits",
        "presentation",
        "repeat-labels.ts",
      ),
    ),
    "presentation",
  );
  assert.equal(
    classifyProjectPath(
      path.join(ROOT, "src", "utils", "habit-description-settings.ts"),
    ),
    "shared",
  );
  assert.equal(
    classifyProjectPath(path.join(ROOT, "src", "composition", "reminders.ts")),
    "composition",
  );
  assert.ok(
    findTransitiveOutwardDependency(
      path.join(
        ROOT,
        "src",
        "platform",
        "notifications",
        "expo-reminder-notification-adapter.ts",
      ),
      "application",
      new Set<string>(),
    ),
    "transitive audit must recognize a concrete notification adapter",
  );
  assert.equal(
    findTransitiveOutwardDependency(
      path.join(ROOT, "src", "application", "reminders", "reminder-service.ts"),
      "application",
      new Set<string>(),
    ),
    null,
    "application reminder orchestration must reach the environment only through ports",
  );
  assert.equal(
    findTransitiveOutwardDependency(
      path.join(ROOT, "src", "application", "statistics", "streak-cache.ts"),
      "application",
      new Set<string>(),
    ),
    null,
    "transitive audit must keep a pure shared calculation usable from application",
  );
  assert.equal(
    importViolation("data", "application", "@/application/ports"),
    null,
  );
  assert.match(
    importViolation("application", "composition", "@/composition/reminders") ??
      "",
    /depends on concrete composition/,
  );
}

function main(): void {
  auditRuleSelfChecks();
  const files = SOURCE_ROOTS.flatMap(collectTypeScriptFiles);
  const violations = [
    ...auditLayerImports(files),
    ...auditPresentationPersistence(files),
    ...auditPersistenceAdapterOwnership(files),
    ...auditSystemAppearanceOwnership(files),
    ...auditSettingsCompositionOwnership(),
    ...auditHabitRuleOwnership(),
    ...auditStatisticsRuleOwnership(),
    ...auditDataTransferOwnership(files),
    ...auditReminderOwnership(files),
    ...auditNotesOwnership(files),
  ];

  assert.deepEqual(
    violations,
    [],
    violations.map(({ file, reason }) => `${file}: ${reason}`).join("\n"),
  );
  console.log("Architecture boundary audit passed.");
}

main();
