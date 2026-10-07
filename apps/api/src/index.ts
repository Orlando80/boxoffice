import { sql } from "drizzle-orm";
import { createDb } from "@boxoffice/db";
import { buildApp } from "./app.js";
import { parseEnv } from "./env.js";
import { createRepository } from "./repository.js";

const { PORT, DATABASE_URL, HOLD_LENGTH_SECONDS } = parseEnv(process.env);
const { db, close } = createDb(DATABASE_URL);

try {
  await db.execute(sql`select 1`);
} catch {
  // Log the host only; never credentials or the full URL.
  console.error(`Database unreachable at host ${new URL(DATABASE_URL).hostname}`);
  await close().catch(() => undefined);
  process.exit(1);
}

const app = buildApp(createRepository(db, HOLD_LENGTH_SECONDS), {
  logger: { level: "info", redact: ['req.headers["hold-token"]'] },
});

const shutdown = (): void => {
  app
    .close()
    .then(() => close())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: "0.0.0.0" });
