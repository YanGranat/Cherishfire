import {
  DataTransferCoordinator,
  bindDurableMutationFenceOwner,
  createCompositeDurableMutationFencePort,
  type DurableMutationFencePort,
} from "@/application/data-transfer/data-transfer-coordinator";
import type {
  DataTransferRows,
  NormalizedImportData,
} from "@/application/data-transfer/data-transfer-model";
import {
  DataTransferService,
  type ImportDataResult,
  type PublishImportedSnapshot,
} from "@/application/data-transfer/data-transfer-service";
import {
  capturePendingHabitWriteFence,
  releasePendingHabitWriteFence,
  waitForPendingHabitWritesThrough,
  type PendingHabitWriteFence,
} from "@/application/habits/habit-write-fence";
import {
  capturePendingNotesWriteFence,
  releasePendingNotesWriteFence,
  waitForPendingNotesWritesThrough,
  type PendingNotesWriteFence,
} from "@/application/notes/notes-cache";
import type { SettingsDurableFence } from "@/application/settings/settings-mutation-coordinator";
import {
  capturePendingSettingsWriteFence,
  releasePendingSettingsWriteFence,
  waitForAllPendingSettingsEffects,
  waitForPendingSettingsWritesThrough,
} from "@/composition/settings";
import { sqliteDataTransferRepository } from "@/data/sqlite/data-transfer-repository";
import {
  prepareExportFile,
  sharePreparedExportFile,
  type PreparedExportFile,
} from "@/platform/data-transfer/share-export-file";
import {
  getDataTransferImportFileFailure,
  selectDataTransferImportFile as selectNativeDataTransferImportFile,
  type DataTransferImportFileFailure,
  type DataTransferImportFileSelection,
} from "@/platform/data-transfer/select-import-file";
import {
  flushAndFreezePendingReminderWork,
  reconcileReminderNotificationsAfterImport,
} from "@/composition/reminders";

export {
  getDataTransferImportFileFailure,
  type DataTransferImportFileFailure,
  type DataTransferImportFileSelection,
};

const habitWrites: DurableMutationFencePort<PendingHabitWriteFence> = {
  capture: capturePendingHabitWriteFence,
  waitThrough: waitForPendingHabitWritesThrough,
  release(fence, outcome) {
    releasePendingHabitWriteFence(fence, {
      discardPostFence: outcome === "import-committed",
    });
  },
};

const notesWrites: DurableMutationFencePort<PendingNotesWriteFence> = {
  capture: capturePendingNotesWriteFence,
  waitThrough: waitForPendingNotesWritesThrough,
  release(fence, outcome) {
    releasePendingNotesWriteFence(fence, {
      discardPostFence: outcome === "import-committed",
    });
  },
};

const settingsWrites: DurableMutationFencePort<SettingsDurableFence> = {
  capture: capturePendingSettingsWriteFence,
  waitThrough: waitForPendingSettingsWritesThrough,
  release(fence, outcome) {
    releasePendingSettingsWriteFence(
      fence,
      outcome === "import-committed"
        ? "discard-post-cutoff"
        : "resume-post-cutoff",
    );
  },
};

const durableMutations = createCompositeDurableMutationFencePort([
  bindDurableMutationFenceOwner(habitWrites),
  bindDurableMutationFenceOwner(notesWrites),
  bindDurableMutationFenceOwner(settingsWrites),
]);

// This is the only runtime owner of export/import serialization and fences.
const dataTransferCoordinator = new DataTransferCoordinator(durableMutations);

function readConsistentDataTransferSnapshot(): Promise<DataTransferRows> {
  return dataTransferCoordinator.readExportSnapshot({
    readConsistentSnapshot: sqliteDataTransferRepository.readConsistentSnapshot,
  });
}

function replaceDataTransferSnapshot(
  data: NormalizedImportData,
  verifyRestoredRows: (rows: DataTransferRows) => void,
  publishCommittedSnapshot: () => Promise<void>,
) {
  return dataTransferCoordinator.replaceImportedData({
    waitForApplicationEffects: waitForDataTransferApplicationEffects,
    enterPlatformReplacementBoundary:
      enterDataTransferPlatformReplacementBoundary,
    async replaceAtomically() {
      await sqliteDataTransferRepository.replaceAndVerify(
        data,
        verifyRestoredRows,
      );
    },
    publishCommittedSnapshot,
    reconcileCommittedPlatformState:
      reconcileCommittedDataTransferPlatformState,
  });
}

async function waitForDataTransferApplicationEffects(): Promise<void> {
  await waitForAllPendingSettingsEffects();
}

async function enterDataTransferPlatformReplacementBoundary() {
  // Application effects can enqueue reminder work, so this remains a distinct
  // later stage. The returned boundary also blocks work accepted while the
  // imported database and in-memory snapshot are being replaced.
  const boundary = await flushAndFreezePendingReminderWork();
  return {
    release: boundary.release,
  };
}

async function reconcileCommittedDataTransferPlatformState(): Promise<void> {
  try {
    await reconcileReminderNotificationsAfterImport();
  } catch {
    // The database and in-memory generation are already authoritative. Native
    // notification repair is best-effort. The reminder service retains the
    // required authoritative read and retries it on later work or foreground.
  }
}

const dataTransferService = new DataTransferService<PreparedExportFile>({
  readConsistentSnapshot: readConsistentDataTransferSnapshot,
  replaceSnapshot: replaceDataTransferSnapshot,
  prepareExport: prepareExportFile,
  sharePreparedExport: sharePreparedExportFile,
  now: () => new Date(),
});

let importFileSelectionInFlight: Promise<DataTransferImportFileSelection> | null =
  null;

/** Opens at most one native document picker for a rapid duplicate press. */
export function selectDataTransferImportFile(): Promise<DataTransferImportFileSelection> {
  if (importFileSelectionInFlight) return importFileSelectionInFlight;

  let request: Promise<DataTransferImportFileSelection>;
  try {
    request = selectNativeDataTransferImportFile();
  } catch (error) {
    return Promise.reject(error);
  }
  const tracked = request.finally(() => {
    if (importFileSelectionInFlight === tracked) {
      importFileSelectionInFlight = null;
    }
  });
  importFileSelectionInFlight = tracked;
  return tracked;
}

/** The application-facing export facade; its snapshot cutoff is captured now. */
export function exportAllData(): Promise<void> {
  return dataTransferService.exportAllData();
}

export function importNormalizedData(
  data: NormalizedImportData,
  publishImportedSnapshot: PublishImportedSnapshot,
): Promise<ImportDataResult> {
  return dataTransferService.importNormalizedData(
    data,
    publishImportedSnapshot,
  );
}
