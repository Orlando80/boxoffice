import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { VenueGraph } from "@boxoffice/domain";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import { PLACEHOLDER_URL } from "../src/env.js";
import { buildSeed } from "../src/seed/data.js";
import { seedDatabase, validateSeed } from "../src/seed/run.js";

type DeepMutable<T> = T extends Date
  ? T
  : T extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T;
const mutableSeed = (): DeepMutable<VenueGraph> => buildSeed() as DeepMutable<VenueGraph>;

const dbDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TABLES = [
  "venue",
  "layout",
  "section",
  "seat",
  "seat_access_feature",
  "companion_link",
  "event",
  "performance",
] as const;

describe("seed (AC 3) against a real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;
  let url: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
    url = container.getConnectionUri();
    await runMigrations(url); // so counts() can prove "zero rows" after a rejected seed
    sql = postgres(url, { max: 2, onnotice: () => {} });
  }, 120_000);
  afterAll(async () => {
    await sql?.end();
    await container?.stop();
  }, 60_000);

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const [r] = await sql.unsafe(`select count(*)::int as n from ${t}`);
      out[t] = r!.n as number;
    }
    return out;
  }
  async function snapshot() {
    return {
      venues: await sql`select * from venue order by id`,
      events: await sql`select * from event order by id`,
      perfs: await sql`select * from performance order by id`,
      sections: await sql`select * from section order by id`,
      seats: await sql`select * from seat order by id limit 300`,
      links: await sql`select * from companion_link order by access_seat_id`,
      feats: await sql`select * from seat_access_feature order by seat_id, feature`,
    };
  }

  it("a corrupt seed (duplicate seat label) is rejected naming venue and rule, writing nothing", async () => {
    const g = mutableSeed();
    const sec = g.layouts[0]!.sections[0]!;
    const dup = { ...sec.seats[1]!, id: "00000000-0000-4000-8000-0000000000aa" };
    dup.rowLabel = sec.seats[0]!.rowLabel;
    dup.seatLabel = sec.seats[0]!.seatLabel;
    sec.seats.push(dup);

    const problems = validateSeed(g);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/venue "Riverside Studio \(Example\)": rule \S+ on /);

    const err = await seedDatabase(url, g).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("Riverside Studio (Example)");
    expect(err!.message).toMatch(/rule \S+/);
    expect(await counts()).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
  });

  it("a corrupt seed (companion in another section) is rejected naming venue and rule, writing nothing", async () => {
    const g = mutableSeed();
    const theatre = g.layouts.find((l) => l.name === "End-on")!;
    const [stalls, circle] = [theatre.sections[0]!, theatre.sections[1]!];
    const companion = stalls.seats.find((s) => s.companionOf !== null)!;
    const foreignAccess = circle.seats.find((s) => s.accessFeatures.length > 0)!;
    companion.companionOf = foreignAccess.id;

    const err = await seedDatabase(url, g).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('venue "Harbour Lane Theatre (Example)"');
    expect(err!.message).toMatch(/rule \S+/);
    expect(await counts()).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
  });

  it("a graph that passes validation but fails in the DB rolls back (single transaction)", async () => {
    const g = mutableSeed();
    // Make two venues share a slug: domain may or may not catch it; DB unique must.
    const dupSlug = structuredClone(g);
    dupSlug.venues[1]!.slug = dupSlug.venues[0]!.slug;
    await seedDatabase(url, dupSlug).catch(() => undefined);
    const c = await counts();
    // Either rejected up front (all zero) or rolled back (all zero).
    expect(c).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
  });

  it("seeds an empty DB to the documented totals", async () => {
    await seedDatabase(url);
    expect(await counts()).toEqual({
      venue: 3,
      layout: 4,
      section: 9,
      seat: 6300,
      seat_access_feature: 40,
      companion_link: 23,
      event: 6,
      performance: 12,
    });
    const per = await sql`
      select v.name, count(s.id)::int as n from venue v
      left join seat s on s.venue_id = v.id group by v.name order by n`;
    expect(per.map((r) => r.n)).toEqual([100, 1200, 5000]);
    const names = await sql`select name, time_zone from venue order by name`;
    expect(names.map((r) => r.name)).toEqual([
      "Harbour Lane Theatre (Example)",
      "Northgate Arena (Example)",
      "Riverside Studio (Example)",
    ]);
    expect(names.every((r) => r.time_zone === "Europe/London")).toBe(true);
  }, 120_000);

  it("a second run is idempotent: counts and row contents unchanged", async () => {
    const before = await counts();
    const snapBefore = await snapshot();
    await seedDatabase(url);
    expect(await counts()).toEqual(before);
    expect(await snapshot()).toEqual(snapBefore);
  }, 120_000);

  it("a corrupt seed against an already-seeded DB leaves it untouched", async () => {
    const before = await snapshot();
    const g = mutableSeed();
    g.layouts[0]!.sections[0]!.seats.push({ ...g.layouts[0]!.sections[0]!.seats[0]! });
    await expect(seedDatabase(url, g)).rejects.toThrow(/venue "Riverside Studio \(Example\)"/);
    expect(await snapshot()).toEqual(before);
  });

  it("the CLI refuses the placeholder DATABASE_URL (and an unset one) with exit code 1", () => {
    for (const env of [{ DATABASE_URL: PLACEHOLDER_URL }, {}]) {
      const r = spawnSync(process.execPath, ["--import", "tsx", "src/seed/run.ts"], {
        cwd: dbDir,
        env: { ...process.env, DATABASE_URL: undefined, ...env },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/Refusing to seed/);
      expect(r.stdout).not.toMatch(/Seeded/);
    }
  }, 60_000);

  it("the CLI seeds a real URL end to end (idempotent, exit 0)", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/seed/run.ts"], {
      cwd: dbDir,
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Seeded 3 venues, 4 layouts, 6300 seats, 6 events.");
  }, 120_000);
});
