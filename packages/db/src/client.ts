import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Creates a Drizzle client. The URL is never logged or included in errors. */
export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const client = postgres(url);
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}
