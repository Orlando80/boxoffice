import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const seen: { folder?: string } = {};
const end = vi.fn(async () => {});

vi.mock("postgres", () => ({ default: vi.fn(() => ({ end })) }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock("drizzle-orm/postgres-js/migrator", () => ({
  migrate: vi.fn(async (_db: unknown, cfg: { migrationsFolder: string }) => {
    seen.folder = cfg.migrationsFolder;
  }),
}));

const start = process.cwd();
afterEach(() => process.chdir(start));

describe("runMigrations folder resolution", () => {
  it("is absolute, exists, and is independent of cwd; client is ended", async () => {
    const { runMigrations } = await import("../src/migrate.js");
    await runMigrations("postgres://u:p@localhost/x");
    const first = seen.folder!;
    process.chdir(tmpdir());
    await runMigrations("postgres://u:p@localhost/x");
    expect(seen.folder).toBe(first);
    expect(isAbsolute(first)).toBe(true);
    expect(existsSync(join(first, "meta", "_journal.json"))).toBe(true);
    expect(end).toHaveBeenCalledTimes(2);
  });
});
