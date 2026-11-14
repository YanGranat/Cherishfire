import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

import { readBoundedDataTransferImportText } from "@/application/data-transfer/data-transfer-limits";

export type DataTransferImportFileSelection =
  | {
      readonly status: "cancelled";
    }
  | {
      readonly status: "selected";
      readonly text: string;
    };

export type DataTransferImportFileFailurePhase =
  | "request"
  | "picker-return"
  | "file-read";

class DataTransferImportFileError extends Error {
  constructor(
    readonly phase: DataTransferImportFileFailurePhase,
    readonly originalError: unknown,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : "Failed to select import file",
    );
    this.name = "DataTransferImportFileError";
  }
}

export interface DataTransferImportFileFailure {
  readonly phase: DataTransferImportFileFailurePhase;
  readonly originalError: unknown;
}

export function getDataTransferImportFileFailure(
  error: unknown,
): DataTransferImportFileFailure | null {
  return error instanceof DataTransferImportFileError
    ? {
        phase: error.phase,
        originalError: error.originalError,
      }
    : null;
}

/**
 * Starts the native picker synchronously so the caller's confirmation turn is
 * the real handoff boundary. Presentation receives text/cancellation or a
 * typed failure without owning the native request lifecycle.
 */
export function selectDataTransferImportFile(): Promise<DataTransferImportFileSelection> {
  let pickerRequest: ReturnType<typeof DocumentPicker.getDocumentAsync>;
  try {
    pickerRequest = DocumentPicker.getDocumentAsync({
      // Cloud and messaging providers frequently expose JSON as text/plain or
      // application/octet-stream. The codec, not provider MIME metadata, is
      // the authority that decides whether this is a Cherishfire export.
      type: "*/*",
      copyToCacheDirectory: true,
      multiple: false,
    });
  } catch (error) {
    throw new DataTransferImportFileError("request", error);
  }

  const completeSelection =
    async (): Promise<DataTransferImportFileSelection> => {
      let pickerReturned = false;
      try {
        const result = await pickerRequest;
        pickerReturned = true;
        if (result.canceled || !result.assets || result.assets.length === 0) {
          return { status: "cancelled" };
        }

        const asset = result.assets[0];
        const file = new File(asset.uri);
        const { text } = await readBoundedDataTransferImportText({
          getByteLength: () => {
            const fileInfo = file.info();
            return fileInfo.exists ? fileInfo.size : null;
          },
          readText: () => file.text(),
        });
        return { status: "selected", text };
      } catch (error) {
        throw new DataTransferImportFileError(
          pickerReturned ? "file-read" : "picker-return",
          error,
        );
      }
    };

  return completeSelection();
}
