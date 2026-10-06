import path from "node:path";
import { buildApp } from "@boxoffice/api/app";
import { createRepository } from "@boxoffice/api/repository";
import { startApp, type RunningApp } from "@boxoffice/config/serve-app";
import { createDb } from "@boxoffice/db";
import { seedDatabase } from "@boxoffice/db/seed";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export interface Stack {
  adminUrl: string;
  apiUrl: string;
  /** Stops only the API (idempotent), to simulate an outage. */
  stopApi: () => Promise<void>;
  /** Stops everything (idempotent). */
  stop: () => Promise<void>;
}

const ADMIN_DIR = path.resolve(import.meta.dirname, "../..");

/** Postgres (seeded) + in-process API on a free port + the built admin app served by `start`. */
export async function startStack(): Promise<Stack> {
  let container: StartedPostgreSqlContainer | undefined;
  let closeDb: (() => Promise<void>) | undefined;
  let api: ReturnType<typeof buildApp> | undefined;
  let admin: RunningApp | undefined;
  let apiStopped = false;

  const stopApi = async (): Promise<void> => {
    if (apiStopped) return;
    apiStopped = true;
    await api?.close();
  };
  const stop = async (): Promise<void> => {
    const steps: Array<() => Promise<unknown> | undefined> = [
      () => admin?.stop(),
      () => stopApi(),
      () => closeDb?.(),
      () => container?.stop(),
    ];
    for (const s of steps) {
      try {
        await s();
      } catch {
        // keep cleaning up
      }
    }
  };

  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
    const url = container.getConnectionUri();
    await seedDatabase(url);
    const created = createDb(url);
    closeDb = created.close;
    api = buildApp(createRepository(created.db));
    await api.listen({ port: 0, host: "127.0.0.1" });
    const addr = api.server.address();
    if (addr === null || typeof addr === "string") throw new Error("API has no TCP address");
    const apiUrl = `http://127.0.0.1:${addr.port}`;
    admin = await startApp(ADMIN_DIR, { env: { API_URL: apiUrl } });
    return { adminUrl: admin.url, apiUrl, stopApi, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
