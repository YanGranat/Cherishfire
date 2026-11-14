import {
  SettingsMutationCoordinator,
  createSettingsMutationSnapshot,
  type SettingsDurableFence,
  type SettingsDurableFenceReleaseMode,
} from "@/application/settings/settings-mutation-coordinator";
import type { PersistedSettingRow } from "@/application/settings/settings-repository-port";
import {
  clampDescriptionVisibleLines,
  getHabitDescriptionLinesScope,
} from "@/application/settings/habit-description-lines-setting";
import { settingsRepository } from "@/data/sqlite/settings-repository";
import { persistenceCommitScheduler } from "@/composition/persistence";
import i18n from "@/i18n/config";
import { DEFAULT_SETTINGS } from "@/types/settings";
import {
  scheduleReminderNotificationLocalizationRefresh,
  setReminderNotificationsEnabled as setReminderNotificationsMasterEnabled,
} from "@/composition/reminders";
import { runAfterUiSettles } from "@/utils/ui-scheduling";

function changeI18nLanguageInCurrentTurn(language: string): Promise<void> {
  const change = i18n.changeLanguage(language);
  return Promise.resolve(change).then(() => {
    // Register accepted native work before the settings effect settles.
    scheduleReminderNotificationLocalizationRefresh();
  });
}

export const settingsMutationCoordinator = new SettingsMutationCoordinator(
  {
    write: (entries) => settingsRepository.write(entries),
    delete: (keys) => settingsRepository.delete(keys),
    waitForCommitOpportunity: () =>
      persistenceCommitScheduler.waitForCommitOpportunity(),
    scheduleRepair: runAfterUiSettles,
    changeLanguage: changeI18nLanguageInCurrentTurn,
    setReminderMasterEnabled: (enabled, phase) =>
      setReminderNotificationsMasterEnabled(enabled, {
        requestPermission: enabled && phase === "apply",
      }),
    onNativeEffectError: (effect, phase, error) => {
      console.error(
        effect === "language"
          ? `Failed to ${phase} global language state`
          : phase === "rollback"
            ? "Failed to restore reminder notification state"
            : "Failed to refresh reminder notification state",
        error,
      );
    },
  },
  createSettingsMutationSnapshot(DEFAULT_SETTINGS),
);

export function readPersistedSettings(): Promise<PersistedSettingRow[]> {
  return settingsRepository.readAll();
}

export function readPersistedDescriptionVisibleLines(habitId: number): number {
  return settingsMutationCoordinator.readHabitDescriptionLines(habitId);
}

export function persistDescriptionVisibleLines(habitId: number, lines: number) {
  return settingsMutationCoordinator.submit({
    scope: getHabitDescriptionLinesScope(habitId),
    value: clampDescriptionVisibleLines(lines),
    operation: "set",
  }).completion;
}

/** Called only after the habit transaction has durably removed these rows. */
export function publishDeletedHabitDescriptionLines(
  habitIds: Iterable<number>,
): void {
  for (const submission of settingsMutationCoordinator.publishDeletedHabitDescriptionLines(
    habitIds,
  )) {
    void submission.completion.then((result) => {
      if (result.status === "failed") {
        console.error(
          "Failed to finish deleted habit description cleanup",
          result.error,
        );
      }
    });
  }
}

export function clearHabitDescriptionLinesCache(): void {
  settingsMutationCoordinator.clearHabitDescriptionLinesCache();
}

export function getResolvedSettingsLanguage(): string {
  return i18n.resolvedLanguage ?? i18n.language;
}

export async function applyLoadedSettingsLanguage(
  language: string,
): Promise<void> {
  await i18n.changeLanguage(language);
}

/** Registers all platform work implied by a newly published SQLite snapshot. */
export function registerLoadedSettingsPlatformEffects(): void {
  scheduleReminderNotificationLocalizationRefresh();
  settingsMutationCoordinator.reconcileConfirmedSideEffect(
    "reminderNotifications",
  );
}

/** Re-admits only the latest dormant native effect after foreground resume. */
export function retryFailedSettingsPlatformEffects(): void {
  settingsMutationCoordinator.retryFailedSideEffects();
}

/** Exact data-transfer cutoff: later settings intents cannot extend it. */
export function capturePendingSettingsWriteFence(): SettingsDurableFence {
  return settingsMutationCoordinator.captureDurableFence();
}

export async function waitForPendingSettingsWritesThrough(
  fence: SettingsDurableFence,
): Promise<void> {
  await settingsMutationCoordinator.whenDurableThrough(fence);
}

export function releasePendingSettingsWriteFence(
  fence: SettingsDurableFence,
  mode: SettingsDurableFenceReleaseMode,
): void {
  settingsMutationCoordinator.releaseDurableFence(fence, mode);
}

/** Import/reset barrier for in-flight i18n and reminder reconciliation. */
export async function waitForAllPendingSettingsEffects(): Promise<void> {
  await settingsMutationCoordinator.whenEffectsIdle();
}
