import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { sqliteHabitRepository } from "../../src/data/sqlite/habit-repository";
import type { sqliteNoteRepository } from "../../src/data/sqlite/note-repository";
import type { sqliteDataTransferRepository } from "../../src/data/sqlite/data-transfer-repository";
import type { runtimeDb } from "../../src/db/runtime";

/** Actual SQL/runtime owners with an in-memory, number-shaped Expo boundary. */
export function loadSqliteRepositoriesForAudit() {
  const root = resolve(import.meta.dirname, "../..");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const journal = JSON.parse(readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  for (const entry of journal.entries.slice().sort((left, right) => left.idx - right.idx)) {
    database.exec(readFileSync(resolve(root, `drizzle/${entry.tag}.sql`), "utf8"));
  }
  const statement = (sql: string) => {
    const prepared = database.prepare(sql);
    prepared.setReadBigInts(true);
    return prepared;
  };
  const asNumberRow = <T>(row: Record<string, unknown> | undefined): T | null =>
    row ? Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key, typeof value === "bigint" ? Number(value) : value,
    ])) as T : null;
  const expo = {
    async runAsync(sql: string, params: SQLInputValue[]) {
      const result = statement(sql).run(...params);
      return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async getFirstAsync<T>(sql: string, params: SQLInputValue[]) {
      return asNumberRow<T>(statement(sql).get(...params));
    },
    async getAllAsync<T>(sql: string, params: SQLInputValue[]) {
      return statement(sql).all(...params).map((row) => asNumberRow<T>(row)!);
    },
    async withTransactionAsync(task: () => Promise<void>) {
      database.exec("BEGIN");
      try {
        await task();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const require = createRequire(import.meta.url);
  function load<T>(file: string, dependencies: Record<string, unknown>): T {
    const source = readFileSync(resolve(root, file), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const exports: Record<string, unknown> = {};
    runInNewContext(output.outputText, {
      exports,
      Date,
      require(request: string) {
        if (Object.hasOwn(dependencies, request)) return dependencies[request];
        if (request.startsWith("@/")) return require(resolve(root, "src", request.slice(2)));
        return require(request);
      },
    });
    return exports as T;
  }
  const runtime = load<{ runtimeDb: typeof runtimeDb }>("src/db/runtime.ts", { "./client": { expoDb: expo } }).runtimeDb;
  const dependencies = { "@/db/runtime": { runtimeDb: runtime } };
  const habits = load<{ sqliteHabitRepository: typeof sqliteHabitRepository }>("src/data/sqlite/habit-repository.ts", dependencies).sqliteHabitRepository;
  const notes = load<{ sqliteNoteRepository: typeof sqliteNoteRepository }>("src/data/sqlite/note-repository.ts", dependencies).sqliteNoteRepository;
  const transfers = load<{ sqliteDataTransferRepository: typeof sqliteDataTransferRepository }>("src/data/sqlite/data-transfer-repository.ts", dependencies).sqliteDataTransferRepository;
  return { database, runtime, habits, notes, transfers };
}
