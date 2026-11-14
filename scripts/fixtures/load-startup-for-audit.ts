import { readFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

export interface StartupAuditSourceOptions {
  transform?: (source: string) => string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

interface AuditElement {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

interface AuditElementPathSegment {
  readonly type: unknown;
  readonly key: unknown;
  readonly position: number;
}

interface MutableRef<T> {
  current: T;
}

interface StateSlot {
  readonly kind: "state";
  value: unknown;
  readonly setValue: (value: unknown) => void;
}

interface RefSlot {
  readonly kind: "ref";
  readonly value: MutableRef<unknown>;
}

interface EffectSlot {
  readonly kind: "effect";
  readonly phase: "layout" | "passive";
  create: () => void | (() => void);
  dependencies: readonly unknown[] | undefined;
  cleanup?: () => void;
  pending: boolean;
}

type HookSlot = StateSlot | RefSlot | EffectSlot;

export interface StartupAuditSnapshot {
  readonly appContentIdentity: number | null;
  readonly appContentMountCount: number;
  readonly appContentUnmountCount: number;
  readonly startupVisible: boolean;
  readonly startupError: boolean;
  readonly startupErrorMessage: string | null;
}

export interface StartupAuditHarness {
  readonly lateStateWriteCount: number;
  readonly settingsLoadCallCount: number;
  readonly warmupCallCount: number;
  snapshot(): StartupAuditSnapshot;
  setMigration(state: { success: boolean; error: unknown }): void;
  setSettingsLoading(loading: boolean): void;
  queueSettingsLoad(): void;
  completeNextSettingsLoad(result: boolean): Promise<void>;
  rejectNextSettingsLoad(error: unknown): Promise<void>;
  invokeStartupRetry(): void;
  settle(): Promise<void>;
  unmount(): void;
}

interface MigratedAppProps {
  onRetry: () => void;
}

interface StartupAuditRuntime {
  readonly React: AuditReactRuntime;
  readonly GestureHandlerRootView: string;
  readonly SafeAreaProvider: string;
  readonly StartupState: string;
  readonly AppContent: () => null;
  readonly i18n: { t(key: string): string };
  readonly console: { error(...values: unknown[]): void };
  useAppDatabaseMigrations(): { success: boolean; error: unknown };
  useSettingsStore<T>(
    selector: (state: {
      isLoading: boolean;
      loadSettings(): Promise<boolean>;
    }) => T,
  ): T;
  runWhenUiIsIdle(callback: () => void): void;
  warmupHabitReminders(): Promise<void>;
}

interface StartupAuditRuntimeController extends StartupAuditRuntime {
  migration: { success: boolean; error: unknown };
  settingsLoading: boolean;
  settingsLoads: Deferred<boolean>[];
  settingsLoadInFlight: Deferred<boolean> | null;
  loadSettings(): Promise<boolean>;
  settingsLoadCalls: number;
  warmups: number;
}

interface CommonJsModuleInstance extends NodeModule {
  _compile(source: string, fileName: string): void;
}

interface CommonJsModuleConstructor {
  new (id?: string, parent?: NodeModule): CommonJsModuleInstance;
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
  _nodeModulePaths(from: string): string[];
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromiseInner, rejectPromiseInner) => {
    resolvePromise = resolvePromiseInner;
    rejectPromise = rejectPromiseInner;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function dependenciesEqual(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[] | undefined,
): boolean {
  if (previous === undefined || current === undefined) return false;
  return (
    previous.length === current.length &&
    previous.every((value, index) => Object.is(value, current[index]))
  );
}

function normalizeChildren(children: readonly unknown[]): unknown {
  if (children.length === 0) return undefined;
  return children.length === 1 ? children[0] : [...children];
}

function isAuditElement(value: unknown): value is AuditElement {
  return (
    value != null &&
    typeof value === "object" &&
    "type" in value &&
    "props" in value
  );
}

function findElementByType(value: unknown, type: unknown): AuditElement | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findElementByType(child, type);
      if (match) return match;
    }
    return null;
  }
  if (!isAuditElement(value)) return null;
  if (value.type === type) return value;
  return findElementByType(value.props.children, type);
}

function findElementPathByType(
  value: unknown,
  type: unknown,
  ancestors: readonly AuditElementPathSegment[] = [],
  position = 0,
): readonly AuditElementPathSegment[] | null {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const match = findElementPathByType(child, type, ancestors, index);
      if (match) return match;
    }
    return null;
  }
  if (!isAuditElement(value)) return null;
  const path = [
    ...ancestors,
    { type: value.type, key: value.props.key ?? null, position },
  ];
  if (value.type === type) return path;
  return findElementPathByType(value.props.children, type, path);
}

function pathsEqual(
  previous: readonly AuditElementPathSegment[] | null,
  current: readonly AuditElementPathSegment[] | null,
): boolean {
  return (
    previous != null &&
    current != null &&
    previous.length === current.length &&
    previous.every(
      (segment, index) =>
        Object.is(segment.type, current[index].type) &&
        Object.is(segment.key, current[index].key) &&
        segment.position === current[index].position,
    )
  );
}

class AuditReactRuntime {
  readonly Fragment = Symbol("AuditFragment");
  lateStateWriteCount = 0;

  private readonly slots: HookSlot[] = [];
  private hookIndex = 0;
  private dirty = false;
  private mounted = false;
  private renderFunction: (() => AuditElement) | null = null;
  private tree: AuditElement | null = null;
  private appContentType: unknown = null;
  private startupStateType: unknown = null;
  private appContentPath: readonly AuditElementPathSegment[] | null = null;
  private currentAppContentIdentity: number | null = null;
  private nextAppContentIdentity = 1;
  private appContentMounts = 0;
  private appContentUnmounts = 0;

  readonly createElement = (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): AuditElement => ({
    type,
    props: {
      ...(props ?? {}),
      ...(children.length > 0
        ? { children: normalizeChildren(children) }
        : null),
    },
  });

  readonly useState = <T>(initialValue: T | (() => T)) => {
    const index = this.hookIndex;
    this.hookIndex += 1;
    const existing = this.slots[index];
    if (existing) {
      if (existing.kind !== "state") {
        throw new Error("Startup audit hook order changed at useState");
      }
      return [existing.value as T, existing.setValue] as const;
    }

    const slot: StateSlot = {
      kind: "state",
      value:
        typeof initialValue === "function"
          ? (initialValue as () => T)()
          : initialValue,
      setValue: (nextValue) => {
        if (!this.mounted) {
          this.lateStateWriteCount += 1;
          return;
        }
        const resolved =
          typeof nextValue === "function"
            ? (nextValue as (current: unknown) => unknown)(slot.value)
            : nextValue;
        if (Object.is(slot.value, resolved)) return;
        slot.value = resolved;
        this.dirty = true;
      },
    };
    this.slots[index] = slot;
    return [slot.value as T, slot.setValue] as const;
  };

  readonly useRef = <T>(initialValue: T): MutableRef<T> => {
    const index = this.hookIndex;
    this.hookIndex += 1;
    const existing = this.slots[index];
    if (existing) {
      if (existing.kind !== "ref") {
        throw new Error("Startup audit hook order changed at useRef");
      }
      return existing.value as MutableRef<T>;
    }
    const slot: RefSlot = { kind: "ref", value: { current: initialValue } };
    this.slots[index] = slot;
    return slot.value as MutableRef<T>;
  };

  readonly useEffect = (
    create: () => void | (() => void),
    dependencies?: readonly unknown[],
  ): void => {
    this.registerEffect("passive", create, dependencies);
  };

  readonly useLayoutEffect = (
    create: () => void | (() => void),
    dependencies?: readonly unknown[],
  ): void => {
    this.registerEffect("layout", create, dependencies);
  };

  configureTypes(appContentType: unknown, startupStateType: unknown): void {
    this.appContentType = appContentType;
    this.startupStateType = startupStateType;
  }

  mount(renderFunction: () => AuditElement): void {
    if (this.mounted)
      throw new Error("Startup audit renderer is already mounted");
    this.renderFunction = renderFunction;
    this.mounted = true;
    this.dirty = true;
    this.flush();
  }

  requestRender(): void {
    if (!this.mounted) return;
    this.dirty = true;
  }

  flush(): void {
    let iterations = 0;
    while (this.dirty) {
      if (!this.mounted || !this.renderFunction) {
        throw new Error("Startup audit renderer is not mounted");
      }
      this.dirty = false;
      this.hookIndex = 0;
      this.tree = this.renderFunction();
      this.reconcileAppContentIdentity();
      this.flushEffects("layout");
      this.flushEffects("passive");
      iterations += 1;
      if (iterations > 30) {
        throw new Error("Startup audit renderer did not settle");
      }
    }
  }

  snapshot(): StartupAuditSnapshot {
    const startup = findElementByType(this.tree, this.startupStateType);
    return {
      appContentIdentity: this.currentAppContentIdentity,
      appContentMountCount: this.appContentMounts,
      appContentUnmountCount: this.appContentUnmounts,
      startupVisible: startup != null,
      startupError: startup?.props.error === true,
      startupErrorMessage:
        typeof startup?.props.errorMessage === "string"
          ? startup.props.errorMessage
          : null,
    };
  }

  invokeStartupRetry(): void {
    const startup = findElementByType(this.tree, this.startupStateType);
    if (!startup) throw new Error("The startup state is not rendered");
    const onRetry = startup.props.onRetry;
    if (typeof onRetry !== "function") {
      throw new Error("The rendered startup state has no retry callback");
    }
    onRetry();
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const slot of this.slots) {
      if (slot.kind !== "effect") continue;
      slot.cleanup?.();
      slot.cleanup = undefined;
      slot.pending = false;
    }
    if (this.appContentPath != null) {
      this.appContentPath = null;
      this.currentAppContentIdentity = null;
      this.appContentUnmounts += 1;
    }
    this.tree = null;
  }

  private registerEffect(
    phase: EffectSlot["phase"],
    create: () => void | (() => void),
    dependencies: readonly unknown[] | undefined,
  ): void {
    const index = this.hookIndex;
    this.hookIndex += 1;
    const existing = this.slots[index];
    if (existing) {
      if (existing.kind !== "effect" || existing.phase !== phase) {
        throw new Error("Startup audit hook order changed at an effect");
      }
      const changed = !dependenciesEqual(existing.dependencies, dependencies);
      existing.create = create;
      existing.dependencies = dependencies;
      existing.pending ||= changed;
      return;
    }
    this.slots[index] = {
      kind: "effect",
      phase,
      create,
      dependencies,
      pending: true,
    };
  }

  private flushEffects(phase: EffectSlot["phase"]): void {
    for (const slot of this.slots) {
      if (slot.kind !== "effect" || slot.phase !== phase || !slot.pending) {
        continue;
      }
      slot.cleanup?.();
      const cleanup = slot.create();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      slot.pending = false;
    }
  }

  private reconcileAppContentIdentity(): void {
    const nextPath = findElementPathByType(this.tree, this.appContentType);
    if (this.appContentPath == null && nextPath == null) return;
    if (pathsEqual(this.appContentPath, nextPath)) return;
    if (this.appContentPath != null) {
      this.appContentUnmounts += 1;
    }
    this.appContentPath = nextPath;
    if (nextPath != null) {
      this.currentAppContentIdentity = this.nextAppContentIdentity;
      this.nextAppContentIdentity += 1;
      this.appContentMounts += 1;
    } else {
      this.currentAppContentIdentity = null;
    }
  }
}

function findMigratedAppSource(source: string, fileName: string): string {
  const sourceFile = ts.createSourceFile(
    fileName,
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
  if (matches.length !== 1) {
    throw new Error(
      `Expected one MigratedApp function, received ${matches.length}`,
    );
  }
  return matches[0].getText(sourceFile);
}

function transpileMigratedApp(sourceOptions: StartupAuditSourceOptions): {
  fileName: string;
  outputText: string;
} {
  const projectRoot = resolve(import.meta.dirname, "../..");
  const fileName = resolve(projectRoot, "app/_layout.tsx");
  const originalSource = readFileSync(fileName, "utf8");
  const source = sourceOptions.transform
    ? sourceOptions.transform(originalSource)
    : originalSource;
  const migratedAppSource = findMigratedAppSource(source, fileName);
  const auditModuleSource = `
const __audit = require("__startup_audit_runtime__");
const React = __audit.React;
const { useEffect, useLayoutEffect, useState } = React;
const {
  GestureHandlerRootView,
  SafeAreaProvider,
  StartupState,
  AppContent,
  i18n,
  console,
  useAppDatabaseMigrations,
  useSettingsStore,
  runWhenUiIsIdle,
  warmupHabitReminders,
} = __audit;
${migratedAppSource}
module.exports = { MigratedApp };
`;
  const transpiled = ts.transpileModule(auditModuleSource, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
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
      `MigratedApp transpilation failed: ${errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  return { fileName, outputText: transpiled.outputText };
}

function compileMigratedApp(
  runtime: StartupAuditRuntime,
  sourceOptions: StartupAuditSourceOptions,
): (props: MigratedAppProps) => AuditElement {
  const { fileName, outputText } = transpileMigratedApp(sourceOptions);
  const ModuleInternals = Module as unknown as CommonJsModuleConstructor;
  const originalLoad = ModuleInternals._load;
  const compiledModule = new ModuleInternals(fileName);
  compiledModule.filename = fileName;
  compiledModule.paths = ModuleInternals._nodeModulePaths(dirname(fileName));
  ModuleInternals._load = (request, parent, isMain) => {
    if (request === "__startup_audit_runtime__") return runtime;
    return originalLoad(request, parent, isMain);
  };
  try {
    compiledModule._compile(outputText, fileName);
  } finally {
    ModuleInternals._load = originalLoad;
  }
  const exports = compiledModule.exports as {
    MigratedApp?: (props: MigratedAppProps) => AuditElement;
  };
  if (typeof exports.MigratedApp !== "function") {
    throw new Error("The compiled module has no callable MigratedApp export");
  }
  return exports.MigratedApp;
}

function createRuntimeController(
  reactRuntime: AuditReactRuntime,
): StartupAuditRuntimeController {
  const AppContent = () => null;
  const controller: StartupAuditRuntimeController = {
    React: reactRuntime,
    GestureHandlerRootView: "GestureHandlerRootView",
    SafeAreaProvider: "SafeAreaProvider",
    StartupState: "StartupState",
    AppContent,
    i18n: { t: (key: string) => key },
    console: { error: (..._values: unknown[]) => undefined },
    migration: { success: false, error: null as unknown },
    settingsLoading: true,
    settingsLoads: [] as Deferred<boolean>[],
    settingsLoadInFlight: null as Deferred<boolean> | null,
    settingsLoadCalls: 0,
    warmups: 0,
    useAppDatabaseMigrations() {
      return controller.migration;
    },
    async loadSettings() {
      controller.settingsLoadCalls += 1;
      const next = controller.settingsLoads.shift();
      if (!next) {
        throw new Error("No settings load result was queued");
      }
      if (controller.settingsLoadInFlight) {
        throw new Error("A settings load is already in flight");
      }
      controller.settingsLoadInFlight = next;
      return next.promise;
    },
    useSettingsStore<T>(
      selector: (state: {
        isLoading: boolean;
        loadSettings(): Promise<boolean>;
      }) => T,
    ): T {
      return selector({
        isLoading: controller.settingsLoading,
        loadSettings: controller.loadSettings,
      });
    },
    runWhenUiIsIdle(callback: () => void) {
      callback();
    },
    async warmupHabitReminders() {
      controller.warmups += 1;
    },
  };
  reactRuntime.configureTypes(AppContent, controller.StartupState);
  return controller;
}

function createValidationRuntime(): StartupAuditRuntime {
  const reactRuntime = new AuditReactRuntime();
  const controller = createRuntimeController(reactRuntime);
  controller.settingsLoads.push(deferred<boolean>());
  return controller;
}

export function validateStartupAuditSourceTransform(
  sourceOptions: StartupAuditSourceOptions,
): void {
  compileMigratedApp(createValidationRuntime(), sourceOptions);
}

export function loadStartupForAudit(
  props: MigratedAppProps,
  sourceOptions: StartupAuditSourceOptions = {},
): StartupAuditHarness {
  const reactRuntime = new AuditReactRuntime();
  const controller = createRuntimeController(reactRuntime);
  const MigratedApp = compileMigratedApp(controller, sourceOptions);
  reactRuntime.mount(() => MigratedApp(props));

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
      reactRuntime.flush();
    }
  };

  return {
    get lateStateWriteCount() {
      return reactRuntime.lateStateWriteCount;
    },
    get settingsLoadCallCount() {
      return controller.settingsLoadCalls;
    },
    get warmupCallCount() {
      return controller.warmups;
    },
    snapshot: () => reactRuntime.snapshot(),
    setMigration(state) {
      controller.migration = state;
      reactRuntime.requestRender();
      reactRuntime.flush();
    },
    setSettingsLoading(loading) {
      controller.settingsLoading = loading;
      reactRuntime.requestRender();
      reactRuntime.flush();
    },
    queueSettingsLoad() {
      controller.settingsLoads.push(deferred<boolean>());
    },
    async completeNextSettingsLoad(result) {
      const next = controller.settingsLoadInFlight;
      if (!next) throw new Error("No pending settings load can complete");
      controller.settingsLoading = false;
      next.resolve(result);
      await settle();
      if (controller.settingsLoadInFlight === next) {
        controller.settingsLoadInFlight = null;
      }
    },
    async rejectNextSettingsLoad(error) {
      const next = controller.settingsLoadInFlight;
      if (!next) throw new Error("No pending settings load can reject");
      controller.settingsLoading = false;
      next.reject(error);
      await settle();
      if (controller.settingsLoadInFlight === next) {
        controller.settingsLoadInFlight = null;
      }
    },
    invokeStartupRetry: () => reactRuntime.invokeStartupRetry(),
    settle,
    unmount: () => reactRuntime.unmount(),
  };
}

export interface AppContentAuditRouteState {
  readonly stale?: boolean;
  readonly index?: number;
  readonly routes: readonly AppContentAuditRoute[];
}

export interface AppContentAuditRoute {
  readonly name: string;
  readonly state?: AppContentAuditRouteState;
}

export interface AppContentAuditEvent {
  readonly type: "presentation" | "select-date" | "replace";
  readonly values: readonly unknown[];
}

export interface AppContentAuditHarness {
  readonly events: readonly AppContentAuditEvent[];
  readonly subscriptionCount: number;
  readonly unsubscriptionCount: number;
  setNavigation(
    ready: boolean,
    state: AppContentAuditRouteState | undefined,
  ): void;
  emitNotification(): void;
  rerender(): void;
  unmount(): void;
}

interface AppContentAuditController {
  ready: boolean;
  navigationState: AppContentAuditRouteState | undefined;
  notificationCallback: (() => void) | null;
  subscriptions: number;
  unsubscriptions: number;
  readonly events: AppContentAuditEvent[];
  readonly router: { replace(path: string): void };
  readonly navigationRef: {
    isReady(): boolean;
    getRootState(): AppContentAuditRouteState | undefined;
  };
}

function findAppContentSource(source: string, fileName: string): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "AppContent",
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one AppContent function, received ${matches.length}`,
    );
  }
  return matches[0].getText(sourceFile);
}

function transpileAppContent(sourceOptions: StartupAuditSourceOptions): {
  fileName: string;
  outputText: string;
} {
  const projectRoot = resolve(import.meta.dirname, "../..");
  const fileName = resolve(projectRoot, "app/_layout.tsx");
  const originalSource = readFileSync(fileName, "utf8");
  const source = sourceOptions.transform
    ? sourceOptions.transform(originalSource)
    : originalSource;
  const appContentSource = findAppContentSource(source, fileName);
  const auditModuleSource = `
const __audit = require("__app_content_audit_runtime__");
const {
  React,
  useRouter,
  useNavigationContainerRef,
  subscribeToReminderNotificationResponses,
  subscribeToCurrentLocalDate,
  format,
  useUIStore,
  AppState,
  refreshSystemColorMode,
  retryFailedSettingsPlatformEffects,
  refreshReminderNotificationTimezone,
  startPendingReminderWorkBeforeBackground,
  AppChromeBoundary,
  ScreenPreferencesBoundary,
  PortalProvider,
  AppNavigation,
} = __audit;
const { useEffect } = React;
${appContentSource}
module.exports = { AppContent };
`;
  const transpiled = ts.transpileModule(auditModuleSource, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.React,
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
      `AppContent transpilation failed: ${errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  return { fileName, outputText: transpiled.outputText };
}

function createAppContentAuditController(): AppContentAuditController {
  let controller!: AppContentAuditController;
  controller = {
    ready: true,
    navigationState: undefined,
    notificationCallback: null,
    subscriptions: 0,
    unsubscriptions: 0,
    events: [],
    router: {
      replace(path) {
        controller.events.push({ type: "replace", values: [path] });
      },
    },
    navigationRef: {
      isReady: () => controller.ready,
      getRootState: () => controller.navigationState,
    },
  };
  return controller;
}

function createAppContentAuditRuntime(
  reactRuntime: AuditReactRuntime,
  controller: AppContentAuditController,
): Record<string, unknown> {
  const uiState = {
    requestNotificationPresentation(date: string) {
      controller.events.push({
        type: "presentation",
        values: [date],
      });
    },
    selectDate(date: string) {
      controller.events.push({ type: "select-date", values: [date] });
    },
  };
  return {
    React: reactRuntime,
    useRouter: () => controller.router,
    useNavigationContainerRef: () => controller.navigationRef,
    subscribeToReminderNotificationResponses(callback: () => void) {
      controller.subscriptions += 1;
      controller.notificationCallback = callback;
      return () => {
        controller.unsubscriptions += 1;
        if (controller.notificationCallback === callback) {
          controller.notificationCallback = null;
        }
      };
    },
    format: () => "2031-04-05",
    useUIStore: { getState: () => uiState },
    subscribeToCurrentLocalDate: () => () => undefined,
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove: () => undefined }),
    },
    refreshSystemColorMode: () => undefined,
    retryFailedSettingsPlatformEffects: () => undefined,
    refreshReminderNotificationTimezone: async () => undefined,
    startPendingReminderWorkBeforeBackground: () => undefined,
    AppChromeBoundary: "AppChromeBoundary",
    ScreenPreferencesBoundary: "ScreenPreferencesBoundary",
    PortalProvider: "PortalProvider",
    AppNavigation: "AppNavigation",
  };
}

function compileAppContent(
  runtime: Record<string, unknown>,
  sourceOptions: StartupAuditSourceOptions,
): () => AuditElement {
  const { fileName, outputText } = transpileAppContent(sourceOptions);
  const ModuleInternals = Module as unknown as CommonJsModuleConstructor;
  const originalLoad = ModuleInternals._load;
  const compiledModule = new ModuleInternals(fileName);
  compiledModule.filename = fileName;
  compiledModule.paths = ModuleInternals._nodeModulePaths(dirname(fileName));
  ModuleInternals._load = (request, parent, isMain) => {
    if (request === "__app_content_audit_runtime__") return runtime;
    return originalLoad(request, parent, isMain);
  };
  try {
    compiledModule._compile(outputText, fileName);
  } finally {
    ModuleInternals._load = originalLoad;
  }
  const exports = compiledModule.exports as {
    AppContent?: () => AuditElement;
  };
  if (typeof exports.AppContent !== "function") {
    throw new Error("The compiled module has no callable AppContent export");
  }
  return exports.AppContent;
}

export function validateAppContentAuditSourceTransform(
  sourceOptions: StartupAuditSourceOptions,
): void {
  const reactRuntime = new AuditReactRuntime();
  const controller = createAppContentAuditController();
  compileAppContent(
    createAppContentAuditRuntime(reactRuntime, controller),
    sourceOptions,
  );
}

export function loadAppContentForAudit(
  sourceOptions: StartupAuditSourceOptions = {},
): AppContentAuditHarness {
  const reactRuntime = new AuditReactRuntime();
  const controller = createAppContentAuditController();
  const AppContent = compileAppContent(
    createAppContentAuditRuntime(reactRuntime, controller),
    sourceOptions,
  );
  reactRuntime.mount(AppContent);

  return {
    events: controller.events,
    get subscriptionCount() {
      return controller.subscriptions;
    },
    get unsubscriptionCount() {
      return controller.unsubscriptions;
    },
    setNavigation(ready, state) {
      controller.ready = ready;
      controller.navigationState = state;
    },
    emitNotification() {
      if (!controller.notificationCallback) {
        throw new Error("No reminder notification subscriber is active");
      }
      controller.notificationCallback();
    },
    rerender() {
      reactRuntime.requestRender();
      reactRuntime.flush();
    },
    unmount() {
      reactRuntime.unmount();
    },
  };
}
