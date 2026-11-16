import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { dayRecords, habits, notes, settings } from "../src/db/schema";
import { createSerialTaskQueue } from "../src/utils/serial-task-queue";
import { withAuditDeadline } from "./fixtures/with-audit-deadline";
const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOTS = [path.join(ROOT, "app"), path.join(ROOT, "src")];
const ALLOWED_CLIENT_IMPORTS = new Set([
  path.join(ROOT, "src", "db", "runtime.ts"),
  path.join(
    ROOT,
    "src",
    "platform",
    "database",
    "use-app-database-migrations.ts",
  ),
]);
const ALLOWED_SYNC_SQLITE = new Set([
  path.join(ROOT, "src", "db", "client.ts"),
]);
const ZERO_SNAPSHOT_ID = "00000000-0000-0000-0000-000000000000";
type MigrationJournal = {
  entries: Array<{
    idx: number;
    tag: string;
  }>;
};
type MigrationSnapshot = {
  id: string;
  prevId: string;
  tables: Record<string, MigrationSnapshotTable>;
};
type MigrationSnapshotTable = {
  columns: Record<
    string,
    {
      name: string;
      type: string;
      primaryKey: boolean;
      notNull: boolean;
      autoincrement: boolean;
      default?: unknown;
    }
  >;
  indexes: Record<
    string,
    {
      name: string;
      columns: string[];
      isUnique: boolean;
    }
  >;
  foreignKeys: Record<
    string,
    {
      name: string;
      tableFrom: string;
      tableTo: string;
      columnsFrom: string[];
      columnsTo: string[];
      onDelete: string;
      onUpdate: string;
    }
  >;
  compositePrimaryKeys: Record<string, unknown>;
  uniqueConstraints: Record<string, unknown>;
  checkConstraints: Record<string, unknown>;
};
const sqliteDialect = new SQLiteSyncDialect();
function getSchemaDefault(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  return sqliteDialect.sqlToQuery(
    value as Parameters<typeof sqliteDialect.sqlToQuery>[0],
  ).sql;
}
function collectSourceFiles(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(absolutePath);
    return /\.(ts|tsx)$/.test(entry.name) ? [absolutePath] : [];
  });
}
function auditDatabaseOwnership(): void {
  const violations: string[] = [];
  for (const filePath of SOURCE_ROOTS.flatMap(collectSourceFiles)) {
    const source = fs.readFileSync(filePath, "utf8");
    const importsDatabaseClient = /(?:@\/db\/client|["']\.\/client["'])/.test(
      source,
    );
    if (importsDatabaseClient && !ALLOWED_CLIENT_IMPORTS.has(filePath)) {
      violations.push(
        `${path.relative(ROOT, filePath)} bypasses the async runtime database`,
      );
    }
    const usesSyncSqlite =
      /\.(?:execSync|getFirstSync|getAllSync|runSync|prepareSync)\s*\(/.test(
        source,
      );
    if (usesSyncSqlite && !ALLOWED_SYNC_SQLITE.has(filePath)) {
      violations.push(
        `${path.relative(ROOT, filePath)} performs synchronous SQLite work at runtime`,
      );
    }
    const importsRuntimeDrizzle =
      /from\s+["']drizzle-orm(?:\/expo-sqlite)?["']/.test(source);
    const isSchema = filePath === path.join(ROOT, "src", "db", "schema.ts");
    const isClient = filePath === path.join(ROOT, "src", "db", "client.ts");
    if (importsRuntimeDrizzle && !isSchema && !isClient) {
      violations.push(
        `${path.relative(ROOT, filePath)} reintroduces the synchronous Drizzle runtime driver`,
      );
    }
  }
  assert.deepEqual(violations, []);
  const clientSource = fs.readFileSync(
    path.join(ROOT, "src", "db", "client.ts"),
    "utf8",
  );
  const runtimeSource = fs.readFileSync(
    path.join(ROOT, "src", "db", "runtime.ts"),
    "utf8",
  );
  assert.match(
    clientSource,
    /PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON/,
    "the single runtime connection must keep WAL and foreign keys enabled",
  );
  assert.match(
    runtimeSource,
    /transaction<T>[\s\S]{0,180}return queue\.run\(async \(\) => \{[\s\S]{0,180}withTransactionAsync/,
    "transactions must own the serial queue for their full lifetime",
  );
  assert.match(
    runtimeSource,
    /result = await task\(\{ \.\.\.directExecutor \}\)/,
    "transaction callbacks must use the direct executor without re-entering the queue",
  );
  assert.doesNotMatch(
    runtimeSource,
    /withExclusiveTransactionAsync/,
    "the exclusive connection can lose connection-local foreign-key configuration",
  );
}
function auditMigrationMetadata(): void {
  const drizzleRoot = path.join(ROOT, "drizzle");
  const journal = JSON.parse(
    fs.readFileSync(path.join(drizzleRoot, "meta", "_journal.json"), "utf8"),
  ) as MigrationJournal;
  assert.ok(
    journal.entries.length > 0,
    "the migration journal must not be empty",
  );
  const snapshots = journal.entries.map((entry) => {
    const prefix = String(entry.idx).padStart(4, "0");
    const migrationPath = path.join(drizzleRoot, `${entry.tag}.sql`);
    const snapshotPath = path.join(
      drizzleRoot,
      "meta",
      `${prefix}_snapshot.json`,
    );
    assert.ok(
      fs.existsSync(migrationPath),
      `journal entry ${entry.tag} must have a SQL migration`,
    );
    assert.ok(
      fs.existsSync(snapshotPath),
      `journal entry ${entry.tag} must have a schema snapshot`,
    );
    return JSON.parse(
      fs.readFileSync(snapshotPath, "utf8"),
    ) as MigrationSnapshot;
  });
  snapshots.forEach((snapshot, index) => {
    assert.equal(
      snapshot.prevId,
      index === 0 ? ZERO_SNAPSHOT_ID : snapshots[index - 1]?.id,
      `snapshot ${index} must form an unbroken history chain`,
    );
  });
  const latestSnapshot = snapshots.at(-1);
  assert.ok(latestSnapshot, "the latest migration snapshot must exist");
  const schemaTables = [habits, dayRecords, notes, settings];
  assert.deepEqual(
    Object.keys(latestSnapshot.tables).sort(),
    schemaTables.map((table) => getTableConfig(table).name).sort(),
    "latest migration snapshot table set must exactly match src/db/schema.ts",
  );
  for (const table of schemaTables) {
    const config = getTableConfig(table);
    const snapshotTable: MigrationSnapshotTable | undefined =
      latestSnapshot.tables[config.name];
    assert.ok(
      snapshotTable,
      `latest migration snapshot must contain table ${config.name}`,
    );
    const schemaColumns = Object.fromEntries(
      config.columns.map((column) => [
        column.name,
        {
          name: column.name,
          type: column.getSQLType(),
          primaryKey: column.primary,
          notNull: column.notNull,
          autoincrement:
            "autoIncrement" in column && column.autoIncrement === true,
          ...(column.default === undefined
            ? {}
            : { default: getSchemaDefault(column.default) }),
        },
      ]),
    );
    assert.deepEqual(
      snapshotTable.columns,
      schemaColumns,
      `latest migration snapshot column definitions must match src/db/schema.ts for ${config.name}`,
    );
    const schemaIndexes = Object.fromEntries(
      config.indexes.map((index) => [
        index.config.name,
        {
          name: index.config.name,
          columns: index.config.columns.map((column) => {
            assert.ok(
              "name" in column && typeof column.name === "string",
              `snapshot audit does not support SQL-expression index columns in ${index.config.name}`,
            );
            return column.name;
          }),
          isUnique: index.config.unique,
        },
      ]),
    );
    assert.deepEqual(
      snapshotTable.indexes,
      schemaIndexes,
      `latest migration snapshot indexes must match src/db/schema.ts for ${config.name}`,
    );
    const schemaForeignKeys = Object.fromEntries(
      config.foreignKeys.map((foreignKey) => {
        const reference = foreignKey.reference();
        const name = foreignKey.getName();
        return [
          name,
          {
            name,
            tableFrom: config.name,
            tableTo: getTableConfig(reference.foreignTable).name,
            columnsFrom: reference.columns.map((column) => column.name),
            columnsTo: reference.foreignColumns.map((column) => column.name),
            onDelete: foreignKey.onDelete ?? "no action",
            onUpdate: foreignKey.onUpdate ?? "no action",
          },
        ];
      }),
    );
    assert.deepEqual(
      snapshotTable.foreignKeys,
      schemaForeignKeys,
      `latest migration snapshot foreign keys must match src/db/schema.ts for ${config.name}`,
    );
    assert.deepEqual(
      {
        compositePrimaryKeys: snapshotTable.compositePrimaryKeys,
        uniqueConstraints: snapshotTable.uniqueConstraints,
        checkConstraints: snapshotTable.checkConstraints,
      },
      {
        compositePrimaryKeys:
          config.primaryKeys.length === 0 ? {} : "unsupported-schema-shape",
        uniqueConstraints:
          config.uniqueConstraints.length === 0
            ? {}
            : "unsupported-schema-shape",
        checkConstraints:
          config.checks.length === 0 ? {} : "unsupported-schema-shape",
      },
      `latest migration snapshot ancillary constraints must match src/db/schema.ts for ${config.name}; extend the canonicalizer before adding a new constraint kind`,
    );
  }
}
async function auditSerialQueue(): Promise<void> {
  const queue = createSerialTaskQueue();
  const order: string[] = [];
  let releaseFirst: () => void = () => {
    throw new Error("the active task has not exposed its test release");
  };
  let firstReleaseReady = false;
  let firstStartedSynchronously = false;
  const first = queue.run(async () => {
    firstStartedSynchronously = true;
    order.push("first:start");
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
      firstReleaseReady = true;
    });
    order.push("first:end");
    return 1;
  });
  assert.equal(
    firstStartedSynchronously,
    true,
    "an idle queue must start work in the submitting turn",
  );
  const failed = queue.run(async () => {
    order.push("failed:start");
    throw new Error("expected test failure");
  });
  const last = queue.run(async () => {
    order.push("last:start");
    order.push("last:end");
    return 3;
  });
  let idleResolved = false;
  const idle = queue.whenIdle().then(() => {
    idleResolved = true;
  });
  await Promise.resolve();
  assert.equal(
    idleResolved,
    false,
    "whenIdle must wait for the active task and every queued successor",
  );
  assert.deepEqual(
    order,
    ["first:start"],
    "queued tasks must not overlap the active task",
  );
  assert.equal(
    firstReleaseReady,
    true,
    "the active task must expose its test release",
  );
  releaseFirst();
  assert.equal(await first, 1);
  await assert.rejects(failed, /expected test failure/);
  assert.equal(await last, 3);
  await idle;
  assert.equal(idleResolved, true);
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "failed:start",
    "last:start",
    "last:end",
  ]);
  let syncThrowStarted = false;
  const syncFailure = queue.run((() => {
    syncThrowStarted = true;
    throw new Error("expected synchronous failure");
  }) as () => Promise<never>);
  assert.equal(
    syncThrowStarted,
    true,
    "synchronously throwing work must still use the idle fast path",
  );
  await assert.rejects(syncFailure, /expected synchronous failure/);
  const recovery = queue.run(async () => "recovered");
  assert.equal(await recovery, "recovered");
  await queue.whenIdle();
}
async function auditDatabaseFacade(sourceOverride?: string): Promise<void> {
  const source =
    sourceOverride ??
    fs.readFileSync(path.join(ROOT, "src/db/runtime.ts"), "utf8");
  const calls: string[] = [];
  let transactionActive = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor = {
    async runAsync(sql: string, params: unknown[]) {
      calls.push(`${transactionActive ? "tx" : "outside"}:run:${sql}`);
      assert.deepEqual([...params], sql === "first" ? [7] : []);
      return { changes: 1, lastInsertRowId: 7 };
    },
    async getFirstAsync(sql: string, params: unknown[]) {
      calls.push(`${transactionActive ? "tx" : "outside"}:first:${sql}`);
      assert.deepEqual([...params], []);
      return { value: 1 };
    },
    async getAllAsync(sql: string, params: unknown[]) {
      calls.push(`${transactionActive ? "tx" : "outside"}:all:${sql}`);
      assert.deepEqual([...params], []);
      return [{ value: 1 }];
    },
    async withTransactionAsync(task: () => Promise<void>) {
      assert.equal(transactionActive, false, "transactions must not overlap");
      transactionActive = true;
      calls.push("tx:start");
      try {
        await task();
        calls.push("tx:commit");
      } catch (error) {
        calls.push("tx:rollback");
        throw error;
      } finally {
        transactionActive = false;
      }
    },
  };
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const exported: Record<string, unknown> = {};
  runInNewContext(output.outputText, {
    exports: exported,
    require(request: string) {
      if (request === "./client") return { expoDb: executor };
      if (request === "@/utils/serial-task-queue")
        return { createSerialTaskQueue };
      throw new Error(`Unexpected database facade dependency: ${request}`);
    },
  });
  const db = exported.runtimeDb as {
    run(sql: string, params?: unknown[]): Promise<unknown>;
    getFirst(sql: string): Promise<unknown>;
    getAll(sql: string): Promise<unknown>;
    transaction<T>(
      task: (tx: {
        run(sql: string, params?: unknown[]): Promise<unknown>;
        getFirst(sql: string): Promise<unknown>;
      }) => Promise<T>,
    ): Promise<T>;
    whenIdle(): Promise<void>;
  };
  const transaction = db.transaction(async (tx) => {
    assert.notEqual(tx, db, "transaction callbacks must use a direct executor");
    await tx.run("first", [7]);
    await gate;
    await tx.getFirst("second");
    return "committed";
  });
  const outside = [
    db.run("queued"),
    db.getFirst("queued"),
    db.getAll("queued"),
  ];
  let idle = false;
  const idleRequest = db.whenIdle().then(() => {
    idle = true;
  });
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  assert.deepEqual(
    calls,
    ["tx:start", "tx:run:first"],
    "queued statements must not enter the transaction",
  );
  assert.equal(
    idle,
    false,
    "whenIdle must include the active transaction and queued reads",
  );
  release();
  assert.equal(await transaction, "committed");
  await Promise.all(outside);
  await idleRequest;
  assert.deepEqual(calls, [
    "tx:start",
    "tx:run:first",
    "tx:first:second",
    "tx:commit",
    "outside:run:queued",
    "outside:first:queued",
    "outside:all:queued",
  ]);
  const failure = new Error("Synthetic transaction failure");
  await assert.rejects(
    db.transaction(async () => {
      throw failure;
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(calls.at(-1), "tx:rollback");
  await db.run("recovery");
  await db.whenIdle();
  assert.equal(calls.at(-1), "outside:run:recovery");
  await db.transaction(async (tx) => {
    tx.run = async () => ({ changes: 0, lastInsertRowId: -1 });
  });
  const isolatedResult = await db.run("isolated");
  assert.deepEqual(
    { ...(isolatedResult as object) },
    { changes: 1, lastInsertRowId: 7 },
    "transaction-local executor changes must not alter the database facade",
  );
  assert.equal(calls.at(-1), "outside:run:isolated");
}

async function main(): Promise<void> {
  for (const [mode, expectedStatus, expectedOutput] of [
    ["resolve", 0, /Worker audit completed\./],
    ["reject", 1, /Rejected audit task/],
    ["throw", 1, /Thrown audit task/],
    ["pending", 1, /Worker audit did not reach completion/],
  ] as const) {
    const worker = spawnSync(
      process.execPath,
      [...process.execArgv, path.join(ROOT, "scripts/fixtures/async-audit-worker.ts"), mode],
      { cwd: ROOT, encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(worker.error, undefined);
    assert.equal(worker.status, expectedStatus, `${mode}: ${worker.stderr}`);
    assert.match(worker.stdout + worker.stderr, expectedOutput);
    if (mode !== "resolve") {
      assert.doesNotMatch(worker.stdout, /Worker audit completed\./);
    }
  }
  auditDatabaseOwnership();
  auditMigrationMetadata();
  await auditSerialQueue();
  await auditDatabaseFacade();
  const source = fs.readFileSync(path.join(ROOT, "src/db/runtime.ts"), "utf8");
  for (const [label, before, after] of [
    [
      "read-escapes-transaction",
      "return queue.run(() => directExecutor.getFirst<T>(sql, params));",
      "return directExecutor.getFirst<T>(sql, params);",
    ],
    [
      "transaction-boundary-removed",
      /await expoDb\.withTransactionAsync\(async \(\) => \{\s*result = await task\(\{ \.\.\.directExecutor \}\);\s*\}\);/,
      "result = await task({ ...directExecutor });",
    ],
    [
      "transaction-executor-shared",
      "task({ ...directExecutor })",
      "task(directExecutor)",
    ],
  ]) {
    assert.ok(
      typeof before === "string"
        ? source.includes(before)
        : before.test(source),
      `${label} mutation target must exist`,
    );
    let failure: unknown;
    try {
      await auditDatabaseFacade(source.replace(before, after as string));
    } catch (error) {
      failure = error;
    }
    assert.ok(
      failure instanceof assert.AssertionError,
      `${label} must fail at a behavioral assertion`,
    );
    assert.match(
      failure.message,
      /queued statements must not enter|whenIdle|Expected values|transaction-local executor/,
    );
  }
  console.log("Database runtime audit passed.");
}
void withAuditDeadline(main, "Database runtime audit").catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
