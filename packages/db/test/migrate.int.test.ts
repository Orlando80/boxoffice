import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/index.js";

describe("runMigrations against a real Postgres", () => {
  let container: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  }, 60_000);

  it("applies migrations and the database answers select 1", async () => {
    const uri = container!.getConnectionUri();
    await runMigrations(uri);
    const sql = postgres(uri, { max: 1 });
    try {
      const rows = await sql`select 1 as one`;
      expect(rows[0]?.one).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("is idempotent when run twice", async () => {
    await expect(runMigrations(container!.getConnectionUri())).resolves.toBeUndefined();
  });
});
