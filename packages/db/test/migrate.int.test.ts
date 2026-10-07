import {
  ACCESS_FEATURES,
  HOLD_STATUSES,
  PERFORMANCE_ACCESS_TAGS,
  SEAT_ROLES,
} from "@boxoffice/domain";
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

  describe("holds schema", () => {
    let sql: ReturnType<typeof postgres>;
    const rnd = () => Math.random().toString(36).slice(2, 10);

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

    async function mk(kind: "reserved" | "ga" = "reserved") {
      const [v] =
        await sql`insert into venue (name, slug, time_zone) values ('V', ${"v-" + rnd()}, 'Europe/London') returning id`;
      const [l] =
        await sql`insert into layout (venue_id, name) values (${v!.id}, 'L') returning id`;
      const [s] =
        await sql`insert into section (venue_id, layout_id, name, kind, ga_capacity) values (${v!.id}, ${l!.id}, 'S', ${kind}::section_kind, ${kind === "ga" ? 5 : null}) returning id`;
      const [e] =
        await sql`insert into event (venue_id, name, slug) values (${v!.id}, 'E', ${"e-" + rnd()}) returning id`;
      const [p] =
        await sql`insert into performance (venue_id, event_id, layout_id, starts_at) values (${v!.id}, ${e!.id}, ${l!.id}, now()) returning id`;
      const [st] =
        await sql`insert into seat (venue_id, section_id, row_label, seat_label, x, y) values (${v!.id}, ${s!.id}, 'A', ${rnd()}, 0, 0) returning id`;
      return {
        v: v!.id as string,
        s: s!.id as string,
        l: l!.id as string,
        e: e!.id as string,
        p: p!.id as string,
        seat: st!.id as string,
      };
    }
    async function mkPerf(a: { v: string; e: string; l: string }) {
      const [p] =
        await sql`insert into performance (venue_id, event_id, layout_id, starts_at) values (${a.v}, ${a.e}, ${a.l}, now()) returning id`;
      return p!.id as string;
    }
    async function mkHold(venue: string, perf: string) {
      const [h] =
        await sql`insert into hold (venue_id, performance_id, token_hash, status, expires_at) values (${venue}, ${perf}, ${Buffer.from(rnd() + rnd())}, 'active', now() + interval '10 minutes') returning id`;
      return h!.id as string;
    }
    const holdSeat = (v: string, h: string, p: string, seat: string) =>
      sql`insert into hold_seat (venue_id, hold_id, performance_id, seat_id, role) values (${v}, ${h}, ${p}, ${seat}, 'standard')`;

    it("creates the new tables", async () => {
      const rows =
        await sql`select table_name from information_schema.tables where table_schema='public'`;
      const names = rows.map((r) => r.table_name as string);
      for (const t of [
        "hold",
        "hold_seat",
        "hold_ga",
        "ga_inventory",
        "hold_access_need",
        "outbox",
      ])
        expect(names).toContain(t);
    });

    it("hold_status and seat_role enum labels match the domain", async () => {
      const vals = async (name: string) =>
        (
          await sql`select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname=${name} order by e.enumsortorder`
        ).map((r) => r.enumlabel as string);
      expect(await vals("hold_status")).toEqual([...HOLD_STATUSES]);
      expect(await vals("seat_role")).toEqual([...SEAT_ROLES]);
    });

    it("token_hash is bytea and unique (23505)", async () => {
      const a = await mk();
      const [c] =
        await sql`select data_type from information_schema.columns where table_name='hold' and column_name='token_hash'`;
      expect(c!.data_type).toBe("bytea");
      const tok = Buffer.from("same-token-" + rnd());
      const ins = () =>
        sql`insert into hold (venue_id, performance_id, token_hash, status, expires_at) values (${a.v}, ${a.p}, ${tok}, 'active', now())`;
      expect(await code(ins())).toBeUndefined();
      expect(await code(ins())).toBe("23505");
    });

    it("active hold_seat unique per performance+seat; free once ended_at set", async () => {
      const a = await mk();
      const h1 = await mkHold(a.v, a.p);
      const h2 = await mkHold(a.v, a.p);
      expect(await code(holdSeat(a.v, h1, a.p, a.seat))).toBeUndefined();
      expect(await code(holdSeat(a.v, h2, a.p, a.seat))).toBe("23505");
      await sql`update hold_seat set ended_at = now() where hold_id = ${h1}`;
      expect(await code(holdSeat(a.v, h2, a.p, a.seat))).toBeUndefined();
      // ended rows may accumulate for the same seat
      await sql`update hold_seat set ended_at = now() where hold_id = ${h2}`;
      const h3 = await mkHold(a.v, a.p);
      expect(await code(holdSeat(a.v, h3, a.p, a.seat))).toBeUndefined();
    });

    it("same seat may be actively held in different performances", async () => {
      const a = await mk();
      const p2 = await mkPerf(a);
      const h1 = await mkHold(a.v, a.p);
      const h2 = await mkHold(a.v, p2);
      expect(await code(holdSeat(a.v, h1, a.p, a.seat))).toBeUndefined();
      expect(await code(holdSeat(a.v, h2, p2, a.seat))).toBeUndefined();
    });

    it("ga_inventory.held bounds (23514)", async () => {
      const a = await mk("ga");
      const ins = (cap: number, held: number) =>
        sql`insert into ga_inventory (venue_id, performance_id, section_id, capacity, held) values (${a.v}, ${a.p}, ${a.s}, ${cap}, ${held})`;
      expect(await code(ins(5, 6))).toBe("23514");
      expect(await code(ins(5, -1))).toBe("23514");
      expect(await code(ins(0, 0))).toBe("23514");
      expect(await code(ins(5, 5))).toBeUndefined();
      expect(await code(sql`update ga_inventory set held = 6 where section_id = ${a.s}`)).toBe(
        "23514",
      );
      expect(await code(sql`update ga_inventory set held = -1 where section_id = ${a.s}`)).toBe(
        "23514",
      );
      expect(
        await code(sql`update ga_inventory set held = 0 where section_id = ${a.s}`),
      ).toBeUndefined();
      // PK (performance_id, section_id)
      expect(await code(ins(5, 0))).toBe("23505");
    });

    it("hold status/ended_at check (23514)", async () => {
      const a = await mk();
      const ins = (status: string, ended: string | null) =>
        sql`insert into hold (venue_id, performance_id, token_hash, status, expires_at, ended_at) values (${a.v}, ${a.p}, ${Buffer.from(rnd() + rnd())}, ${status}::hold_status, now(), ${ended}::timestamptz)`;
      const now = new Date().toISOString();
      expect(await code(ins("active", now))).toBe("23514");
      expect(await code(ins("expired", null))).toBe("23514");
      expect(await code(ins("released", null))).toBe("23514");
      expect(await code(ins("active", null))).toBeUndefined();
      expect(await code(ins("expired", now))).toBeUndefined();
      expect(await code(ins("released", now))).toBeUndefined();
    });

    it("extensions_used bounded 0..10 (23514)", async () => {
      const a = await mk();
      const ins = (n: number) =>
        sql`insert into hold (venue_id, performance_id, token_hash, status, expires_at, extensions_used) values (${a.v}, ${a.p}, ${Buffer.from(rnd() + rnd())}, 'active', now(), ${n})`;
      expect(await code(ins(11))).toBe("23514");
      expect(await code(ins(-1))).toBe("23514");
      expect(await code(ins(10))).toBeUndefined();
      expect(await code(ins(0))).toBeUndefined();
    });

    it("hold_ga quantity >= 1 (23514)", async () => {
      const a = await mk("ga");
      const h = await mkHold(a.v, a.p);
      const ins = (q: number) =>
        sql`insert into hold_ga (venue_id, hold_id, performance_id, section_id, quantity) values (${a.v}, ${h}, ${a.p}, ${a.s}, ${q})`;
      expect(await code(ins(0))).toBe("23514");
      expect(await code(ins(-2))).toBe("23514");
      expect(await code(ins(1))).toBeUndefined();
    });

    it("hold lines must match the hold's performance (23503)", async () => {
      const a = await mk();
      const p2 = await mkPerf(a);
      const h = await mkHold(a.v, a.p);
      expect(await code(holdSeat(a.v, h, p2, a.seat))).toBe("23503");
      const ga = await mk("ga");
      const hg = await mkHold(ga.v, ga.p);
      const p3 = await mkPerf(ga);
      expect(
        await code(
          sql`insert into hold_ga (venue_id, hold_id, performance_id, section_id, quantity) values (${ga.v}, ${hg}, ${p3}, ${ga.s}, 1)`,
        ),
      ).toBe("23503");
    });

    it("cross-venue references rejected (23503)", async () => {
      const a = await mk();
      const b = await mk("ga");
      expect(
        await code(
          sql`insert into hold (venue_id, performance_id, token_hash, status, expires_at) values (${a.v}, ${b.p}, ${Buffer.from(rnd() + rnd())}, 'active', now())`,
        ),
      ).toBe("23503");
      const h = await mkHold(a.v, a.p);
      expect(await code(holdSeat(a.v, h, a.p, b.seat))).toBe("23503");
      expect(await code(holdSeat(b.v, h, a.p, b.seat))).toBe("23503");
      expect(
        await code(
          sql`insert into hold_access_need (venue_id, hold_id, seat_id, need) values (${a.v}, ${h}, ${b.seat}, ${ACCESS_FEATURES[0]!})`,
        ),
      ).toBe("23503");
      expect(
        await code(
          sql`insert into hold_ga (venue_id, hold_id, performance_id, section_id, quantity) values (${a.v}, ${h}, ${a.p}, ${b.s}, 1)`,
        ),
      ).toBe("23503");
      expect(
        await code(
          sql`insert into ga_inventory (venue_id, performance_id, section_id, capacity) values (${a.v}, ${b.p}, ${a.s}, 5)`,
        ),
      ).toBe("23503");
      expect(
        await code(
          sql`insert into ga_inventory (venue_id, performance_id, section_id, capacity) values (${a.v}, ${a.p}, ${b.s}, 5)`,
        ),
      ).toBe("23503");
      expect(
        await code(
          sql`insert into outbox (venue_id, type, aggregate_id, payload) values ('00000000-0000-4000-8000-000000000000', 't', ${h}, '{}')`,
        ),
      ).toBe("23503");
    });

    it("deleting a hold cascades seat, ga and access-need lines", async () => {
      const a = await mk();
      const ga = await mk("ga");
      const h = await mkHold(a.v, a.p);
      await holdSeat(a.v, h, a.p, a.seat);
      await sql`insert into hold_access_need (venue_id, hold_id, seat_id, need) values (${a.v}, ${h}, ${a.seat}, ${ACCESS_FEATURES[0]!})`;
      const hg = await mkHold(ga.v, ga.p);
      await sql`insert into hold_ga (venue_id, hold_id, performance_id, section_id, quantity) values (${ga.v}, ${hg}, ${ga.p}, ${ga.s}, 2)`;
      await sql`delete from hold where id in (${h}, ${hg})`;
      const count = async (t: "hold_seat" | "hold_access_need" | "hold_ga", id: string) =>
        (await sql`select count(*)::int as n from ${sql(t)} where hold_id = ${id}`)[0]!.n;
      expect(await count("hold_seat", h)).toBe(0);
      expect(await count("hold_access_need", h)).toBe(0);
      expect(await count("hold_ga", hg)).toBe(0);
    });

    it("deleting a seat or performance in use is blocked (23503)", async () => {
      const a = await mk();
      const h = await mkHold(a.v, a.p);
      await holdSeat(a.v, h, a.p, a.seat);
      expect(await code(sql`delete from seat where id = ${a.seat}`)).toBe("23503");
      expect(await code(sql`delete from performance where id = ${a.p}`)).toBe("23503");
    });

    it("outbox id auto-generates, increments, defaults apply, rejects explicit id", async () => {
      const a = await mk();
      const ins = () =>
        sql`insert into outbox (venue_id, type, aggregate_id, payload) values (${a.v}, 'hold.created', ${a.p}, '{"k":1}') returning id, attempts, published_at, next_attempt_at`;
      const [r1] = await ins();
      const [r2] = await ins();
      expect(Number(r2!.id)).toBeGreaterThan(Number(r1!.id));
      expect(r1!.attempts).toBe(0);
      expect(r1!.published_at).toBeNull();
      expect(r1!.next_attempt_at).toBeInstanceOf(Date);
      expect(
        await code(
          sql`insert into outbox (id, venue_id, type, aggregate_id, payload) values (999999, ${a.v}, 't', ${a.p}, '{}')`,
        ),
      ).toBe("428C9");
    });

    it("partial indexes have the expected predicates", async () => {
      const defs = (
        await sql`select indexname, indexdef from pg_indexes where indexname in ('hold_seat_active_uq','outbox_unpublished_idx')`
      ).map((r) => r.indexdef as string);
      expect(defs.some((d) => /UNIQUE/.test(d) && /ended_at IS NULL/.test(d))).toBe(true);
      expect(defs.some((d) => /published_at IS NULL/.test(d))).toBe(true);
    });
  });
});
