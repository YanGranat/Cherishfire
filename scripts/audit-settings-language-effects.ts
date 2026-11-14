import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
type SettingsPhase = "apply" | "rollback" | "reconcile";
interface CapturedSettingsDependencies {
  changeLanguage(language: string, phase: SettingsPhase): Promise<void>;
}
interface SettingsAuditController {
  capturedDependencies: CapturedSettingsDependencies | null;
  changeLanguage: (language: string) => unknown;
  scheduleReminder: () => void;
  events: string[];
}
interface CommonJsModuleInstance extends NodeModule {
  _compile(source: string, fileName: string): void;
}
interface CommonJsModuleConstructor {
  new (id?: string, parent?: NodeModule): CommonJsModuleInstance;
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
  _nodeModulePaths(from: string): string[];
}
function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
function loadSettingsCompositionForAudit(): SettingsAuditController {
  const projectRoot = resolve(import.meta.dirname, "..");
  const fileName = resolve(projectRoot, "src/composition/settings.ts");
  const source = readFileSync(fileName, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new Error(
      `Settings composition transpilation failed: ${errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  const controller: SettingsAuditController = {
    capturedDependencies: null,
    changeLanguage: () => Promise.resolve(),
    scheduleReminder: () => undefined,
    events: [],
  };
  class AuditSettingsMutationCoordinator {
    constructor(dependencies: CapturedSettingsDependencies) {
      controller.capturedDependencies = dependencies;
    }
  }
  const mocks = new Map<string, unknown>([
    [
      "@/application/settings/settings-mutation-coordinator",
      {
        SettingsMutationCoordinator: AuditSettingsMutationCoordinator,
        createSettingsMutationSnapshot: () => ({}),
      },
    ],
    [
      "@/application/settings/habit-description-lines-setting",
      {
        clampDescriptionVisibleLines: (value: number) => value,
        getHabitDescriptionLinesScope: (habitId: number) => `habit-${habitId}`,
      },
    ],
    [
      "@/data/sqlite/settings-repository",
      {
        settingsRepository: {
          write: async () => undefined,
          delete: async () => undefined,
          readAll: async () => [],
        },
      },
    ],
    [
      "@/composition/persistence",
      {
        persistenceCommitScheduler: {
          waitForCommitOpportunity: async () => undefined,
        },
      },
    ],
    [
      "@/i18n/config",
      {
        __esModule: true,
        default: {
          language: "en",
          resolvedLanguage: "en",
          changeLanguage: (language: string) => {
            controller.events.push(`change:${language}`);
            return controller.changeLanguage(language);
          },
        },
      },
    ],
    ["@/types/settings", { DEFAULT_SETTINGS: {} }],
    [
      "@/composition/reminders",
      {
        scheduleReminderNotificationLocalizationRefresh: () => {
          controller.events.push("reminder");
          controller.scheduleReminder();
        },
        setReminderNotificationsEnabled: async () => undefined,
      },
    ],
    ["@/utils/ui-scheduling", { runAfterUiSettles: () => undefined }],
  ]);
  const ModuleInternals = Module as unknown as CommonJsModuleConstructor;
  const originalLoad = ModuleInternals._load;
  const compiledModule = new ModuleInternals(fileName);
  compiledModule.filename = fileName;
  compiledModule.paths = ModuleInternals._nodeModulePaths(dirname(fileName));
  ModuleInternals._load = (request, parent, isMain) => {
    if (mocks.has(request)) return mocks.get(request);
    return originalLoad(request, parent, isMain);
  };
  try {
    compiledModule._compile(transpiled.outputText, fileName);
  } finally {
    ModuleInternals._load = originalLoad;
  }
  assert.ok(
    controller.capturedDependencies,
    "the settings composition must construct its mutation coordinator",
  );
  return controller;
}
function resetScenario(controller: SettingsAuditController): void {
  controller.events.length = 0;
  controller.changeLanguage = () => Promise.resolve();
  controller.scheduleReminder = () => undefined;
}
async function auditPendingLanguageChange(
  controller: SettingsAuditController,
  dependencies: CapturedSettingsDependencies,
): Promise<void> {
  resetScenario(controller);
  const pending = deferred<void>();
  controller.changeLanguage = () => pending.promise;
  let settled = false;
  const completion = dependencies.changeLanguage("de", "apply");
  void completion.then(() => {
    settled = true;
    controller.events.push("settled");
  });
  assert.ok(!controller.events.includes("reminder"));
  pending.resolve();
  await Promise.resolve();
  assert.deepEqual(
    controller.events,
    ["change:de", "reminder"],
    "reminder registration must share the first language continuation",
  );
  assert.equal(
    settled,
    false,
    "the owner must finish before its caller settles",
  );
  await completion;
  await Promise.resolve();
  assert.equal(settled, true);
}
async function auditRejectedLanguageChange(
  controller: SettingsAuditController,
  dependencies: CapturedSettingsDependencies,
): Promise<void> {
  resetScenario(controller);
  const failure = new Error("Synthetic language rejection");
  controller.changeLanguage = () => Promise.reject(failure);
  const completion = dependencies.changeLanguage("fr", "rollback");
  await assert.rejects(completion, (error: unknown) => error === failure);
  assert.ok(!controller.events.includes("reminder"));
}
function auditSynchronousLanguageThrow(
  controller: SettingsAuditController,
  dependencies: CapturedSettingsDependencies,
): void {
  resetScenario(controller);
  const failure = new Error("Synthetic synchronous language failure");
  controller.changeLanguage = () => {
    throw failure;
  };
  assert.throws(
    () => dependencies.changeLanguage("es", "apply"),
    (error: unknown) => error === failure,
  );
  assert.ok(!controller.events.includes("reminder"));
}
async function auditReminderRegistrationThrow(
  controller: SettingsAuditController,
  dependencies: CapturedSettingsDependencies,
): Promise<void> {
  resetScenario(controller);
  const failure = new Error("Synthetic reminder registration failure");
  controller.changeLanguage = () => Promise.resolve();
  controller.scheduleReminder = () => {
    throw failure;
  };
  const completion = dependencies.changeLanguage("it", "reconcile");
  await assert.rejects(completion, (error: unknown) => error === failure);
  assert.equal(
    controller.events.filter((event) => event === "reminder").length,
    1,
  );
}
export async function auditSettingsLanguageEffects(): Promise<void> {
  const controller = loadSettingsCompositionForAudit();
  const dependencies = controller.capturedDependencies;
  assert.ok(dependencies);
  await auditPendingLanguageChange(controller, dependencies);
  await auditRejectedLanguageChange(controller, dependencies);
  auditSynchronousLanguageThrow(controller, dependencies);
  await auditReminderRegistrationThrow(controller, dependencies);
}

void auditSettingsLanguageEffects()
  .then(() => console.log("Settings language effects audit passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
