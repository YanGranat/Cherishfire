import { runtimeDb } from "@/db/runtime";
import type {
  PersistedSettingRow,
  SettingsRepositoryPort,
  SettingsWriteEntry,
} from "@/application/settings/settings-repository-port";
import {
  SQLITE_DELETE_BIND_CHUNK_SIZE,
  deleteSqliteRowsByValues,
} from "@/data/sqlite/chunked-delete";

async function readAll(): Promise<PersistedSettingRow[]> {
  return runtimeDb.getAll<PersistedSettingRow>(
    "SELECT key, value FROM settings",
  );
}

async function write(entries: readonly SettingsWriteEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const valuesSql = entries.map(() => "(?, ?)").join(", ");
  const params = entries.flatMap(([key, value]) => [
    key,
    JSON.stringify(value),
  ]);

  // One statement is atomic in SQLite and crosses the native bridge once.
  await runtimeDb.run(
    `INSERT INTO settings (key, value) VALUES ${valuesSql}
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    params,
  );
}

async function deleteKeys(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const deleteFrom = (
    executor: Parameters<typeof deleteSqliteRowsByValues>[0],
  ) =>
    deleteSqliteRowsByValues(
      executor,
      { table: "settings", column: "key" },
      keys,
    );
  if (keys.length <= SQLITE_DELETE_BIND_CHUNK_SIZE) {
    await deleteFrom(runtimeDb);
  } else {
    await runtimeDb.transaction(deleteFrom);
  }
}

export const settingsRepository: SettingsRepositoryPort = {
  readAll,
  write,
  delete: deleteKeys,
};
