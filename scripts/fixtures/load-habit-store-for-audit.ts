import { readFileSync } from "node:fs";
import Module from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { HabitPersistenceApplication } from "../../src/application/habits/habit-persistence";
import type { NotesApplication } from "../../src/application/notes/notes-application";
import { startArchivePeriod } from "../../src/domain/habits/archive-periods";
import { planHabitScheduleEdit } from "../../src/domain/habits/schedule-edit";
import type { DayRecord, Habit } from "../../src/types/habit";

type HabitStoreModule = typeof import("../../src/stores/habit-store");
type MarkDayInput = Parameters<HabitPersistenceApplication["markDay"]>[0];
type PersistScheduleEditInput = Parameters<
  HabitPersistenceApplication["persistScheduleEdit"]
>[0];
type PersistScheduleEditResult = Awaited<
  ReturnType<HabitPersistenceApplication["persistScheduleEdit"]>
>;

type AuthoritativeReadKind = "all-records" | "date-range" | "habit-records" | "habits";

interface DeferredReadGate {
  entered: Promise<AuthoritativeReadKind>;
  release(): void;
}

interface PendingReadGate {
  claimed: boolean;
  signalEntered(kind: AuthoritativeReadKind): void;
  released: Promise<void>;
  release(): void;
  publicGate: DeferredReadGate;
}

interface CommonJsModuleInstance {
  exports: unknown;
  filename: string;
  paths: string[];
  _compile(source: string, filename: string): void;
}

interface CommonJsModuleConstructor {
  new (
    filename: string,
    parent?: CommonJsModuleInstance,
  ): CommonJsModuleInstance;
  _load(
    request: string,
    parent: CommonJsModuleInstance | undefined,
    isMain: boolean,
  ): unknown;
  _nodeModulePaths(path: string): string[];
}

export interface HabitStoreAuditSourceOptions {
  transform?: (source: string) => string;
  waitForCommitOpportunity?: () => Promise<void>;
  notesProjection?: Pick<NotesApplication, "invalidate" | "invalidateAll">;
}

export interface HabitStoreAuditDataset {
  habits: readonly Habit[];
  records: readonly DayRecord[];
}

export interface LoadedHabitStoreForAudit {
  storeModule: HabitStoreModule;
  persistence: AuditHabitPersistence;
}

function cloneHabit(habit: Habit): Habit {
  return {
    ...habit,
    archiveHistory: habit.archiveHistory.map((period) => ({ ...period })),
    scheduleHistory: habit.scheduleHistory?.map((entry) => ({
      ...entry,
      repeatSchedule: { ...entry.repeatSchedule },
    })),
    repeatSchedule: { ...habit.repeatSchedule },
  };
}

function cloneRecord(record: DayRecord): DayRecord {
  return { ...record };
}

function createDeferredReadGate(): PendingReadGate {
  let signalEntered!: (kind: AuthoritativeReadKind) => void;
  let release!: () => void;
  const entered = new Promise<AuthoritativeReadKind>((resolveEntered) => {
    signalEntered = resolveEntered;
  });
  const released = new Promise<void>((resolveReleased) => {
    release = resolveReleased;
  });
  return {
    claimed: false,
    signalEntered,
    released,
    release,
    publicGate: { entered, release },
  };
}

export class AuditHabitPersistence {
  readonly application: HabitPersistenceApplication;

  private habits: Habit[];
  private records: DayRecord[];
  private nextRecordId: number;
  private nextReadGate: PendingReadGate | null = null;
  private nextHabitReadGate: PendingReadGate | null = null;
  private nextHabitReadError: Error | null = null;
  private nextReadError: Error | null = null;
  private nextMarkError: Error | null = null;
  private nextScheduleError: Error | null = null;
  private nextUnmarkError: Error | null = null;

  constructor(dataset: HabitStoreAuditDataset) {
    this.habits = dataset.habits.map(cloneHabit);
    this.records = dataset.records.map(cloneRecord);
    this.nextRecordId =
      this.records.reduce(
        (highest, record) => Math.max(highest, record.id),
        0,
      ) + 1;

    const unsupported = async (): Promise<never> => {
      throw new Error("Unsupported persistence operation in habit-store audit");
    };

    this.application = {
      readAllHabits: async () => {
        const snapshot = this.habits.map(cloneHabit);
        const gate = this.nextHabitReadGate;
        const failure = this.nextHabitReadError;
        this.nextHabitReadGate = null;
        this.nextHabitReadError = null;
        if (gate) {
          gate.signalEntered("habits");
          await gate.released;
        }
        if (failure) throw failure;
        return snapshot;
      },
      readHabit: async (habitId) => {
        const habit = this.habits.find((candidate) => candidate.id === habitId);
        return habit ? cloneHabit(habit) : null;
      },
      readDayRecordsForHabitOrderedByDate: async (habitId) => {
        const failure = this.takeNextReadError();
        const snapshot = this.records
          .filter((record) => record.habitId === habitId)
          .sort((left, right) => left.date.localeCompare(right.date))
          .map(cloneRecord);
        await this.waitForDeferredRead("habit-records");
        if (failure) throw failure;
        return snapshot;
      },
      readAllDayRecords: async () => {
        const failure = this.takeNextReadError();
        const snapshot = this.records.map(cloneRecord);
        await this.waitForDeferredRead("all-records");
        if (failure) throw failure;
        return snapshot;
      },
      readDayRecordsInDateRange: async (startDate, endDate) => {
        const failure = this.takeNextReadError();
        const snapshot = this.records
          .filter(
            (record) => record.date >= startDate && record.date <= endDate,
          )
          .map(cloneRecord);
        await this.waitForDeferredRead("date-range");
        if (failure) throw failure;
        return snapshot;
      },
      createHabit: async ({ habit, resolveDisplayOrderFromStorage }) => {
        const id = Math.max(0, ...this.habits.map((row) => row.id)) + 1;
        const displayOrder = resolveDisplayOrderFromStorage
          ? Math.max(-1, ...this.habits.map((row) => row.displayOrder)) + 1
          : habit.displayOrder;
        const persisted = cloneHabit({ ...habit, id, displayOrder });
        this.habits.push(persisted);
        return cloneHabit(persisted);
      },
      patchHabit: async (habitId, patch) => {
        this.habits = this.habits.map((habit) =>
          habit.id === habitId ? { ...habit, ...patch } : habit,
        );
      },
      persistScheduleEdit: async (input) => this.persistScheduleEdit(input),
      persistReorder: unsupported,
      archiveHabit: async (habitId, now) => this.archiveHabit(habitId, now),
      restoreHabits: unsupported,
      deleteHabits: async (habitIds) => this.deleteHabits(habitIds),
      markDay: async (input) => this.markDay(input),
      unmarkDay: async (habitId, date) => this.unmarkDay(habitId, date),
    };
  }

  replaceDataset(dataset: HabitStoreAuditDataset): void {
    this.habits = dataset.habits.map(cloneHabit);
    this.records = dataset.records.map(cloneRecord);
    this.nextRecordId =
      this.records.reduce(
        (highest, record) => Math.max(highest, record.id),
        0,
      ) + 1;
  }

  failNextMark(message = "Injected mark persistence failure"): void {
    this.nextMarkError = new Error(message);
  }

  failNextUnmark(message = "Injected unmark persistence failure"): void {
    this.nextUnmarkError = new Error(message);
  }

  failNextAuthoritativeRead(
    message = "Injected authoritative read failure",
  ): void {
    this.nextReadError = new Error(message);
  }

  failNextHabitRead(): void {
    this.nextHabitReadError = new Error("Injected habit read failure");
  }

  deferNextHabitRead(): DeferredReadGate {
    if (this.nextHabitReadGate) throw new Error("A habit read is already deferred");
    const gate = createDeferredReadGate();
    this.nextHabitReadGate = gate;
    return gate.publicGate;
  }

  failNextScheduleEdit(
    message = "Injected schedule persistence failure",
  ): void {
    this.nextScheduleError = new Error(message);
  }

  deferNextAuthoritativeRead(): DeferredReadGate {
    if (this.nextReadGate) {
      throw new Error("An authoritative read is already deferred");
    }
    const gate = createDeferredReadGate();
    this.nextReadGate = gate;
    return gate.publicGate;
  }

  snapshotRecords(): DayRecord[] {
    return this.records.map(cloneRecord);
  }

  private async waitForDeferredRead(
    kind: AuthoritativeReadKind,
  ): Promise<void> {
    const gate = this.nextReadGate;
    if (!gate || gate.claimed) return;
    gate.claimed = true;
    this.nextReadGate = null;
    gate.signalEntered(kind);
    await gate.released;
  }

  private takeNextReadError(): Error | null {
    const failure = this.nextReadError;
    this.nextReadError = null;
    return failure;
  }

  private async markDay(input: MarkDayInput): Promise<DayRecord> {
    const failure = this.nextMarkError;
    this.nextMarkError = null;
    if (failure) throw failure;

    const existingIndex = this.records.findIndex(
      (record) =>
        record.habitId === input.habitId && record.date === input.date,
    );
    const existing = existingIndex >= 0 ? this.records[existingIndex] : null;
    const persisted: DayRecord = existing
      ? { ...existing, status: input.status, updatedAt: input.now }
      : {
          id: this.nextRecordId++,
          habitId: input.habitId,
          date: input.date,
          status: input.status,
          createdAt: input.now,
          updatedAt: input.now,
        };
    if (existingIndex >= 0) this.records[existingIndex] = persisted;
    else this.records.push(persisted);
    return cloneRecord(persisted);
  }

  private async unmarkDay(habitId: number, date: string): Promise<void> {
    const failure = this.nextUnmarkError;
    this.nextUnmarkError = null;
    if (failure) throw failure;
    this.records = this.records.filter(
      (record) => record.habitId !== habitId || record.date !== date,
    );
  }

  private async deleteHabits(habitIds: readonly number[]): Promise<void> {
    const deletedIds = new Set(habitIds);
    this.habits = this.habits.filter((habit) => !deletedIds.has(habit.id));
    this.records = this.records.filter(
      (record) => !deletedIds.has(record.habitId),
    );
  }

  private async archiveHabit(
    habitId: number,
    now: number,
  ): Promise<Habit | null> {
    const index = this.habits.findIndex((habit) => habit.id === habitId);
    if (index < 0) return null;
    const existing = this.habits[index];
    if (existing.isArchived) return cloneHabit(existing);
    const archived: Habit = {
      ...existing,
      isArchived: true,
      archivedAt: now,
      archiveHistory: startArchivePeriod(existing.archiveHistory, now),
      updatedAt: now,
    };
    this.habits[index] = archived;
    return cloneHabit(archived);
  }

  private async persistScheduleEdit(
    input: PersistScheduleEditInput,
  ): Promise<PersistScheduleEditResult> {
    const failure = this.nextScheduleError;
    this.nextScheduleError = null;
    if (failure) throw failure;
    const index = this.habits.findIndex((habit) => habit.id === input.habitId);
    if (index < 0) return { kind: "missing" };
    const existing = this.habits[index];
    const habitRecords = this.records
      .filter((record) => record.habitId === input.habitId)
      .sort((left, right) => left.date.localeCompare(right.date));
    const plan = planHabitScheduleEdit({
      previousSchedule: existing.repeatSchedule,
      previousStartDate: existing.startDate,
      previousHistory: existing.scheduleHistory,
      records: habitRecords,
      nextSchedule: input.nextRepeatSchedule,
      nextStartDate: input.nextStartDate,
      today: input.today,
    });
    const { schedule: _ignoredSchedule, ...patch } = input.patch;
    if (!plan.changed) {
      if (!input.isCurrent()) return { kind: "unchanged" };
      this.habits[index] = { ...existing, ...patch };
      return { kind: "unchanged" };
    }
    if (!input.isCurrent()) return { kind: "unchanged" };
    const removedRecordIds = plan.removedRecords.map((record) => record.id);
    const removedIdSet = new Set(removedRecordIds);
    this.records = this.records.filter(
      (record) => !removedIdSet.has(record.id),
    );
    const persisted: Habit = {
      ...existing,
      ...patch,
      repeatSchedule: plan.repeatSchedule,
      scheduleHistory: plan.scheduleHistory,
      startDate: plan.startDate,
    };
    this.habits[index] = persisted;
    return {
      kind: "updated",
      habit: cloneHabit(persisted),
      removedRecordIds,
      removedRecordDates: [
        ...new Set(plan.removedRecords.map((record) => record.date)),
      ],
    };
  }
}

function readHabitStoreSource(
  projectRoot: string,
  options: HabitStoreAuditSourceOptions,
): string {
  const relativePath = "src/stores/habit-store.ts";
  const source = readFileSync(resolve(projectRoot, relativePath), "utf8");
  return options.transform ? options.transform(source) : source;
}

function compileHabitStoreModule(
  projectRoot: string,
  source: string,
  persistence: HabitPersistenceApplication,
  options: HabitStoreAuditSourceOptions,
): HabitStoreModule {
  const fileName = resolve(projectRoot, "src/stores/habit-store.ts");
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
      `Habit store transpilation failed: ${errors
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}`,
    );
  }

  const ModuleInternals = Module as unknown as CommonJsModuleConstructor;
  const originalLoad = ModuleInternals._load;
  const noOperation = () => undefined;
  const mocks = new Map<string, unknown>([
    ["@/composition/habits", { habitPersistence: persistence }],
    [
      "@/composition/persistence",
      {
        persistenceCommitScheduler: {
          waitForCommitOpportunity: options.waitForCommitOpportunity ?? (async () => undefined),
        },
      },
    ],
    [
      "@/composition/reminders",
      {
        scheduleHabitReminderAfterRecordChange: noOperation,
        scheduleHabitRemindersSync: noOperation,
      },
    ],
    [
      "@/composition/settings",
      {
        clearHabitDescriptionLinesCache: noOperation,
        publishDeletedHabitDescriptionLines: noOperation,
      },
    ],
    [
      "@/composition/notes",
      {
        invalidateAllNotesProjections:
          options.notesProjection?.invalidateAll ?? noOperation,
        invalidateNotesProjection:
          options.notesProjection?.invalidate ?? noOperation,
      },
    ],
  ]);

  const compiledModule = new ModuleInternals(fileName);
  compiledModule.filename = fileName;
  compiledModule.paths = ModuleInternals._nodeModulePaths(dirname(fileName));

  ModuleInternals._load = (request, parent, isMain) => {
    if (mocks.has(request)) return mocks.get(request);
    if (request.startsWith("@/")) {
      return originalLoad(
        resolve(projectRoot, "src", request.slice(2)),
        parent,
        isMain,
      );
    }
    if (request.startsWith("@app/")) {
      return originalLoad(
        resolve(projectRoot, "app", request.slice(5)),
        parent,
        isMain,
      );
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    compiledModule._compile(transpiled.outputText, fileName);
  } finally {
    ModuleInternals._load = originalLoad;
  }
  return compiledModule.exports as HabitStoreModule;
}

export function loadHabitStoreForAudit(
  dataset: HabitStoreAuditDataset,
  sourceOptions: HabitStoreAuditSourceOptions = {},
): LoadedHabitStoreForAudit {
  const projectRoot = resolve(import.meta.dirname, "../..");
  const persistence = new AuditHabitPersistence(dataset);
  const source = readHabitStoreSource(projectRoot, sourceOptions);
  const storeModule = compileHabitStoreModule(
    projectRoot,
    source,
    persistence.application,
    sourceOptions,
  );
  return { storeModule, persistence };
}
