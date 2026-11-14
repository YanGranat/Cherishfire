import * as SQLite from "expo-sqlite";
import { drizzle } from "drizzle-orm/expo-sqlite";
import * as schema from "./schema";

const DATABASE_NAME = "cherishfire.db";

// Open the database with change listener for live queries
const expo = SQLite.openDatabaseSync(DATABASE_NAME, {
  enableChangeListener: true,
});

// SQLite does not enforce declared foreign keys unless enabled per connection.
// This makes permanent habit deletion cascade to records and notes as designed.
expo.execSync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");

// Drizzle remains the schema/migration owner. Interactive runtime queries use
// the async facade in runtime.ts so SQLite work never blocks the JS thread.
export const db = drizzle(expo, { schema });

export { expo as expoDb };
