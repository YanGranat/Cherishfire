import {
  SETTINGS_KEYS,
  STATISTICS_BLOCK_ORDER_KEYS,
  type AppSettings,
  type BuiltinColorOverrides,
  type ColorScheme,
  type CustomColorScheme,
  type StatisticsBlockId,
  type StatisticsPeriod,
  type ThemeMode,
} from "@/types/settings";
import type { SettingsWriteEntry } from "@/application/settings/settings-repository-port";
import {
  DESCRIPTION_LINES_DEFAULT,
  clampDescriptionVisibleLines,
  getDescriptionLinesSettingKey,
  getHabitDescriptionLinesScope,
  getHabitDescriptionLinesScopeHabitId,
  type HabitDescriptionLinesScope,
} from "@/application/settings/habit-description-lines-setting";
export type { SettingsWriteEntry } from "@/application/settings/settings-repository-port";
export interface ColorSettingsBundle {
  colorScheme: ColorScheme;
  colorSchemeOptions: ColorScheme[];
  builtinColorOverrides: BuiltinColorOverrides;
  customColors: CustomColorScheme[];
}
interface FixedSettingsMutationValues {
  theme: ThemeMode;
  color: ColorSettingsBundle;
  language: string;
  askFailureReason: boolean;
  askSkipReason: boolean;
  sound: boolean;
  reminderNotifications: boolean;
  archiveStatistics: boolean;
}
type StatisticsOrderScope = `statisticsOrder:${StatisticsPeriod}`;
export type SettingMutationScope =
  | keyof FixedSettingsMutationValues
  | StatisticsOrderScope
  | HabitDescriptionLinesScope;
export type SettingMutationValue<Scope extends SettingMutationScope> =
  Scope extends HabitDescriptionLinesScope
    ? number
    : Scope extends StatisticsOrderScope
      ? StatisticsBlockId[]
      : Scope extends keyof FixedSettingsMutationValues
        ? FixedSettingsMutationValues[Scope]
        : never;
interface SettingsMutationCommandBase<
  Scope extends SettingMutationScope,
  Value,
> {
  scope: Scope;
  value: Value;
}
type StatisticsOrderCommand = {
  [Period in StatisticsPeriod]: SettingsMutationCommandBase<
    `statisticsOrder:${Period}`,
    StatisticsBlockId[]
  >;
}[StatisticsPeriod];
type HabitDescriptionLinesCommand = SettingsMutationCommandBase<
  HabitDescriptionLinesScope,
  number
> & {
  operation: "set" | "delete";
};
export type SettingsMutationCommand =
  | SettingsMutationCommandBase<"theme", ThemeMode>
  | (SettingsMutationCommandBase<"color", ColorSettingsBundle> & {
      operation: "select" | "replace-bundle";
    })
  | SettingsMutationCommandBase<"language", string>
  | SettingsMutationCommandBase<"askFailureReason", boolean>
  | SettingsMutationCommandBase<"askSkipReason", boolean>
  | SettingsMutationCommandBase<"sound", boolean>
  | SettingsMutationCommandBase<"reminderNotifications", boolean>
  | SettingsMutationCommandBase<"archiveStatistics", boolean>
  | StatisticsOrderCommand
  | HabitDescriptionLinesCommand;
type SettingsMutationCommandForScope<Scope extends SettingMutationScope> =
  Scope extends HabitDescriptionLinesScope
    ? SettingsMutationCommandBase<Scope, number> & {
        operation: "set" | "delete";
      }
    : Extract<
        SettingsMutationCommand,
        {
          scope: Scope;
        }
      >;
export interface SettingsMutationSnapshot {
  theme: ThemeMode;
  color: ColorSettingsBundle;
  language: string;
  askFailureReason: boolean;
  askSkipReason: boolean;
  sound: boolean;
  reminderNotifications: boolean;
  archiveStatistics: boolean;
  statisticsBlockOrders: Record<StatisticsPeriod, StatisticsBlockId[]>;
  habitDescriptionLines: ReadonlyMap<number, number>;
}
export interface SettingsLoadToken {
  readonly generation: number;
  readonly revision: number;
}
export interface SettingsDurableFence {
  readonly id: number;
  readonly sequence: number;
}
export type SettingsDurableFenceReleaseMode =
  | "resume-post-cutoff"
  | "discard-post-cutoff";
export interface SettingsRepairEntry {
  readonly entry: SettingsWriteEntry;
  readonly scopes: readonly SettingMutationScope[];
}
export type SettingsSideEffectPhase = "apply" | "reconcile" | "rollback";
export interface SettingsMutationCoordinatorDependencies {
  write(entries: readonly SettingsWriteEntry[]): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
  waitForCommitOpportunity(): Promise<void>;
  scheduleRepair(task: () => void): {
    cancel(): void;
  };
  changeLanguage(
    language: string,
    phase: SettingsSideEffectPhase,
  ): Promise<unknown>;
  setReminderMasterEnabled(
    enabled: boolean,
    phase: SettingsSideEffectPhase,
  ): Promise<unknown>;
  onNativeEffectError(
    effect: "language" | "reminder-master",
    phase: SettingsSideEffectPhase,
    error: unknown,
  ): void;
}
export interface SettingsMutationResult<Scope extends SettingMutationScope> {
  readonly status: "committed" | "failed" | "superseded";
  readonly revision: number;
  readonly scope: Scope;
  readonly isLatest: boolean;
  readonly confirmedValue: SettingMutationValue<Scope>;
  readonly error?: unknown;
}
export interface SettingsMutationSubmission<
  Scope extends SettingMutationScope,
> {
  readonly revision: number;
  readonly scope: Scope;
  readonly completion: Promise<SettingsMutationResult<Scope>>;
}
export type SettingsRepairResult = "committed" | "superseded";
interface ConfirmedValue {
  revision: number;
  value: unknown;
}
type SettingsSideEffect =
  | {
      kind: "language";
      language: string;
    }
  | {
      kind: "reminder-master";
      enabled: boolean;
    };
export type SettingsSideEffectScope = "language" | "reminderNotifications";
interface RequestedSideEffect {
  readonly revision: number;
  readonly scope: "language" | "reminderNotifications";
  readonly effect: SettingsSideEffect;
  readonly phase: SettingsSideEffectPhase;
}
interface PendingRepair {
  readonly sequence: number;
  run(): void;
  cancel(): void;
}
interface RegisteredRepair extends SettingsRepairEntry {
  readonly token: number;
}
const COLOR_STRUCTURE_KEYS = [
  SETTINGS_KEYS.COLOR_SCHEME_OPTIONS,
  SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES,
  SETTINGS_KEYS.CUSTOM_COLORS,
] as const;
const ALL_SETTING_SCOPES: readonly SettingMutationScope[] = [
  "theme",
  "color",
  "language",
  "askFailureReason",
  "askSkipReason",
  "sound",
  "reminderNotifications",
  "archiveStatistics",
  "statisticsOrder:week",
  "statisticsOrder:month",
  "statisticsOrder:year",
];
type SettingsPersistenceOperation =
  | {
      readonly kind: "write";
      readonly entries: readonly SettingsWriteEntry[];
    }
  | {
      readonly kind: "delete";
      readonly keys: readonly string[];
    };
function cloneColorSettingsBundle(
  value: ColorSettingsBundle,
): ColorSettingsBundle {
  return {
    colorScheme: value.colorScheme,
    colorSchemeOptions: [...value.colorSchemeOptions],
    builtinColorOverrides: { ...value.builtinColorOverrides },
    customColors: [...value.customColors],
  };
}
function haveEqualColorStructure(
  left: ColorSettingsBundle,
  right: ColorSettingsBundle,
): boolean {
  if (
    left.colorSchemeOptions.length !== right.colorSchemeOptions.length ||
    left.colorSchemeOptions.some(
      (scheme, index) => scheme !== right.colorSchemeOptions[index],
    )
  ) {
    return false;
  }
  const leftOverrides = Object.entries(left.builtinColorOverrides);
  const rightOverrides = Object.entries(right.builtinColorOverrides);
  const haveEqualOverrides =
    leftOverrides.length === rightOverrides.length &&
    leftOverrides.every(
      ([scheme, color]) =>
        right.builtinColorOverrides[scheme as keyof BuiltinColorOverrides] ===
        color,
    );
  return (
    haveEqualOverrides &&
    left.customColors.length === right.customColors.length &&
    left.customColors.every(
      (color, index) => color === right.customColors[index],
    )
  );
}
function assertNever(value: never): never {
  throw new Error(`Unhandled settings mutation: ${JSON.stringify(value)}`);
}
function persistenceOperationForCommand(
  command: SettingsMutationCommand,
  confirmedColor: ColorSettingsBundle | null,
  forceColorBundle: boolean,
): SettingsPersistenceOperation {
  const descriptionHabitId = getHabitDescriptionLinesScopeHabitId(
    command.scope,
  );
  if (descriptionHabitId != null) {
    const descriptionCommand = command as HabitDescriptionLinesCommand;
    return descriptionCommand.operation === "delete"
      ? {
          kind: "delete",
          keys: [getDescriptionLinesSettingKey(descriptionHabitId)],
        }
      : {
          kind: "write",
          entries: [
            [
              getDescriptionLinesSettingKey(descriptionHabitId),
              clampDescriptionVisibleLines(descriptionCommand.value),
            ],
          ],
        };
  }
  switch (command.scope) {
    case "theme":
      return { kind: "write", entries: [[SETTINGS_KEYS.THEME, command.value]] };
    case "color":
      return {
        kind: "write",
        entries:
          !forceColorBundle &&
          command.operation === "select" &&
          confirmedColor != null &&
          haveEqualColorStructure(command.value, confirmedColor)
            ? [[SETTINGS_KEYS.COLOR_SCHEME, command.value.colorScheme]]
            : [
                [
                  SETTINGS_KEYS.COLOR_SCHEME_OPTIONS,
                  command.value.colorSchemeOptions,
                ],
                [
                  SETTINGS_KEYS.BUILTIN_COLOR_OVERRIDES,
                  command.value.builtinColorOverrides,
                ],
                [SETTINGS_KEYS.CUSTOM_COLORS, command.value.customColors],
                [SETTINGS_KEYS.COLOR_SCHEME, command.value.colorScheme],
              ],
      };
    case "language":
      return {
        kind: "write",
        entries: [[SETTINGS_KEYS.LANGUAGE, command.value]],
      };
    case "askFailureReason":
      return {
        kind: "write",
        entries: [[SETTINGS_KEYS.ASK_FAILURE_REASON, command.value]],
      };
    case "askSkipReason":
      return {
        kind: "write",
        entries: [[SETTINGS_KEYS.ASK_SKIP_REASON, command.value]],
      };
    case "sound":
      return {
        kind: "write",
        entries: [[SETTINGS_KEYS.SOUND_ENABLED, command.value]],
      };
    case "reminderNotifications":
      return {
        kind: "write",
        entries: [
          [SETTINGS_KEYS.REMINDER_NOTIFICATIONS_ENABLED, command.value],
        ],
      };
    case "archiveStatistics":
      return {
        kind: "write",
        entries: [
          [SETTINGS_KEYS.SHOW_ARCHIVED_HABITS_IN_STATISTICS, command.value],
        ],
      };
    case "statisticsOrder:week":
      return {
        kind: "write",
        entries: [[STATISTICS_BLOCK_ORDER_KEYS.week, command.value]],
      };
    case "statisticsOrder:month":
      return {
        kind: "write",
        entries: [[STATISTICS_BLOCK_ORDER_KEYS.month, command.value]],
      };
    case "statisticsOrder:year":
      return {
        kind: "write",
        entries: [[STATISTICS_BLOCK_ORDER_KEYS.year, command.value]],
      };
    default:
      return assertNever(command as never);
  }
}
function sideEffectForValue<Scope extends SettingMutationScope>(
  scope: Scope,
  value: SettingMutationValue<Scope>,
): {
  scope: "language" | "reminderNotifications";
  effect: SettingsSideEffect;
} | null {
  if (scope === "language") {
    return {
      scope: "language",
      effect: { kind: "language", language: value as string },
    };
  }
  if (scope === "reminderNotifications") {
    return {
      scope: "reminderNotifications",
      effect: { kind: "reminder-master", enabled: value as boolean },
    };
  }
  return null;
}
function cloneMutationValue<Scope extends SettingMutationScope>(
  scope: Scope,
  value: SettingMutationValue<Scope>,
): SettingMutationValue<Scope> {
  if (scope === "color") {
    return cloneColorSettingsBundle(
      value as ColorSettingsBundle,
    ) as SettingMutationValue<Scope>;
  }
  if (scope.startsWith("statisticsOrder:")) {
    return [...(value as StatisticsBlockId[])] as SettingMutationValue<Scope>;
  }
  if (getHabitDescriptionLinesScopeHabitId(scope) != null) {
    return clampDescriptionVisibleLines(
      value as number,
    ) as SettingMutationValue<Scope>;
  }
  return value;
}
function cloneMutationCommand<Scope extends SettingMutationScope>(
  command: SettingsMutationCommandForScope<Scope>,
): SettingsMutationCommandForScope<Scope> {
  return {
    ...command,
    value: cloneMutationValue(
      command.scope,
      command.value as SettingMutationValue<Scope>,
    ),
  } as SettingsMutationCommandForScope<Scope>;
}
function cloneSettingsWriteValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneSettingsWriteValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        cloneSettingsWriteValue(nestedValue),
      ]),
    );
  }
  return value;
}
function snapshotValueForScope<Scope extends SettingMutationScope>(
  snapshot: SettingsMutationSnapshot,
  scope: Scope,
): SettingMutationValue<Scope> {
  const descriptionHabitId = getHabitDescriptionLinesScopeHabitId(scope);
  if (descriptionHabitId != null) {
    return (snapshot.habitDescriptionLines.get(descriptionHabitId) ??
      DESCRIPTION_LINES_DEFAULT) as SettingMutationValue<Scope>;
  }
  if (scope.startsWith("statisticsOrder:")) {
    const period = scope.slice("statisticsOrder:".length) as StatisticsPeriod;
    return [
      ...snapshot.statisticsBlockOrders[period],
    ] as SettingMutationValue<Scope>;
  }
  return cloneMutationValue(
    scope,
    snapshot[
      scope as keyof FixedSettingsMutationValues
    ] as SettingMutationValue<Scope>,
  );
}
export function createSettingsMutationSnapshot(
  settings: AppSettings,
  habitDescriptionLines: ReadonlyMap<number, number> = new Map(),
): SettingsMutationSnapshot {
  return {
    theme: settings.theme,
    color: cloneColorSettingsBundle(settings),
    language: settings.language,
    askFailureReason: settings.askFailureReason,
    askSkipReason: settings.askSkipReason,
    sound: settings.soundEnabled,
    reminderNotifications: settings.reminderNotificationsEnabled,
    archiveStatistics: settings.showArchivedHabitsInStatistics,
    statisticsBlockOrders: {
      week: [...settings.statisticsBlockOrders.week],
      month: [...settings.statisticsBlockOrders.month],
      year: [...settings.statisticsBlockOrders.year],
    },
    habitDescriptionLines: new Map(
      [...habitDescriptionLines].map(([habitId, lines]) => [
        habitId,
        clampDescriptionVisibleLines(lines),
      ]),
    ),
  };
}
export class SettingsMutationCoordinator {
  private revision = 0;
  private durableSequence = 0;
  private durableFenceId = 0;
  private generation = 0;
  private readonly latestRevisionByScope = new Map<
    SettingMutationScope,
    number
  >();
  private readonly confirmedByScope = new Map<
    SettingMutationScope,
    ConfirmedValue
  >();
  private readonly currentByScope = new Map<SettingMutationScope, unknown>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly pendingByDurableSequence = new Map<
    number,
    Promise<unknown>
  >();
  private activeDurableFence: SettingsDurableFence | null = null;
  private readonly durableGateWaiters = new Set<() => void>();
  private readonly discardedDurableSequences = new Set<number>();
  private readonly pendingEffects = new Set<Promise<unknown>>();
  private readonly pendingRepairs = new Set<PendingRepair>();
  private repairToken = 0;
  private readonly dirtyRepairsByKey = new Map<string, RegisteredRepair>();
  private readonly scopeTails = new Map<SettingMutationScope, Promise<void>>();
  private readonly requestedEffects = new Map<
    SettingsSideEffect["kind"],
    RequestedSideEffect
  >();
  private readonly failedEffects = new Map<
    SettingsSideEffect["kind"],
    RequestedSideEffect
  >();
  private readonly runningEffectKinds = new Set<SettingsSideEffect["kind"]>();
  getResourceCounts() {
    return {
      pendingWriteCount: this.pending.size,
      pendingEffectCount: this.pendingEffects.size,
      pendingRepairCount: this.pendingRepairs.size,
      dirtyRepairCount: this.dirtyRepairsByKey.size,
      durableWaiterCount: this.durableGateWaiters.size,
      durableFenceActive: this.activeDurableFence != null,
      scopeCount: this.currentByScope.size,
      generationCount: this.generation,
      scopeTailCount: this.scopeTails.size,
      requestedEffectCount: this.requestedEffects.size,
      failedEffectCount: this.failedEffects.size,
      runningEffectCount: this.runningEffectKinds.size,
    };
  }
  constructor(
    private readonly dependencies: SettingsMutationCoordinatorDependencies,
    initialSnapshot: SettingsMutationSnapshot,
  ) {
    this.replaceConfirmedSnapshot(initialSnapshot);
  }
  captureLoadToken(): SettingsLoadToken {
    return {
      generation: this.generation,
      revision: this.revision,
    };
  }
  captureDurableFence(): SettingsDurableFence {
    if (this.activeDurableFence) {
      throw new Error("Only one settings durable fence may be active");
    }
    const fence = {
      id: ++this.durableFenceId,
      sequence: this.durableSequence,
    };
    this.activeDurableFence = fence;
    return fence;
  }
  /** Waits only for durable work accepted at the captured cutoff. */
  async whenDurableThrough(fence: SettingsDurableFence): Promise<void> {
    if (!this.isActiveDurableFence(fence)) {
      throw new Error("Settings durable fence is no longer active");
    }
    while (true) {
      for (const repair of this.pendingRepairs) {
        if (repair.sequence <= fence.sequence) repair.run();
      }
      const pending = [...this.pendingByDurableSequence]
        .filter(([sequence]) => sequence <= fence.sequence)
        .map(([, promise]) => promise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }
  releaseDurableFence(
    fence: SettingsDurableFence,
    mode: SettingsDurableFenceReleaseMode,
  ): void {
    if (!this.isActiveDurableFence(fence)) return;
    if (mode === "discard-post-cutoff") {
      for (const sequence of this.pendingByDurableSequence.keys()) {
        if (sequence > fence.sequence) {
          this.discardedDurableSequences.add(sequence);
        }
      }
    }
    this.activeDurableFence = null;
    for (const resume of this.durableGateWaiters) resume();
    this.durableGateWaiters.clear();
  }
  /**
   * A SELECT must not overtake an intent that was already registered but whose
   * repository call has not reached the SQLite queue yet.
   */
  async captureSettledLoadToken(): Promise<SettingsLoadToken> {
    while (true) {
      await this.whenIdle();
      // Another microtask can register an intent between whenIdle resolving
      // and this continuation. Capture only a genuinely quiescent boundary.
      if (this.pending.size === 0) return this.captureLoadToken();
    }
  }
  isLoadTokenCurrent(token: SettingsLoadToken): boolean {
    return (
      token.generation === this.generation && token.revision === this.revision
    );
  }
  /**
   * Publishes a database snapshot only if no local intent appeared while its
   * read was in flight. Resetting also invalidates every deferred old repair.
   */
  replaceConfirmedSnapshot(
    snapshot: SettingsMutationSnapshot,
    token?: SettingsLoadToken,
  ): boolean {
    if (token && !this.isLoadTokenCurrent(token)) return false;
    for (const repair of this.pendingRepairs) repair.cancel();
    this.dirtyRepairsByKey.clear();
    const revision = ++this.revision;
    this.generation += 1;
    this.failedEffects.clear();
    for (const scope of [
      ...this.latestRevisionByScope.keys(),
      ...this.confirmedByScope.keys(),
      ...this.currentByScope.keys(),
    ]) {
      if (getHabitDescriptionLinesScopeHabitId(scope) == null) continue;
      this.latestRevisionByScope.delete(scope);
      this.confirmedByScope.delete(scope);
      this.currentByScope.delete(scope);
    }
    const snapshotScopes = [
      ...ALL_SETTING_SCOPES,
      ...[...snapshot.habitDescriptionLines.keys()].map(
        getHabitDescriptionLinesScope,
      ),
    ];
    for (const scope of snapshotScopes) {
      const value = snapshotValueForScope(snapshot, scope);
      this.latestRevisionByScope.set(scope, revision);
      this.confirmedByScope.set(scope, {
        revision,
        value,
      });
      this.currentByScope.set(scope, cloneMutationValue(scope, value));
    }
    return true;
  }
  getConfirmedValue<Scope extends SettingMutationScope>(
    scope: Scope,
  ): SettingMutationValue<Scope> {
    const confirmed = this.confirmedByScope.get(scope);
    if (!confirmed) {
      if (getHabitDescriptionLinesScopeHabitId(scope) != null) {
        return DESCRIPTION_LINES_DEFAULT as SettingMutationValue<Scope>;
      }
      throw new Error(`Missing confirmed setting scope: ${scope}`);
    }
    return cloneMutationValue(
      scope,
      confirmed.value as SettingMutationValue<Scope>,
    );
  }
  getCurrentValue<Scope extends SettingMutationScope>(
    scope: Scope,
  ): SettingMutationValue<Scope> {
    const current = this.currentByScope.get(scope);
    if (current === undefined) {
      if (getHabitDescriptionLinesScopeHabitId(scope) != null) {
        return DESCRIPTION_LINES_DEFAULT as SettingMutationValue<Scope>;
      }
      return this.getConfirmedValue(scope);
    }
    return cloneMutationValue(scope, current as SettingMutationValue<Scope>);
  }
  readHabitDescriptionLines(habitId: number): number {
    return this.getCurrentValue(getHabitDescriptionLinesScope(habitId));
  }
  /**
   * Habit deletion has already removed the row transactionally. Register an
   * idempotent coordinator-owned delete after every older scope command so a
   * delayed resize can never leave an orphan behind.
   */
  publishDeletedHabitDescriptionLines(
    habitIds: Iterable<number>,
  ): readonly SettingsMutationSubmission<HabitDescriptionLinesScope>[] {
    const submissions: SettingsMutationSubmission<HabitDescriptionLinesScope>[] =
      [];
    for (const habitId of habitIds) {
      const scope = getHabitDescriptionLinesScope(habitId);
      const submission = this.submit({
        scope,
        value: DESCRIPTION_LINES_DEFAULT,
        operation: "delete",
      });
      // The habit transaction already made this the real durable baseline.
      // A best-effort trailing delete only absorbs an older delayed UPSERT.
      this.confirmCommittedValue(
        scope,
        submission.revision,
        DESCRIPTION_LINES_DEFAULT,
      );
      submissions.push(submission);
    }
    return submissions;
  }
  clearHabitDescriptionLinesCache(): void {
    const dynamicScopes = new Set<SettingMutationScope>();
    for (const scope of [
      ...this.latestRevisionByScope.keys(),
      ...this.confirmedByScope.keys(),
      ...this.currentByScope.keys(),
    ]) {
      if (getHabitDescriptionLinesScopeHabitId(scope) != null) {
        dynamicScopes.add(scope);
      }
    }
    if (dynamicScopes.size === 0) return;
    this.revision += 1;
    this.generation += 1;
    for (const scope of dynamicScopes) {
      this.latestRevisionByScope.delete(scope);
      this.confirmedByScope.delete(scope);
      this.currentByScope.delete(scope);
    }
  }
  /** Reconciles a loaded durable snapshot through the same tracked effect owner. */
  reconcileConfirmedSideEffect(scope: SettingsSideEffectScope): void {
    const revision = this.latestRevisionByScope.get(scope);
    if (revision === undefined) {
      throw new Error(`Missing confirmed setting scope: ${scope}`);
    }
    const effect = sideEffectForValue(scope, this.getConfirmedValue(scope));
    if (!effect) return;
    this.requestSideEffect(effect.scope, revision, effect.effect, "reconcile");
  }
  isLatest(
    submission: Pick<
      SettingsMutationSubmission<SettingMutationScope>,
      "scope" | "revision"
    >,
  ): boolean {
    return (
      this.latestRevisionByScope.get(submission.scope) === submission.revision
    );
  }
  submit<Scope extends SettingMutationScope>(
    command: SettingsMutationCommandForScope<Scope>,
  ): SettingsMutationSubmission<Scope> {
    // The queued operation owns an immutable snapshot of the caller's intent.
    // A future caller mutating an array/object in place cannot change a command
    // after its revision and optimistic state have already been registered.
    const ownedCommand = cloneMutationCommand(command);
    if (
      getHabitDescriptionLinesScopeHabitId(ownedCommand.scope) != null &&
      !this.confirmedByScope.has(ownedCommand.scope)
    ) {
      this.confirmedByScope.set(ownedCommand.scope, {
        revision: this.revision,
        value: DESCRIPTION_LINES_DEFAULT,
      });
    }
    const revision = ++this.revision;
    const durableSequence = ++this.durableSequence;
    this.latestRevisionByScope.set(ownedCommand.scope, revision);
    this.currentByScope.set(
      ownedCommand.scope,
      cloneMutationValue(ownedCommand.scope, ownedCommand.value),
    );
    // Registration and optimistic state finish synchronously. The shared
    // scheduler gives the foreground UI a complete paint opportunity, while
    // AppState releases the write immediately if the app backgrounds.
    const completion = this.trackDurable(
      durableSequence,
      this.enqueueScope(ownedCommand.scope, () =>
        this.executeCommand(ownedCommand, revision, durableSequence),
      ),
    );
    return { revision, scope: ownedCommand.scope as Scope, completion };
  }
  scheduleRepair(
    repairs: readonly SettingsRepairEntry[],
  ): Promise<SettingsRepairResult> {
    if (repairs.length === 0) return Promise.resolve("superseded");
    const registeredRepairs: RegisteredRepair[] = repairs.map(
      ({ entry: [key, value], scopes }) => {
        const repair: RegisteredRepair = {
          token: ++this.repairToken,
          entry: [key, cloneSettingsWriteValue(value)],
          scopes: [...scopes],
        };
        this.dirtyRepairsByKey.set(key, repair);
        return repair;
      },
    );
    const generation = this.generation;
    const baselines = new Map(this.latestRevisionByScope);
    const durableSequence = ++this.durableSequence;
    let started = false;
    let settled = false;
    let scheduledTask: {
      cancel(): void;
    } | null = null;
    let resolveRepair!: (result: SettingsRepairResult) => void;
    let rejectRepair!: (error: unknown) => void;
    const repairPromise = new Promise<SettingsRepairResult>(
      (resolve, reject) => {
        resolveRepair = resolve;
        rejectRepair = reject;
      },
    );
    const finish = (result: SettingsRepairResult) => {
      if (settled) return;
      settled = true;
      this.pendingRepairs.delete(pendingRepair);
      resolveRepair(result);
    };
    const performRepair = async () => {
      await this.waitForDurableGate(durableSequence);
      if (this.discardedDurableSequences.has(durableSequence)) {
        for (const repair of registeredRepairs) this.clearDirtyRepair(repair);
        finish("superseded");
        return;
      }
      if (generation !== this.generation) {
        finish("superseded");
        return;
      }
      const freshRepairs = registeredRepairs.filter((repair) => {
        const [key] = repair.entry;
        return (
          this.dirtyRepairsByKey.get(key)?.token === repair.token &&
          repair.scopes.every(
            (scope) =>
              this.latestRevisionByScope.get(scope) === baselines.get(scope),
          )
        );
      });
      if (freshRepairs.length === 0) {
        finish("superseded");
        return;
      }
      const freshEntries = freshRepairs.map(({ entry }) => entry);
      try {
        await this.dependencies.write(freshEntries);
        for (const repair of freshRepairs) this.clearDirtyRepair(repair);
        finish("committed");
      } catch (error) {
        if (settled) return;
        settled = true;
        this.pendingRepairs.delete(pendingRepair);
        rejectRepair(error);
      }
    };
    const run = () => {
      if (started || settled) return;
      started = true;
      scheduledTask?.cancel();
      void performRepair();
    };
    const pendingRepair: PendingRepair = {
      sequence: durableSequence,
      run,
      cancel: () => {
        if (started || settled) return;
        scheduledTask?.cancel();
        finish("superseded");
      },
    };
    this.pendingRepairs.add(pendingRepair);
    // Register pending synchronously before handing control to any scheduler.
    // AppState/export can now flush the repair even if no RAF/idle callback has
    // fired (or can fire while the app is in the background).
    const trackedRepair = this.trackDurable(durableSequence, repairPromise);
    try {
      scheduledTask = this.dependencies.scheduleRepair(run);
      if (settled) scheduledTask.cancel();
    } catch (error) {
      if (!settled) {
        settled = true;
        this.pendingRepairs.delete(pendingRepair);
        rejectRepair(error);
      }
    }
    return trackedRepair;
  }
  async whenIdle(): Promise<void> {
    while (true) {
      for (const repair of this.pendingRepairs) repair.run();
      if (this.pending.size === 0) return;
      await Promise.allSettled([...this.pending]);
    }
  }
  /** Native/i18n reconciliation is deliberately outside the durable barrier. */
  async whenEffectsIdle(): Promise<void> {
    while (this.pendingEffects.size > 0) {
      await Promise.allSettled([...this.pendingEffects]);
    }
  }
  /** Retries each latest failed effect once; another failure remains dormant. */
  retryFailedSideEffects(): void {
    for (const [kind, failed] of [...this.failedEffects]) {
      this.failedEffects.delete(kind);
      if (!this.isCurrent(failed.scope, failed.revision)) continue;
      this.requestedEffects.set(kind, failed);
      if (!this.runningEffectKinds.has(kind)) {
        this.startSideEffectRunner(kind);
      }
    }
  }
  private async executeCommand<Scope extends SettingMutationScope>(
    command: SettingsMutationCommandForScope<Scope>,
    revision: number,
    durableSequence: number,
  ): Promise<SettingsMutationResult<Scope>> {
    await this.waitForDurableGate(durableSequence);
    if (this.discardedDurableSequences.has(durableSequence)) {
      return this.createResult<Scope>(
        command.scope as Scope,
        revision,
        "superseded",
      );
    }
    if (
      !this.isCurrent(command.scope, revision) &&
      !this.isDurableSequencePinned(durableSequence)
    ) {
      return this.createResult<Scope>(
        command.scope as Scope,
        revision,
        "superseded",
      );
    }
    try {
      await this.dependencies.waitForCommitOpportunity();
      if (this.discardedDurableSequences.has(durableSequence)) {
        return this.createResult<Scope>(
          command.scope as Scope,
          revision,
          "superseded",
        );
      }
      if (
        !this.isCurrent(command.scope, revision) &&
        !this.isDurableSequencePinned(durableSequence)
      ) {
        return this.createResult<Scope>(
          command.scope as Scope,
          revision,
          "superseded",
        );
      }
      const confirmedColor =
        command.scope === "color" ? this.getConfirmedValue("color") : null;
      const persistence = persistenceOperationForCommand(
        command,
        confirmedColor,
        command.scope === "color" && this.hasDirtyColorStructure(),
      );
      const entries = persistence.kind === "write" ? persistence.entries : [];
      const dirtyTokens = new Map(
        entries.map(([key]) => [key, this.dirtyRepairsByKey.get(key)?.token]),
      );
      if (persistence.kind === "write") {
        await (() => this.dependencies.write(persistence.entries))();
      } else {
        await (() => this.dependencies.delete(persistence.keys))();
      }
      for (const [key, token] of dirtyTokens) {
        if (
          token !== undefined &&
          this.dirtyRepairsByKey.get(key)?.token === token
        ) {
          this.dirtyRepairsByKey.delete(key);
        }
      }
      this.confirmCommittedValue(
        command.scope,
        revision,
        command.value as SettingMutationValue<Scope>,
      );
      const effect = sideEffectForValue(
        command.scope,
        command.value as SettingMutationValue<Scope>,
      );
      if (this.isCurrent(command.scope, revision) && effect) {
        this.requestSideEffect(effect.scope, revision, effect.effect, "apply");
      }
      const result = this.createResult<Scope>(
        command.scope as Scope,
        revision,
        "committed",
      );
      if (
        getHabitDescriptionLinesScopeHabitId(command.scope) != null &&
        "operation" in command &&
        command.operation === "delete" &&
        this.isCurrent(command.scope, revision)
      ) {
        this.latestRevisionByScope.delete(command.scope);
        this.confirmedByScope.delete(command.scope);
        this.currentByScope.delete(command.scope);
      }
      return result;
    } catch (error) {
      if (this.isCurrent(command.scope, revision)) {
        const confirmedValue = this.getConfirmedValue(command.scope);
        this.currentByScope.set(
          command.scope,
          cloneMutationValue(command.scope, confirmedValue),
        );
        const effect = sideEffectForValue(command.scope, confirmedValue);
        if (effect) {
          this.requestSideEffect(
            effect.scope,
            revision,
            effect.effect,
            "rollback",
          );
        }
        this.rescheduleDirtyRepairsForScope(command.scope);
      }
      return this.createResult<Scope>(
        command.scope as Scope,
        revision,
        "failed",
        error,
      );
    }
  }
  private requestSideEffect(
    scope: "language" | "reminderNotifications",
    revision: number,
    effect: SettingsSideEffect,
    phase: SettingsSideEffectPhase,
  ): void {
    // A later intent or an explicit retry supersedes the dormant failure.
    this.failedEffects.delete(effect.kind);
    this.requestedEffects.set(effect.kind, {
      revision,
      scope,
      effect,
      phase,
    });
    if (!this.runningEffectKinds.has(effect.kind)) {
      this.startSideEffectRunner(effect.kind);
    }
  }
  private startSideEffectRunner(kind: SettingsSideEffect["kind"]): void {
    this.runningEffectKinds.add(kind);
    const runner = Promise.resolve()
      .then(() => this.drainSideEffects(kind))
      .then(
        () => undefined,
        () => undefined,
      );
    this.pendingEffects.add(runner);
    void runner.then(() => {
      this.pendingEffects.delete(runner);
      this.runningEffectKinds.delete(kind);
      // An intent can arrive after the drain loop observes an empty map but
      // before its completion microtask runs. Restart rather than strand it.
      if (this.requestedEffects.has(kind)) this.startSideEffectRunner(kind);
    });
  }
  private async drainSideEffects(
    kind: SettingsSideEffect["kind"],
  ): Promise<void> {
    while (true) {
      const requested = this.requestedEffects.get(kind);
      if (!requested) return;
      this.requestedEffects.delete(kind);
      if (!this.isCurrent(requested.scope, requested.revision)) continue;
      try {
        const effect = requested.effect;
        if (effect.kind === "language") {
          await (() =>
            this.dependencies.changeLanguage(
              effect.language,
              requested.phase,
            ))();
        } else {
          await (() =>
            this.dependencies.setReminderMasterEnabled(
              effect.enabled,
              requested.phase,
            ))();
        }
        const failed = this.failedEffects.get(kind);
        if (failed?.revision === requested.revision) {
          this.failedEffects.delete(kind);
        }
      } catch (error) {
        if (
          this.isCurrent(requested.scope, requested.revision) &&
          !this.requestedEffects.has(kind)
        ) {
          this.failedEffects.set(kind, requested);
        }
        this.dependencies.onNativeEffectError(
          requested.effect.kind,
          requested.phase,
          error,
        );
      }
    }
  }
  private confirmCommittedValue<Scope extends SettingMutationScope>(
    scope: Scope,
    revision: number,
    value: SettingMutationValue<Scope>,
  ): void {
    const current = this.confirmedByScope.get(scope);
    if (current && revision < current.revision) return;
    this.confirmedByScope.set(scope, {
      revision,
      value: cloneMutationValue(scope, value),
    });
  }
  private hasDirtyColorStructure(): boolean {
    return COLOR_STRUCTURE_KEYS.some((key) => this.dirtyRepairsByKey.has(key));
  }
  private clearDirtyRepair(repair: RegisteredRepair): void {
    const [key] = repair.entry;
    if (this.dirtyRepairsByKey.get(key)?.token === repair.token) {
      this.dirtyRepairsByKey.delete(key);
    }
  }
  private rescheduleDirtyRepairsForScope(scope: SettingMutationScope): void {
    const repairs = [...this.dirtyRepairsByKey.values()].filter(({ scopes }) =>
      scopes.includes(scope),
    );
    if (repairs.length === 0) return;
    void this.scheduleRepair(repairs).catch(() => {
      // The user-facing mutation already reports the SQLite failure. Keep the
      // dirty records so a later successful intent/load can absorb the repair.
    });
  }
  private createResult<Scope extends SettingMutationScope>(
    scope: Scope,
    revision: number,
    status: SettingsMutationResult<Scope>["status"],
    error?: unknown,
  ): SettingsMutationResult<Scope> {
    return {
      status,
      revision,
      scope,
      isLatest: this.isCurrent(scope, revision),
      confirmedValue: this.getConfirmedValue(scope),
      ...(error === undefined ? {} : { error }),
    };
  }
  private isCurrent(scope: SettingMutationScope, revision: number): boolean {
    return this.latestRevisionByScope.get(scope) === revision;
  }
  private isDurableSequencePinned(sequence: number): boolean {
    return (
      this.activeDurableFence !== null &&
      sequence <= this.activeDurableFence.sequence
    );
  }
  private isDurableSequenceBlocked(sequence: number): boolean {
    return (
      this.activeDurableFence !== null &&
      sequence > this.activeDurableFence.sequence
    );
  }
  private isActiveDurableFence(fence: SettingsDurableFence): boolean {
    return (
      this.activeDurableFence?.id === fence.id &&
      this.activeDurableFence.sequence === fence.sequence
    );
  }
  private async waitForDurableGate(sequence: number): Promise<void> {
    while (this.isDurableSequenceBlocked(sequence)) {
      await new Promise<void>((resolve) => {
        this.durableGateWaiters.add(resolve);
      });
    }
  }
  private enqueueScope<Result>(
    scope: SettingMutationScope,
    task: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.scopeTails.get(scope) ?? Promise.resolve();
    const operation = previous.then(task, task);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.scopeTails.set(scope, tail);
    void tail.then(() => {
      if (this.scopeTails.get(scope) === tail) this.scopeTails.delete(scope);
    });
    return operation;
  }
  private trackDurable<Result>(
    sequence: number,
    promise: Promise<Result>,
  ): Promise<Result> {
    this.pending.add(promise);
    this.pendingByDurableSequence.set(sequence, promise);
    void promise.then(
      () => {
        this.pending.delete(promise);
        this.discardedDurableSequences.delete(sequence);
        if (this.pendingByDurableSequence.get(sequence) === promise) {
          this.pendingByDurableSequence.delete(sequence);
        }
      },
      () => {
        this.pending.delete(promise);
        this.discardedDurableSequences.delete(sequence);
        if (this.pendingByDurableSequence.get(sequence) === promise) {
          this.pendingByDurableSequence.delete(sequence);
        }
      },
    );
    return promise;
  }
}
