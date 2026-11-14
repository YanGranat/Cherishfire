import type {
  DataTransferRows,
  NormalizedImportData,
} from "@/application/data-transfer/data-transfer-model";

/** SQLite-independent boundary used by the import/export application flow. */
export interface DataTransferRepository {
  readConsistentSnapshot(): Promise<DataTransferRows>;
  replaceAndVerify(
    data: NormalizedImportData,
    verifyRestoredRows: (rows: DataTransferRows) => void,
  ): Promise<void>;
}
