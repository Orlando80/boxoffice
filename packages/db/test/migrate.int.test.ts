import { ACCESS_FEATURES, PERFORMANCE_ACCESS_TAGS } from "@boxoffice/domain";
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

  describe("venues / seat maps schema", () => {
    let sql: ReturnType<typeof postgres>;
    const rnd = () => Math.random().toString(36).slice(2, 10);
    const F0 = ACCESS_FEATURES[0];

    beforeAll(async () => {
      const uri = container!.getConnectionUri();
      await runMigrations(uri);
      sql = postgres(uri, { max: 2, onnotice: () => {} });
    });
    afterAll(async () => {
      await sql?.end();
    });

    async function code(p: PromiseLike<unknown>): Promise<string | undefined> {
      try {
        await p;
        return undefined;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    }

    async function mkVenue() {
      const [v] =
        await sql`insert into venue (name, slug, time_zone) values ('V', ${"v-" + rnd()}, 'Europe/London') returning id`;
      const [l] =
        await sql`insert into layout (venue_id, name) values (${v!.id}, 'L') returning id`;
      const [s] =
        await sql`insert into section (venue_id, layout_id, name, kind) values (${v!.id}, ${l!.id}, 'S', 'reserved') returning id`;
      const [e] =
        await sql`insert into event (venue_id, name, slug) values (${v!.id}, 'E', ${"e-" + rnd()}) returning id`;
      return { v: v!.id as string, l: l!.id as string, s: s!.id as string, e: e!.id as string };
    }
    async function mkSeat(venue: string, section: string, row = "A", n = rnd()) {
      const [r] =
        await sql`insert into seat (venue_id, section_id, row_label, seat_label, x, y) values (${venue}, ${section}, ${row}, ${n}, 0, 0) returning id`;
      return r!.id as string;
    }

    it("creates all 8 tables", async () => {
      const rows =
        await sql`select table_name from information_schema.tables where table_schema='public'`;
      const names = rows.map((r) => r.table_name as string);
      for (const t of [
        "venue",
        "layout",
        "section",
        "seat",
        "seat_access_feature",
        "companion_link",
        "event",
        "performance",
      ]) {
        expect(names).toContain(t);
      }
    });

    it("enum values match the domain", async () => {
      const vals = async (name: string) =>
        (
          await sql`select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname=${name} order by e.enumsortorder`
        ).map((r) => r.enumlabel as string);
      expect(await vals("access_feature")).toEqual([...ACCESS_FEATURES]);
      expect(await vals("performance_access_tag")).toEqual([...PERFORMANCE_ACCESS_TAGS]);
      expect(PERFORMANCE_ACCESS_TAGS).toHaveLength(4);
      expect(await vals("section_kind")).toEqual(["reserved", "ga"]);
    });

    it("happy path inserts succeed and access_tags defaults to empty", async () => {
      const a = await mkVenue();
      const [p] =
        await sql`insert into performance (venue_id, event_id, layout_id, starts_at) values (${a.v}, ${a.e}, ${a.l}, now()) returning access_tags`;
      expect(p!.access_tags).toEqual([]);
      const s1 = await mkSeat(a.v, a.s);
      await sql`insert into seat_access_feature (venue_id, seat_id, feature) values (${a.v}, ${s1}, ${F0!})`;
    });

    it("rejects cross-venue seat (23503)", async () => {
      const a = await mkVenue();
      const b = await mkVenue();
      expect(
        await code(
          sql`insert into seat (venue_id, section_id, row_label, seat_label, x, y) values (${a.v}, ${b.s}, 'A', '1', 0, 0)`,
        ),
      ).toBe("23503");
    });

    it("rejects cross-venue section->layout (23503)", async () => {
      const a = await mkVenue();
      const b = await mkVenue();
      expect(
        await code(
          sql`insert into section (venue_id, layout_id, name, kind) values (${a.v}, ${b.l}, 'X', 'reserved')`,
        ),
      ).toBe("23503");
    });

    it("rejects performance referencing other venue's layout or event (23503)", async () => {
      const a = await mkVenue();
      const b = await mkVenue();
      expect(
        await code(
          sql`insert into performance (venue_id, event_id, layout_id, starts_at) values (${a.v}, ${a.e}, ${b.l}, now())`,
        ),
      ).toBe("23503");
      expect(
        await code(
          sql`insert into performance (venue_id, event_id, layout_id, starts_at) values (${a.v}, ${b.e}, ${a.l}, now())`,
        ),
      ).toBe("23503");
    });

    it("rejects cross-venue seat_access_feature and companion_link (23503)", async () => {
      const a = await mkVenue();
      const b = await mkVenue();
      const sa = await mkSeat(a.v, a.s);
      const sb = await mkSeat(b.v, b.s);
      expect(
        await code(
          sql`insert into seat_access_feature (venue_id, seat_id, feature) values (${a.v}, ${sb}, ${F0!})`,
        ),
      ).toBe("23503");
      expect(
        await code(
          sql`insert into companion_link (venue_id, access_seat_id, companion_seat_id) values (${a.v}, ${sa}, ${sb})`,
        ),
      ).toBe("23503");
      expect(
        await code(
          sql`insert into companion_link (venue_id, access_seat_id, companion_seat_id) values (${a.v}, ${sb}, ${sa})`,
        ),
      ).toBe("23503");
    });

    it("rejects layout/event with unknown venue (23503)", async () => {
      const ghost = "00000000-0000-4000-8000-000000000000";
      expect(await code(sql`insert into layout (venue_id, name) values (${ghost}, 'L')`)).toBe(
        "23503",
      );
      expect(
        await code(sql`insert into event (venue_id, name, slug) values (${ghost}, 'E', 'x')`),
      ).toBe("23503");
    });

    it("GA capacity checks (23514)", async () => {
      const a = await mkVenue();
      const ins = (kind: string, cap: number | null) =>
        sql`insert into section (venue_id, layout_id, name, kind, ga_capacity) values (${a.v}, ${a.l}, 'G', ${kind}::section_kind, ${cap})`;
      expect(await code(ins("ga", null))).toBe("23514");
      expect(await code(ins("ga", 0))).toBe("23514");
      expect(await code(ins("ga", -5))).toBe("23514");
      expect(await code(ins("reserved", 10))).toBe("23514");
      expect(await code(ins("ga", 100))).toBeUndefined();
      expect(await code(ins("reserved", null))).toBeUndefined();
    });

    it("duplicate (section,row,seat) rejected (23505)", async () => {
      const a = await mkVenue();
      await mkSeat(a.v, a.s, "A", "1");
      expect(await code(mkSeat(a.v, a.s, "A", "1"))).toBe("23505");
      expect(await code(mkSeat(a.v, a.s, "A", "2"))).toBeUndefined();
    });

    it("duplicate seat feature rejected (23505); unknown feature rejected (22P02)", async () => {
      const a = await mkVenue();
      const s = await mkSeat(a.v, a.s);
      await sql`insert into seat_access_feature (venue_id, seat_id, feature) values (${a.v}, ${s}, ${F0!})`;
      expect(
        await code(
          sql`insert into seat_access_feature (venue_id, seat_id, feature) values (${a.v}, ${s}, ${F0!})`,
        ),
      ).toBe("23505");
      expect(
        await code(
          sql`insert into seat_access_feature (venue_id, seat_id, feature) values (${a.v}, ${s}, 'bogus')`,
        ),
      ).toBe("22P02");
    });

    it("event slug unique per venue only (23505)", async () => {
      const a = await mkVenue();
      const b = await mkVenue();
      await sql`insert into event (venue_id, name, slug) values (${a.v}, 'E', 'same')`;
      expect(
        await code(sql`insert into event (venue_id, name, slug) values (${a.v}, 'E', 'same')`),
      ).toBe("23505");
      expect(
        await code(sql`insert into event (venue_id, name, slug) values (${b.v}, 'E', 'same')`),
      ).toBeUndefined();
    });

    it("companion_link constraints", async () => {
      const a = await mkVenue();
      const s1 = await mkSeat(a.v, a.s);
      const s2 = await mkSeat(a.v, a.s);
      const s3 = await mkSeat(a.v, a.s);
      const link = (x: string, y: string) =>
        sql`insert into companion_link (venue_id, access_seat_id, companion_seat_id) values (${a.v}, ${x}, ${y})`;
      expect(await code(link(s1, s1))).toBe("23514");
      expect(await code(link(s1, s2))).toBeUndefined();
      expect(await code(link(s1, s3))).toBe("23505"); // second companion, same access seat
      expect(await code(link(s3, s2))).toBe("23505"); // companion shared by two access seats
    });
  });
});
