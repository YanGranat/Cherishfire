import { format } from "date-fns/format";
import type { ImportReplacementOutcome } from "@/application/data-transfer/data-transfer-coordinator";
import {
  buildExportJsonFromRows,
  verifyRestoredImportRows,
} from "@/application/data-transfer/data-transfer-codec";
import type {
  DataTransferRows,
  NormalizedImportData,
} from "@/application/data-transfer/data-transfer-model";

export interface DataTransferServiceDependencies<PreparedExport> {
  /**
   * Calling this method must synchronously capture the exact durable-write
   * cutoff. The returned promise may wait for that cutoff asynchronously.
   */
  readConsistentSnapshot(): Promise<DataTransferRows>;
  replaceSnapshot(
    data: NormalizedImportData,
    verifyRestoredRows: (rows: DataTransferRows) => void,
    publishCommittedSnapshot: () => Promise<void>,
  ): Promise<ImportReplacementOutcome<void>>;
  prepareExport(fileName: string, json: string): Promise<PreparedExport>;
  sharePreparedExport(file: PreparedExport): Promise<void>;
  now(): Date;
}

export interface ImportPublicationBlockedResult {
  readonly success: false;
  readonly committed: true;
  readonly error: string;
  retryPublication(): Promise<void>;
}

export type ImportDataResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly committed?: false;
      readonly error: string;
    }
  | ImportPublicationBlockedResult;

export type PublishImportedSnapshot = () => Promise<void>;

/**
 * Application use cases for the complete export/import flow. SQLite, Expo
 * files and native sharing are supplied at composition.
 */
export class DataTransferService<PreparedExport> {
  private exportInFlight: Promise<void> | null = null;
  private importInFlight: {
    readonly data: NormalizedImportData;
    readonly promise: Promise<ImportDataResult>;
  } | null = null;

  constructor(
    private readonly dependencies: DataTransferServiceDependencies<PreparedExport>,
  ) {}

  exportAllData(): Promise<void> {
    // A rapid duplicate confirmation belongs to the already running export.
    // Coalescing avoids a second durable fence, file and native share sheet.
    if (this.exportInFlight) return this.exportInFlight;

    // Deliberately start the snapshot request before returning or awaiting.
    // This is the user-confirmation cutoff; a cold platform import may only
    // happen later, after the exact set of accepted writes is already pinned.
    const snapshotRequest = this.dependencies.readConsistentSnapshot();
    const request = this.completeExport(snapshotRequest);
    const tracked = request.finally(() => {
      if (this.exportInFlight === tracked) this.exportInFlight = null;
    });
    this.exportInFlight = tracked;
    return tracked;
  }

  private async completeExport(
    snapshotRequest: Promise<DataTransferRows>,
  ): Promise<void> {
    const rows = await snapshotRequest;
    const exportDate = this.dependencies.now();
    const json = buildExportJsonFromRows({
      habits: rows.habits,
      dayRecords: rows.dayRecords,
      notes: rows.notes,
      settings: rows.settings,
      exportedAt: exportDate.toISOString(),
    });
    const fileName = `cherishfire_export_${format(
      exportDate,
      "yyyy-MM-dd",
    )}.json`;
    const file = await this.dependencies.prepareExport(fileName, json);
    await this.dependencies.sharePreparedExport(file);
  }

  // Parsing and schema validation intentionally happen in the pure codec
  // before this use case is called and therefore before the import fence.
  importNormalizedData(
    data: NormalizedImportData,
    publishImportedSnapshot: PublishImportedSnapshot,
  ): Promise<ImportDataResult> {
    if (this.importInFlight) {
      if (this.importInFlight.data === data) {
        return this.importInFlight.promise;
      }
      return Promise.resolve({
        success: false,
        error: "Another data transfer is already in progress",
      });
    }
    const request = this.completeImport(data, publishImportedSnapshot);
    const tracked = request.finally(() => {
      if (this.importInFlight?.promise === tracked) this.importInFlight = null;
    });
    this.importInFlight = { data, promise: tracked };
    return tracked;
  }

  private async completeImport(
    data: NormalizedImportData,
    publishImportedSnapshot: PublishImportedSnapshot,
  ): Promise<ImportDataResult> {
    try {
      const outcome = await this.dependencies.replaceSnapshot(
        data,
        (restored) => verifyRestoredImportRows(data, restored),
        publishImportedSnapshot,
      );
      if (outcome.status === "publication-blocked") {
        return {
          success: false,
          committed: true,
          error:
            outcome.error instanceof Error
              ? outcome.error.message
              : "Imported data could not be loaded",
          retryPublication: outcome.retryPublication,
        };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Import failed",
      };
    }
  }
}
