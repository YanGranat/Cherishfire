import type { SQLiteBindParams, SQLiteRunResult } from "expo-sqlite";
import { expoDb } from "./client";
import { createSerialTaskQueue } from "@/utils/serial-task-queue";

export interface AsyncDatabaseExecutor {
  run(sql: string, params?: SQLiteBindParams): Promise<SQLiteRunResult>;
  getFirst<T>(sql: string, params?: SQLiteBindParams): Promise<T | null>;
  getAll<T>(sql: string, params?: SQLiteBindParams): Promise<T[]>;
}
interface AsyncDatabase extends AsyncDatabaseExecutor {
  transaction<T>(
    task: (transaction: AsyncDatabaseExecutor) => Promise<T>,
  ): Promise<T>;
  whenIdle(): Promise<void>;
}
const queue = createSerialTaskQueue();
function bind(params: SQLiteBindParams | undefined): SQLiteBindParams {
  return params ?? [];
}
const directExecutor: AsyncDatabaseExecutor = {
  run(sql, params) {
    return expoDb.runAsync(sql, bind(params));
  },
  getFirst<T>(sql: string, params?: SQLiteBindParams) {
    return expoDb.getFirstAsync<T>(sql, bind(params));
  },
  getAll<T>(sql: string, params?: SQLiteBindParams) {
    return expoDb.getAllAsync<T>(sql, bind(params));
  },
};
/**
 * Expo's async transactions share their connection with surrounding queries.
 * Keep every operation in one queue, with a direct executor inside transactions
 * so nested statements cannot re-enqueue behind their own transaction.
 */
export const runtimeDb: AsyncDatabase = {
  run(sql, params) {
    return queue.run(() => directExecutor.run(sql, params));
  },
  getFirst<T>(sql: string, params?: SQLiteBindParams) {
    return queue.run(() => directExecutor.getFirst<T>(sql, params));
  },
  getAll<T>(sql: string, params?: SQLiteBindParams) {
    return queue.run(() => directExecutor.getAll<T>(sql, params));
  },
  transaction<T>(task: (transaction: AsyncDatabaseExecutor) => Promise<T>) {
    return queue.run(async () => {
      let result!: T;
      await expoDb.withTransactionAsync(async () => {
        result = await task({ ...directExecutor });
      });
      return result;
    });
  },
  whenIdle() {
    return queue.whenIdle();
  },
};
