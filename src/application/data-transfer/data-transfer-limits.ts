/**
 * A Cherishfire export is plain JSON and normally remains far below this
 * boundary. The generous cap still accommodates years of dense history while
 * preventing an arbitrary external file from being read and expanded into an
 * unbounded JavaScript object graph on a phone.
 */
export const MAX_DATA_TRANSFER_IMPORT_BYTES = 64 * 1024 * 1024;

export class DataTransferImportSizeError extends Error {
  constructor(
    readonly actualBytes: number,
    readonly maximumBytes = MAX_DATA_TRANSFER_IMPORT_BYTES,
  ) {
    super("Import file exceeds the supported size limit");
    this.name = "DataTransferImportSizeError";
  }
}

export class DataTransferImportSizeUnavailableError extends Error {
  constructor() {
    super("Import file size could not be determined safely");
    this.name = "DataTransferImportSizeUnavailableError";
  }
}

export interface DataTransferImportTextSource {
  /** Returns the byte length without loading the file contents into JS. */
  getByteLength(): number | null | undefined;
  readText(): Promise<string>;
}

export function assertDataTransferImportByteLength(byteLength: number): void {
  if (
    !Number.isFinite(byteLength) ||
    byteLength < 0 ||
    byteLength > MAX_DATA_TRANSFER_IMPORT_BYTES
  ) {
    throw new DataTransferImportSizeError(byteLength);
  }
}

/**
 * Counts UTF-8 bytes without allocating a second full-sized encoded buffer.
 * The scan stops as soon as the cap is exceeded.
 */
export function assertDataTransferImportTextSize(text: string): number {
  let byteLength = 0;

  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < text.length
    ) {
      const nextCodeUnit = text.charCodeAt(index + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        byteLength += 4;
        index += 1;
      } else {
        // Text encoders replace an unpaired surrogate with U+FFFD.
        byteLength += 3;
      }
    } else {
      byteLength += 3;
    }

    if (byteLength > MAX_DATA_TRANSFER_IMPORT_BYTES) {
      throw new DataTransferImportSizeError(byteLength);
    }
  }

  return byteLength;
}

/**
 * Admits a file by metadata before allowing its contents into JS memory, then
 * verifies the decoded UTF-8 size as a second boundary against bad metadata.
 */
export async function readBoundedDataTransferImportText(
  source: DataTransferImportTextSource,
): Promise<{ readonly text: string; readonly byteLength: number }> {
  const declaredByteLength = source.getByteLength();
  if (declaredByteLength == null) {
    throw new DataTransferImportSizeUnavailableError();
  }

  assertDataTransferImportByteLength(declaredByteLength);
  const text = await source.readText();
  return {
    text,
    byteLength: assertDataTransferImportTextSize(text),
  };
}
