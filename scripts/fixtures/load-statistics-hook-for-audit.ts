import { readFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

import * as statisticsPreparation from "../../src/application/statistics/statistics-preparation";

type DependencyList = readonly unknown[] | undefined;
type Cleanup = void | (() => void);

interface MutableRef<T> {
  current: T;
}

interface StateSlot {
  kind: "state";
  value: unknown;
  setValue: (value: unknown) => void;
}

interface RefSlot {
  kind: "ref";
  value: MutableRef<unknown>;
}

interface MemoSlot {
  kind: "memo";
  value: unknown;
  dependencies: DependencyList;
}

interface EffectSlot {
  kind: "effect";
  phase: "layout" | "passive";
  create: () => Cleanup;
  cleanup?: () => void;
  dependencies: DependencyList;
  pending: boolean;
}

interface ExternalStoreSlot {
  kind: "external";
  value: unknown;
  getSnapshot: () => unknown;
  unsubscribe: () => void;
}

interface FocusSlot {
  kind: "focus";
  callback: () => Cleanup;
  cleanup?: () => void;
  pending: boolean;
}

type HookSlot =
  | StateSlot
  | RefSlot
  | MemoSlot
  | EffectSlot
  | ExternalStoreSlot
  | FocusSlot;

function dependenciesChanged(
  previous: DependencyList,
  next: DependencyList,
): boolean {
  return (
    previous == null ||
    next == null ||
    previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]))
  );
}

class StatisticsHookRuntime {
  private readonly slots: HookSlot[] = [];
  private hookIndex = 0;
  private dirty = false;
  private mounted = false;
  private focused = false;
  private hook: (() => StatisticsAuditHookResult) | null = null;
  private result: StatisticsAuditHookResult | null = null;

  readonly useState = <T>(initial: T | (() => T)) => {
    const index = this.hookIndex++;
    let slot = this.slots[index];
    if (!slot) {
      const stateSlot: StateSlot = {
        kind: "state",
        value: typeof initial === "function" ? (initial as () => T)() : initial,
        setValue: (next: unknown) => {
          const value =
            typeof next === "function"
              ? (next as (previous: unknown) => unknown)(stateSlot.value)
              : next;
          if (Object.is(value, stateSlot.value)) return;
          stateSlot.value = value;
          this.dirty = true;
        },
      };
      this.slots[index] = stateSlot;
      slot = stateSlot;
    }
    if (slot.kind !== "state") throw new Error(`Hook ${index} is not state`);
    return [slot.value as T, slot.setValue] as const;
  };

  readonly useRef = <T>(initial: T): MutableRef<T> => {
    const index = this.hookIndex++;
    let slot = this.slots[index];
    if (!slot) {
      slot = { kind: "ref", value: { current: initial } };
      this.slots[index] = slot;
    }
    if (slot.kind !== "ref") throw new Error(`Hook ${index} is not a ref`);
    return slot.value as MutableRef<T>;
  };

  readonly useMemo = <T>(create: () => T, dependencies: DependencyList): T => {
    const index = this.hookIndex++;
    let slot = this.slots[index];
    if (!slot) {
      slot = { kind: "memo", value: create(), dependencies };
      this.slots[index] = slot;
    } else {
      if (slot.kind !== "memo")
        throw new Error(`Hook ${index} is not memoized`);
      if (dependenciesChanged(slot.dependencies, dependencies)) {
        slot.value = create();
        slot.dependencies = dependencies;
      }
    }
    return slot.value as T;
  };

  readonly useCallback = <T extends (...args: never[]) => unknown>(
    callback: T,
    dependencies: DependencyList,
  ): T => this.useMemo(() => callback, dependencies);

  readonly useLayoutEffect = (
    create: () => Cleanup,
    dependencies?: readonly unknown[],
  ): void => this.useEffectSlot("layout", create, dependencies);

  readonly useEffect = (
    create: () => Cleanup,
    dependencies?: readonly unknown[],
  ): void => this.useEffectSlot("passive", create, dependencies);

  readonly useSyncExternalStore = <T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
  ): T => {
    const index = this.hookIndex++;
    let slot = this.slots[index];
    if (!slot) {
      const externalSlot: ExternalStoreSlot = {
        kind: "external",
        value: getSnapshot(),
        getSnapshot,
        unsubscribe: () => undefined,
      };
      externalSlot.unsubscribe = subscribe(() => {
        const next = externalSlot.getSnapshot();
        if (Object.is(next, externalSlot.value)) return;
        externalSlot.value = next;
        this.dirty = true;
      });
      this.slots[index] = externalSlot;
      slot = externalSlot;
    }
    if (slot.kind !== "external") {
      throw new Error(`Hook ${index} is not an external store`);
    }
    slot.getSnapshot = getSnapshot;
    slot.value = getSnapshot();
    return slot.value as T;
  };

  readonly useFocusEffect = (callback: () => Cleanup): void => {
    const index = this.hookIndex++;
    let slot = this.slots[index];
    if (!slot) {
      slot = { kind: "focus", callback, pending: this.focused };
      this.slots[index] = slot;
      return;
    }
    if (slot.kind !== "focus")
      throw new Error(`Hook ${index} is not focus-owned`);
    if (!Object.is(slot.callback, callback)) {
      slot.callback = callback;
      slot.pending = this.focused;
    }
  };

  setHook(hook: () => StatisticsAuditHookResult): void {
    this.hook = hook;
  }

  mount(): void {
    if (this.mounted || !this.hook) throw new Error("Invalid audit hook mount");
    this.mounted = true;
    this.dirty = true;
    this.flushAll();
  }

  focus(): void {
    if (this.focused) return;
    this.focused = true;
    for (const slot of this.slots) {
      if (slot.kind !== "focus") continue;
      slot.cleanup = slot.callback() || undefined;
      slot.pending = false;
    }
  }

  blur(): void {
    if (!this.focused) return;
    this.focused = false;
    for (const slot of this.slots) {
      if (slot.kind !== "focus") continue;
      slot.cleanup?.();
      slot.cleanup = undefined;
      slot.pending = false;
    }
  }

  flushRenderAndLayout(): void {
    let attempts = 0;
    do {
      this.renderIfDirty();
      this.flushEffects("layout");
      attempts += 1;
      if (attempts > 50) throw new Error("Statistics layout did not settle");
    } while (this.dirty);
  }

  flushAll(): void {
    let attempts = 0;
    do {
      this.flushRenderAndLayout();
      this.flushEffects("passive");
      this.flushPendingFocusEffects();
      attempts += 1;
      if (attempts > 50) throw new Error("Statistics effects did not settle");
    } while (this.dirty || this.hasPendingEffects());
  }

  flushPassiveStep(): void {
    this.flushEffects("passive");
    this.flushPendingFocusEffects();
  }

  current(): StatisticsAuditHookResult {
    if (!this.result) throw new Error("Statistics hook has no rendered result");
    return this.result;
  }

  unmount(): void {
    for (const slot of [...this.slots].reverse()) {
      if (slot.kind === "effect" || slot.kind === "focus") slot.cleanup?.();
      if (slot.kind === "external") slot.unsubscribe();
    }
    this.mounted = false;
  }

  private useEffectSlot(
    phase: "layout" | "passive",
    create: () => Cleanup,
    dependencies: DependencyList,
  ): void {
    const index = this.hookIndex++;
    let slot = this.slots[index];
    if (!slot) {
      slot = { kind: "effect", phase, create, dependencies, pending: true };
      this.slots[index] = slot;
      return;
    }
    if (slot.kind !== "effect" || slot.phase !== phase) {
      throw new Error(`Hook ${index} changed effect phase`);
    }
    slot.create = create;
    if (dependenciesChanged(slot.dependencies, dependencies)) {
      slot.dependencies = dependencies;
      slot.pending = true;
    }
  }

  private renderIfDirty(): void {
    if (!this.dirty) return;
    if (!this.hook) throw new Error("Statistics audit hook is unavailable");
    this.dirty = false;
    this.hookIndex = 0;
    this.result = this.hook();
    if (this.hookIndex !== this.slots.length) {
      throw new Error("Statistics hook count changed between renders");
    }
  }

  private flushEffects(phase: "layout" | "passive"): void {
    for (const slot of this.slots) {
      if (slot.kind !== "effect" || slot.phase !== phase || !slot.pending) {
        continue;
      }
      slot.pending = false;
      slot.cleanup?.();
      slot.cleanup = slot.create() || undefined;
    }
  }

  private flushPendingFocusEffects(): void {
    if (!this.focused) return;
    for (const slot of this.slots) {
      if (slot.kind !== "focus" || !slot.pending) continue;
      slot.pending = false;
      slot.cleanup?.();
      slot.cleanup = slot.callback() || undefined;
    }
  }

  private hasPendingEffects(): boolean {
    return this.slots.some(
      (slot) =>
        (slot.kind === "effect" && slot.pending) ||
        (slot.kind === "focus" && slot.pending && this.focused),
    );
  }
}

interface AuditStore<T extends object> {
  getState(): T;
  subscribe(listener: (state: T, previous: T) => void): () => void;
  setState(next: T): void;
}

function createAuditStore<T extends object>(initial: T): AuditStore<T> {
  let state = initial;
  const listeners = new Set<(state: T, previous: T) => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setState(next) {
      const previous = state;
      state = next;
      for (const listener of [...listeners]) listener(state, previous);
    },
  };
}

interface DeferredTask {
  cancelled: boolean;
  callback: () => void;
}

interface AuditStats {
  marker: string;
  periodProgress: string;
  progressCounts: { completed: number; planned: number; occurrences: number };
  perfectDays: { count: number; total: number };
  barChartData: unknown[];
  heatmapData: unknown[];
  habitBreakdown: unknown[];
  isEmpty: boolean;
  emptyReason: "no-habits" | "no-scheduled" | null;
}

function createStats(marker: string): AuditStats {
  return {
    marker,
    periodProgress: "0",
    progressCounts: { completed: 0, planned: 0, occurrences: 0 },
    perfectDays: { count: 0, total: 0 },
    barChartData: [],
    heatmapData: [],
    habitBreakdown: [],
    isEmpty: false,
    emptyReason: null,
  };
}

export interface StatisticsAuditHookResult {
  period: "week" | "month" | "year";
  periodOffset: number;
  periodBaseCivilDate: string;
  periodRange: {
    startDay: number;
    endDay: number;
    startDate: string;
    endDate: string;
  };
  canNavigatePrevious: boolean;
  canNavigateNext: boolean;
  stats: AuditStats;
  retainedScene: {
    period: "week" | "month" | "year";
    stats: AuditStats;
    presentationRevision: number;
    todayStr: string;
  } | null;
  sceneActive: boolean;
  isLoading: boolean;
  error: string | null;
  setPeriod(period: "week" | "month" | "year"): void;
  resolveNavigationTarget(direction: "prev" | "next"): {
    period: "week" | "month" | "year";
    periodOffset: number;
  };
  navigatePeriod(
    direction: "prev" | "next",
    target: { period: "week" | "month" | "year"; periodOffset: number },
  ): void;
  reload(): Promise<void>;
}

export interface StatisticsHookAuditSourceOptions {
  transform?: (source: string) => string;
  initiallyPrepared?: boolean;
}

interface CommonJsModuleInstance extends NodeModule {
  _compile(source: string, fileName: string): void;
}

interface CommonJsModuleConstructor {
  new (id?: string, parent?: NodeModule): CommonJsModuleInstance;
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
  _nodeModulePaths(from: string): string[];
}

function transpileStatisticsHook(
  projectRoot: string,
  options: StatisticsHookAuditSourceOptions,
): { fileName: string; outputText: string } {
  const fileName = resolve(
    projectRoot,
    "src/features/statistics/hooks/useStatistics.ts",
  );
  const original = readFileSync(fileName, "utf8");
  const source = options.transform ? options.transform(original) : original;
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
      `Statistics hook transpilation failed: ${errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }
  return { fileName, outputText: transpiled.outputText };
}

export function validateStatisticsHookAuditTransform(
  options: StatisticsHookAuditSourceOptions,
): void {
  transpileStatisticsHook(resolve(import.meta.dirname, "../.."), options);
}

export interface StatisticsHookAuditHarness {
  current(): StatisticsAuditHookResult;
  focus(): void;
  blur(): void;
  flushRenderAndLayout(): void;
  flushPassiveStep(): void;
  flushAll(): void;
  flushDeferred(): void;
  replaceRecords(marker: string): void;
  replaceHabits(marker: string): void;
  setArchiveSetting(value: boolean): void;
  setDate(value: string): void;
  failNextCalculation(): void;
  onNextCalculation(callback: () => void): void;
  readonly calculationCalls: readonly string[];
  readonly deferredTaskCount: number;
  readonly prewarmCount: number;
  unmount(): void;
}

export function loadStatisticsHookForAudit(
  options: StatisticsHookAuditSourceOptions = {},
): StatisticsHookAuditHarness {
  const projectRoot = resolve(import.meta.dirname, "../..");
  const runtime = new StatisticsHookRuntime();
  const deferredTasks: DeferredTask[] = [];
  const calculationCalls: string[] = [];
  let prewarmCount = 0;
  let failNext = false;
  let nextCalculationCallback: (() => void) | null = null;
  let date = "2026-11-13";
  const dateListeners = new Set<() => void>();
  const labels = new WeakMap<object, string>();
  const initialHabits: object[] = [{ marker: "habits-initial" }];
  const initialRecords: object[] = [{ marker: "records-initial" }];
  labels.set(initialHabits, "habits-initial");
  labels.set(initialRecords, "records-initial");

  const loadHabits = async () => true;
  const loadAllDayRecords = async () => true;
  const habitStore = createAuditStore({
    allHabits: initialHabits,
    allHabitsLoaded: true,
    allDayRecords: initialRecords,
    allDayRecordsLoaded: true,
    loadHabits,
    loadAllDayRecords,
  });
  const settingsStore = createAuditStore({
    showArchivedHabitsInStatistics: false,
  });

  const sourceKey = (
    source: {
      allHabits: object;
      allRecords: object;
      showArchivedHabitsInStatistics: boolean;
      todayStr: string;
    },
    period: string,
    periodOffset: number,
  ) =>
    [
      labels.get(source.allHabits) ?? "habits",
      labels.get(source.allRecords) ?? "records",
      source.showArchivedHabitsInStatistics ? "archived" : "active",
      source.todayStr,
      period,
      periodOffset,
    ].join("|");
  const prepared = new Map<
    string,
    {
      stats: AuditStats;
      cacheHit: boolean;
      sourceSessionCreated: boolean;
      visibleHabitCount: number;
    }
  >();
  const initialSource = {
    allHabits: initialHabits,
    allRecords: initialRecords,
    showArchivedHabitsInStatistics: false,
    todayStr: date,
  };
  if (options.initiallyPrepared) {
    prepared.set(sourceKey(initialSource, "week", 0), {
      stats: createStats("prepared-initial"),
      cacheHit: true,
      sourceSessionCreated: false,
      visibleHabitCount: 1,
    });
  }

  const sessionMock = {
    areStatisticsSourcesEqual: (
      left: typeof initialSource,
      right: typeof initialSource,
    ) =>
      left.allHabits === right.allHabits &&
      left.allRecords === right.allRecords &&
      left.showArchivedHabitsInStatistics ===
        right.showArchivedHabitsInStatistics &&
      left.todayStr === right.todayStr,
    CURRENT_STATISTICS_PERIOD_TARGETS: [
      { period: "week", periodOffset: 0 },
      { period: "month", periodOffset: 0 },
      { period: "year", periodOffset: 0 },
    ],
    EMPTY_STATISTICS_PERIOD_STATS: createStats("empty"),
    getStatisticsResourceCounts: () => ({}),
    peekPreparedStatisticsPeriod: (
      source: typeof initialSource,
      period: string,
      periodOffset: number,
    ) => prepared.get(sourceKey(source, period, periodOffset)) ?? null,
    getStatisticsPeriod: (
      source: typeof initialSource,
      period: string,
      periodOffset: number,
    ) => {
      const key = sourceKey(source, period, periodOffset);
      const hit = prepared.get(key);
      if (hit) return { ...hit, cacheHit: true };
      calculationCalls.push(key);
      if (failNext) {
        failNext = false;
        throw new Error("synthetic calculation failure");
      }
      const result = {
        stats: createStats(key),
        cacheHit: false,
        sourceSessionCreated: true,
        visibleHabitCount: source.allHabits.length,
      };
      prepared.set(key, result);
      const callback = nextCalculationCallback;
      nextCalculationCallback = null;
      callback?.();
      return result;
    },
  };

  const reactMock = {
    useState: runtime.useState,
    useEffect: runtime.useEffect,
    useLayoutEffect: runtime.useLayoutEffect,
    useMemo: runtime.useMemo,
    useCallback: runtime.useCallback,
    useRef: runtime.useRef,
    useSyncExternalStore: runtime.useSyncExternalStore,
  };
  const mocks = new Map<string, unknown>([
    ["react", { __esModule: true, default: reactMock, ...reactMock }],
    ["@react-navigation/native", { useFocusEffect: runtime.useFocusEffect }],
    [
      "@/features/statistics/utils/statistics-prewarm",
      {
        scheduleStatisticsPeriodsPrewarm: () => {
          prewarmCount += 1;
          return { cancel: () => undefined };
        },
      },
    ],
    ["@/application/statistics/statistics-preparation", statisticsPreparation],
    ["@/application/statistics/statistics-session", sessionMock],
    [
      "@/hooks/useCurrentLocalDate",
      {
        getCurrentLocalDateSnapshot: () => date,
        useCurrentLocalDate: () =>
          runtime.useSyncExternalStore(
            (listener: () => void) => {
              dateListeners.add(listener);
              return () => dateListeners.delete(listener);
            },
            () => date,
          ),
      },
    ],
    ["@/stores/habit-store", { useHabitStore: habitStore }],
    ["@/stores/settings-store", { useSettingsStore: settingsStore }],
    [
      "@/utils/ui-scheduling",
      {
        runAfterUiPaint: (callback: () => void) => {
          const task = { callback, cancelled: false };
          deferredTasks.push(task);
          return {
            cancel: () => {
              task.cancelled = true;
            },
          };
        },
      },
    ],
  ]);

  const { fileName, outputText } = transpileStatisticsHook(
    projectRoot,
    options,
  );
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
    compiledModule._compile(outputText, fileName);
  } finally {
    ModuleInternals._load = originalLoad;
  }
  const exports = compiledModule.exports as {
    useStatistics?: () => StatisticsAuditHookResult;
  };
  if (typeof exports.useStatistics !== "function") {
    throw new Error("Compiled statistics hook has no useStatistics export");
  }
  runtime.setHook(exports.useStatistics);
  runtime.mount();

  const replaceRecords = (marker: string) => {
    const records: object[] = [{ marker }];
    labels.set(records, marker);
    habitStore.setState({ ...habitStore.getState(), allDayRecords: records });
  };
  const replaceHabits = (marker: string) => {
    const habits: object[] = [{ marker }];
    labels.set(habits, marker);
    habitStore.setState({ ...habitStore.getState(), allHabits: habits });
  };

  return {
    current: () => runtime.current(),
    focus: () => runtime.focus(),
    blur: () => runtime.blur(),
    flushRenderAndLayout: () => runtime.flushRenderAndLayout(),
    flushPassiveStep: () => runtime.flushPassiveStep(),
    flushAll: () => runtime.flushAll(),
    flushDeferred: () => {
      const tasks = deferredTasks.splice(0);
      for (const task of tasks) if (!task.cancelled) task.callback();
      runtime.flushAll();
    },
    replaceRecords,
    replaceHabits,
    setArchiveSetting: (value) =>
      settingsStore.setState({
        showArchivedHabitsInStatistics: value,
      }),
    setDate: (value) => {
      date = value;
      for (const listener of [...dateListeners]) listener();
    },
    failNextCalculation: () => {
      failNext = true;
    },
    onNextCalculation: (callback) => {
      nextCalculationCallback = callback;
    },
    calculationCalls,
    get deferredTaskCount() {
      return deferredTasks.filter((task) => !task.cancelled).length;
    },
    get prewarmCount() {
      return prewarmCount;
    },
    unmount: () => runtime.unmount(),
  };
}
