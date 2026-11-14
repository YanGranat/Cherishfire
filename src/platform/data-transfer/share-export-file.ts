export interface PreparedExportFile {
  readonly fileName: string;
  readonly filePath: string;
}

/** Native file/share adapter; it contains no schema or database decisions. */
export async function prepareExportFile(
  fileName: string,
  json: string,
): Promise<PreparedExportFile> {
  const FileSystem = await import("expo-file-system/legacy");
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) {
    throw new Error("FileSystem cache directory is unavailable");
  }
  const filePath = `${cacheDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(filePath, json);
  return { fileName, filePath };
}

export async function sharePreparedExportFile(
  file: PreparedExportFile,
): Promise<void> {
  const Sharing = await import("expo-sharing");
  const request = Sharing.shareAsync(file.filePath, {
    mimeType: "application/json",
    dialogTitle: file.fileName,
    UTI: "public.json",
  });
  await request;
}
