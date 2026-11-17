export interface ReminderSchedulingJournal {
  /** `null` requests scoped native recovery of an unreadable journal. */
  read(): Promise<readonly string[] | null>;
  write(identifiers: readonly string[]): Promise<void>;
}

interface ReminderJournalFileSystem {
  readonly documentDirectory: string | null;
  getInfoAsync(uri: string): Promise<{ exists: boolean; size?: number }>;
  readAsStringAsync(uri: string): Promise<string>;
  writeAsStringAsync(uri: string, value: string): Promise<void>;
}

const JOURNAL_FILE_NAME = "reminder-scheduling-journal.json";
const JOURNAL_MAX_BYTES = 128 * 1024;

export function createReminderSchedulingJournal(
  loadFileSystem: () => Promise<ReminderJournalFileSystem> = () =>
    import("expo-file-system/legacy"),
): ReminderSchedulingJournal {
  const getStorage = async () => {
    const fileSystem = await loadFileSystem();
    if (!fileSystem.documentDirectory) {
      throw new Error("Reminder journal storage is unavailable");
    }
    return {
      fileSystem,
      uri: `${fileSystem.documentDirectory}${JOURNAL_FILE_NAME}`,
    };
  };

  return {
    async read() {
      const { fileSystem, uri } = await getStorage();
      const info = await fileSystem.getInfoAsync(uri);
      if (!info.exists) return [];
      if (info.size != null && info.size > JOURNAL_MAX_BYTES) return null;
      const raw = await fileSystem.readAsStringAsync(uri);
      try {
        const value: unknown = JSON.parse(raw);
        if (
          !Array.isArray(value) ||
          value.length > 1024 ||
          !value.every(
            (identifier) =>
              typeof identifier === "string" &&
              identifier.length > 0 &&
              identifier.length <= 128,
          )
        ) {
          return null;
        }
        return [...new Set<string>(value)];
      } catch {
        return null;
      }
    },
    async write(identifiers) {
      const { fileSystem, uri } = await getStorage();
      await fileSystem.writeAsStringAsync(uri, JSON.stringify(identifiers));
    },
  };
}
