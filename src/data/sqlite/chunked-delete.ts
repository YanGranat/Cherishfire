import type { SQLiteBindValue } from "expo-sqlite";

export const SQLITE_DELETE_BIND_CHUNK_SIZE = 400;

export interface SqliteDeleteExecutor {
  run(sql: string, params?: SQLiteBindValue[]): Promise<unknown>;
}

export type SqliteDeleteTarget =
  | { readonly table: "day_records" | "notes" | "habits"; readonly column: "id" }
  | { readonly table: "settings"; readonly column: "key" };

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Keeps every statement below the conservative SQLite bind-variable budget.
 * Callers that need atomicity own the surrounding transaction; chunking does
 * not create or commit an independent transaction.
 */
export async function deleteSqliteRowsByValues(
  executor: SqliteDeleteExecutor,
  target: SqliteDeleteTarget,
  values: readonly SQLiteBindValue[],
): Promise<void> {
  for (
    let offset = 0;
    offset < values.length;
    offset += SQLITE_DELETE_BIND_CHUNK_SIZE
  ) {
    const chunk = values.slice(offset, offset + SQLITE_DELETE_BIND_CHUNK_SIZE);
    await executor.run(
      `DELETE FROM ${target.table} WHERE ${target.column} IN (${placeholders(chunk.length)})`,
      [...chunk],
    );
  }
}
