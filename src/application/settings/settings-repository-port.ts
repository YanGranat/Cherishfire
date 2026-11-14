export interface PersistedSettingRow {
  readonly key: string;
  readonly value: string;
}

export type SettingsWriteEntry = readonly [key: string, value: unknown];

/** Inward persistence contract implemented by the SQLite adapter. */
export interface SettingsRepositoryPort {
  readAll(): Promise<PersistedSettingRow[]>;
  write(entries: readonly SettingsWriteEntry[]): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
}
