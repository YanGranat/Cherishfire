import { useMigrations } from "drizzle-orm/expo-sqlite/migrator";
import { db } from "@/db/client";
import migrations from "../../../drizzle/migrations";

/** Keeps the Expo/Drizzle migration adapter out of the navigation shell. */
export function useAppDatabaseMigrations() {
  return useMigrations(db, migrations);
}
