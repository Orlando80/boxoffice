import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { ACCESS_FEATURES, type HoldRequest } from "@boxoffice/domain";
import { drizzle } from "drizzle-orm/postgres-js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client.js";
import {
  createHold,
  expireHoldIfDue,
  extendHold,
  getHold,
  getHoldExpiry,
  purgeEndedHolds,
  releaseHold,
  type CreateHoldResult,
  type HoldCreated,
} from "../src/holds.js";
import * as schema from "../src/schema.js";
import { buildSeed, seedId } from "../src/seed/data.js";
import { seedDatabase } from "../src/seed/run.js";
import { futurePerformance, type FuturePerformance } from "./support/performances.js";

const STUDIO = "quillmarsh-studio";
const LAYOUT = "Standing and stalls";
const stallsSeat = (row: string, n: number): string =>
  seedId("seat", STUDIO, LAYOUT, "Stalls", row, String(n));
const STANDING = seedId("section", STUDIO, LAYOUT, "Standing");
const STALLS = seedId("section", STUDIO, LAYOUT, "Stalls");
const LEN = 600;

const std = (seatId: string) => ({ seatId, role: "standard" as const });
const seatsReq = (...ids: string[]): HoldRequest => ({ seats: ids.map(std), ga: [] });
const gaReq = (quantity: number): HoldRequest => ({
  seats: [],
  ga: [{ sectionId: STANDING, quantity }],
});

describe("hold data layer (seeded Postgres)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let closeDb: () => Promise<void>;
  let sql: ReturnType<typeof postgres>;
  const graph = buildSeed();
  const tokens: string[] = [];
  let venueId: string;

  const perf = (daysAhead = 5): Promise<FuturePerformance> =>
    futurePerformance(sql, {
      venueSlug: STUDIO,
      eventSlug: "late-night-comedy",
      layoutName: LAYOUT,
      daysAhead,
    });

  const create = async (
    p: FuturePerformance,
    request: HoldRequest,
    lengthSeconds = LEN,
  ): Promise<HoldCreated> => {
    const r = await createHold(db, p.venueId, p.id, request, { lengthSeconds });
    if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.error)}`);
    tokens.push(r.value.token);
    return r.value;
  };
  const track = (r: CreateHoldResult): CreateHoldResult => {
    if (r.ok) tokens.push(r.value.token);
    return r;
  };
  const failure = async (p: FuturePerformance, request: HoldRequest) => {
    const r = await createHold(db, p.venueId, p.id, request, { lengthSeconds: LEN });
    if (r.ok) {
      tokens.push(r.value.token);
      throw new Error("expected failure");
    }
    return r.error;
  };

  const num = async (query: Promise<{ n: number | string }[]>): Promise<number> =>
    Number((await query)[0]!.n);
  const outboxRows = (holdId: string) =>
    sql<
      { type: string; payload: Record<string, string>; venue_id: string; aggregate_id: string }[]
    >`
      select type, payload, venue_id, aggregate_id from outbox where aggregate_id = ${holdId} order by id`;
  const outboxTypes = async (holdId: string): Promise<string[]> =>
    (await outboxRows(holdId)).map((r) => r.type);
  const perfOutboxCount = (p: FuturePerformance) =>
    num(sql`select count(*)::int n from outbox where payload->>'performanceId' = ${p.id}`);
  const rowCounts = async (p: FuturePerformance) => ({
    hold: await num(sql`select count(*)::int n from hold where performance_id = ${p.id}`),
    seat: await num(sql`select count(*)::int n from hold_seat where performance_id = ${p.id}`),
    ga: await num(sql`select count(*)::int n from hold_ga where performance_id = ${p.id}`),
    need: await num(
      sql`select count(*)::int n from hold_access_need n join hold h on h.id = n.hold_id where h.performance_id = ${p.id}`,
    ),
    outbox: await perfOutboxCount(p),
    inv: await num(sql`select count(*)::int n from ga_inventory where performance_id = ${p.id}`),
  });
  const gaHeld = async (p: FuturePerformance): Promise<number> => {
    const r = await sql<{ held: number }[]>`
      select held from ga_inventory where performance_id = ${p.id} and section_id = ${STANDING}`;
    return r[0]?.held ?? 0;
  };
  const needCount = (holdId: string) =>
    num(sql`select count(*)::int n from hold_access_need where hold_id = ${holdId}`);
  const backdate = (holdId: string) =>
    sql`update hold set expires_at = now() - interval '1 minute' where id = ${holdId}`;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
    const url = container.getConnectionUri();
    await seedDatabase(url, graph);
    const client = postgres(url, { max: 30 });
    db = drizzle(client, { schema });
    closeDb = () => client.end();
    sql = postgres(url, { max: 4 });
    venueId = graph.venues.find((v) => v.slug === STUDIO)!.id;
  }, 180_000);
  afterAll(async () => {
    await closeDb?.();
    await sql?.end();
    await container?.stop();
  }, 60_000);

  describe("AC 5 concurrency", () => {
    it("20 parallel creates for one seat: exactly 1 ok, 19 seats_unavailable", async () => {
      const p = await perf();
      const seat = stallsSeat("B", 3);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          createHold(db, p.venueId, p.id, seatsReq(seat), { lengthSeconds: LEN }).then(track),
        ),
      );
      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(19);
      for (const l of losses) {
        expect(!l.ok && l.error).toEqual({
          code: "seats_unavailable",
          seatIds: [seat],
          sectionIds: [],
        });
      }
      const c = await rowCounts(p);
      expect(c).toMatchObject({ hold: 1, seat: 1, outbox: 1 });
      expect(
        await num(
          sql`select count(*)::int n from hold_seat where performance_id = ${p.id} and ended_at is null`,
        ),
      ).toBe(1);
    });

    it("50 parallel creates for overlapping seat sets never double-hold a seat and never throw", async () => {
      const p = await perf();
      const pool = ["C1", "C2", "C3", "C4", "C5", "C6"].map((s) =>
        stallsSeat(s.slice(0, 1), Number(s.slice(1))),
      );
      const requests = Array.from({ length: 50 }, (_, i) => {
        const a = pool[i % 6]!;
        const b = pool[(i * 5 + 1) % 6]!;
        return a === b ? seatsReq(a) : i % 2 ? seatsReq(a, b) : seatsReq(b, a);
      });
      const results = await Promise.all(
        requests.map((r) => createHold(db, p.venueId, p.id, r, { lengthSeconds: LEN }).then(track)),
      );
      for (const r of results) {
        if (!r.ok) expect(r.error.code).toBe("seats_unavailable");
      }
      const dup = await sql`
        select seat_id from hold_seat where performance_id = ${p.id} and ended_at is null
        group by seat_id having count(*) > 1`;
      expect(dup).toHaveLength(0);
      const wins = results.filter((r) => r.ok).length;
      expect(await perfOutboxCount(p)).toBe(wins);
      expect((await rowCounts(p)).hold).toBe(wins);
    });

    it("20 parallel 1-place GA creates against capacity 5: exactly 5 ok, held never above capacity", async () => {
      const p = await perf();
      // Take 195 of the 200 Standing places first (max 10 per hold).
      for (let i = 0; i < 19; i += 1) await create(p, gaReq(10));
      await create(p, gaReq(5));
      expect(await gaHeld(p)).toBe(195);

      let stop = false;
      let maxSeen = 0;
      const sampler = (async () => {
        while (!stop) {
          const r = await sql<{ held: number; capacity: number }[]>`
            select held, capacity from ga_inventory where performance_id = ${p.id}`;
          for (const row of r) {
            expect(row.held).toBeLessThanOrEqual(row.capacity);
            maxSeen = Math.max(maxSeen, row.held);
          }
        }
      })();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          createHold(db, p.venueId, p.id, gaReq(1), { lengthSeconds: LEN }).then(track),
        ),
      );
      stop = true;
      await sampler;

      expect(results.filter((r) => r.ok)).toHaveLength(5);
      const losses = results.filter((r) => !r.ok);
      expect(losses).toHaveLength(15);
      for (const l of losses) {
        expect(!l.ok && l.error).toEqual({
          code: "seats_unavailable",
          seatIds: [],
          sectionIds: [STANDING],
        });
      }
      expect(maxSeen).toBeLessThanOrEqual(200);
      const inv = await sql<{ held: number; capacity: number }[]>`
        select held, capacity from ga_inventory where performance_id = ${p.id}`;
      expect(inv).toEqual([{ held: 200, capacity: 200 }]);
      expect(
        await num(
          sql`select coalesce(sum(quantity),0)::int n from hold_ga where performance_id = ${p.id} and ended_at is null`,
        ),
      ).toBe(200);
    });

    it("concurrent GA creates and releases keep held equal to the sum of active lines", async () => {
      const p = await perf();
      const base = await Promise.all(Array.from({ length: 10 }, () => create(p, gaReq(10))));
      const ops = [
        ...base.map((h) => releaseHold(db, p.venueId, h.holdId, h.token)),
        ...Array.from({ length: 30 }, () =>
          createHold(db, p.venueId, p.id, gaReq(5), { lengthSeconds: LEN }).then(track),
        ),
      ];
      await Promise.all(ops);
      const held = await gaHeld(p);
      const lines = await num(
        sql`select coalesce(sum(quantity),0)::int n from hold_ga where performance_id = ${p.id} and ended_at is null`,
      );
      expect(held).toBe(lines);
      expect(held).toBeLessThanOrEqual(200);
    });

    it("race: concurrent creates over an overdue holder expire it exactly once and one wins", async () => {
      const p = await perf();
      const seat = stallsSeat("D", 4);
      const old = await create(p, seatsReq(seat));
      await backdate(old.holdId);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          createHold(db, p.venueId, p.id, seatsReq(seat), { lengthSeconds: LEN }).then(track),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await outboxTypes(old.holdId)).toEqual(["hold.created", "hold.expired"]);
    });
  });

  describe("AC 6 atomicity", () => {
    it("create writes one hold.created row; extend, release write one each; no-ops write none", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("E", 1)));
      expect(await outboxTypes(h.holdId)).toEqual(["hold.created"]);

      const ext = await extendHold(db, p.venueId, h.holdId, h.token, { lengthSeconds: LEN });
      expect(ext?.ok).toBe(true);
      expect(await outboxTypes(h.holdId)).toEqual(["hold.created", "hold.extended"]);

      // Failed / unauthorised operations write nothing.
      expect(await extendHold(db, p.venueId, h.holdId, "wrong")).toBeNull();
      expect(await releaseHold(db, p.venueId, h.holdId, "wrong")).toBeNull();
      expect(await outboxTypes(h.holdId)).toEqual(["hold.created", "hold.extended"]);

      const rel = await releaseHold(db, p.venueId, h.holdId, h.token);
      expect(rel?.status).toBe("released");
      expect(await outboxTypes(h.holdId)).toEqual([
        "hold.created",
        "hold.extended",
        "hold.released",
      ]);

      // Idempotent release and extend-after-end write no more rows.
      await releaseHold(db, p.venueId, h.holdId, h.token);
      const late = await extendHold(db, p.venueId, h.holdId, h.token);
      expect(late).toEqual({ ok: false, error: "hold_ended" });
      expect(await expireHoldIfDue(db, p.venueId, h.holdId)).toMatchObject({
        ended: false,
        reason: "already_ended",
      });
      expect(await outboxTypes(h.holdId)).toHaveLength(3);
    });

    it("outbox rows carry matching ids, venue and type", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("E", 2)));
      const [row] = await outboxRows(h.holdId);
      expect(row).toMatchObject({
        type: "hold.created",
        venue_id: p.venueId,
        aggregate_id: h.holdId,
      });
      expect(row!.payload).toMatchObject({
        holdId: h.holdId,
        venueId: p.venueId,
        performanceId: p.id,
        expiresAt: h.expiresAt.toISOString(),
      });
    });

    it("expiry via expireHoldIfDue writes exactly one hold.expired, then nothing", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("E", 3)));
      const early = await expireHoldIfDue(db, p.venueId, h.holdId);
      expect(early.ended).toBe(false);
      expect(early).toMatchObject({ expiresAt: expect.any(Date) });
      expect(await outboxTypes(h.holdId)).toEqual(["hold.created"]);

      await backdate(h.holdId);
      const ended = await expireHoldIfDue(db, p.venueId, h.holdId);
      expect(ended).toMatchObject({ ended: true });
      expect(ended.ended && ended.lagMs).toBeGreaterThanOrEqual(50_000);
      const again = await expireHoldIfDue(db, p.venueId, h.holdId);
      expect(again).toMatchObject({ ended: false, expiresAt: null, reason: "already_ended" });
      expect(await outboxTypes(h.holdId)).toEqual(["hold.created", "hold.expired"]);
      expect(await getHoldExpiry(db, p.venueId, h.holdId)).toMatchObject({ status: "expired" });
      expect(await expireHoldIfDue(db, p.venueId, randomUUID())).toMatchObject({
        reason: "not_found",
      });
    });

    it("concurrent release and expireHoldIfDue write exactly one end event", async () => {
      const p = await perf();
      for (let i = 0; i < 5; i += 1) {
        const h = await create(p, seatsReq(stallsSeat("F", i + 1)));
        await backdate(h.holdId);
        await Promise.all([
          releaseHold(db, p.venueId, h.holdId, h.token),
          expireHoldIfDue(db, p.venueId, h.holdId),
          expireHoldIfDue(db, p.venueId, h.holdId),
        ]);
        const types = await outboxTypes(h.holdId);
        expect(types.filter((t) => t === "hold.released" || t === "hold.expired")).toHaveLength(1);
      }
    });

    it("a throw between the line writes and the outbox insert leaves nothing behind", async () => {
      const p = await perf();
      const before = await rowCounts(p);
      const request: HoldRequest = {
        seats: [
          { seatId: stallsSeat("J", 1), role: "access", accessNeed: "wheelchair_space" },
          { seatId: stallsSeat("J", 2), role: "companion" },
          std(stallsSeat("G", 1)),
        ],
        ga: [{ sectionId: STANDING, quantity: 3 }],
      };
      await expect(
        createHold(
          db,
          p.venueId,
          p.id,
          request,
          { lengthSeconds: LEN },
          {
            beforeOutboxInsert: () => {
              throw new Error("boom");
            },
          },
        ),
      ).rejects.toThrow("boom");
      expect(await rowCounts(p)).toEqual(before);
      expect(await rowCounts(p)).toEqual({ hold: 0, seat: 0, ga: 0, need: 0, outbox: 0, inv: 0 });
      // Same seats are still holdable.
      const h = await create(p, request);
      expect(await outboxTypes(h.holdId)).toEqual(["hold.created"]);
    });

    it("an async hook rejection also rolls everything back", async () => {
      const p = await perf();
      await expect(
        createHold(
          db,
          p.venueId,
          p.id,
          gaReq(4),
          { lengthSeconds: LEN },
          {
            beforeOutboxInsert: () => Promise.reject(new Error("async boom")),
          },
        ),
      ).rejects.toThrow("async boom");
      expect(await rowCounts(p)).toEqual({ hold: 0, seat: 0, ga: 0, need: 0, outbox: 0, inv: 0 });
    });

    it("failed creates (conflict, validation) write no outbox rows and leave GA untouched", async () => {
      const p = await perf();
      const taken = stallsSeat("G", 5);
      await create(p, seatsReq(taken));
      const before = await rowCounts(p);
      // Seat conflict plus a free GA line: GA increment must roll back.
      const e = await failure(p, {
        seats: [std(taken), std(stallsSeat("G", 6))],
        ga: [{ sectionId: STANDING, quantity: 2 }],
      });
      expect(e).toEqual({ code: "seats_unavailable", seatIds: [taken], sectionIds: [] });
      expect(await gaHeld(p)).toBe(0);
      expect(await failure(p, seatsReq(stallsSeat("G", 6), stallsSeat("G", 6)))).toMatchObject({
        code: "invalid_hold",
        rule: "duplicate_seat",
      });
      const after = await rowCounts(p);
      expect(after.outbox).toBe(before.outbox);
      expect(after.hold).toBe(before.hold);
      expect(after.seat).toBe(before.seat);
      expect(after.ga).toBe(before.ga);
      // The free seat G6 was not left held by the failed attempt.
      await create(p, seatsReq(stallsSeat("G", 6)));
    });

    it("seats_unavailable lists exactly the conflicting seats, GA short lists the section", async () => {
      const p = await perf();
      const [a, b, c, d] = [2, 3, 4, 5].map((n) => stallsSeat("H", n)) as [
        string,
        string,
        string,
        string,
      ];
      await create(p, seatsReq(b, d));
      const e = await failure(p, seatsReq(a, b, c, d));
      expect(e).toEqual({
        code: "seats_unavailable",
        seatIds: [b, d].sort(),
        sectionIds: [],
      });
      for (let i = 0; i < 20; i += 1) await create(p, gaReq(10));
      const g = await failure(p, { seats: [std(a)], ga: [{ sectionId: STANDING, quantity: 1 }] });
      expect(g).toEqual({ code: "seats_unavailable", seatIds: [], sectionIds: [STANDING] });
    });
  });

  describe("AC 7 lazy expiry", () => {
    it("an overdue hold with no workflow does not block a new hold; one hold.expired row", async () => {
      const p = await perf();
      const seat = stallsSeat("H", 1);
      const old = await create(p, seatsReq(seat));
      await backdate(old.holdId);
      const fresh = await create(p, seatsReq(seat));
      expect(fresh.holdId).not.toBe(old.holdId);
      const row = await sql<{ status: string; ended_at: Date | null }[]>`
        select status, ended_at from hold where id = ${old.holdId}`;
      expect(row[0]!.status).toBe("expired");
      expect(row[0]!.ended_at).not.toBeNull();
      expect(await outboxTypes(old.holdId)).toEqual(["hold.created", "hold.expired"]);
      expect(await outboxTypes(fresh.holdId)).toEqual(["hold.created"]);
      // The later workflow finds it already ended.
      expect(await expireHoldIfDue(db, p.venueId, old.holdId)).toMatchObject({
        reason: "already_ended",
      });
      expect(await outboxTypes(old.holdId)).toHaveLength(2);
    });

    it("lazy expiry frees GA inventory and the old hold's access needs", async () => {
      const p = await perf();
      const old = await create(p, {
        seats: [
          { seatId: stallsSeat("J", 10), role: "access", accessNeed: "transfer_seat" },
          { seatId: stallsSeat("J", 9), role: "companion" },
        ],
        ga: [{ sectionId: STANDING, quantity: 7 }],
      });
      expect(await needCount(old.holdId)).toBe(1);
      expect(await gaHeld(p)).toBe(7);
      await backdate(old.holdId);
      await create(p, gaReq(1));
      expect(await gaHeld(p)).toBe(1);
      expect(await needCount(old.holdId)).toBe(0);
      expect(await outboxTypes(old.holdId)).toEqual(["hold.created", "hold.expired"]);
      // The seats are free again.
      await create(p, {
        seats: [
          { seatId: stallsSeat("J", 10), role: "access", accessNeed: "transfer_seat" },
          { seatId: stallsSeat("J", 9), role: "companion" },
        ],
        ga: [],
      });
    });

    it("overdue GA holders fill 200 places and a new create still succeeds", async () => {
      const p = await perf();
      const olds: HoldCreated[] = [];
      for (let i = 0; i < 20; i += 1) olds.push(await create(p, gaReq(10)));
      expect(await gaHeld(p)).toBe(200);
      await failure(p, gaReq(1));
      for (const o of olds) await backdate(o.holdId);
      await create(p, gaReq(1));
      expect(await gaHeld(p)).toBe(1);
      for (const o of olds) {
        expect((await outboxTypes(o.holdId)).filter((t) => t === "hold.expired")).toHaveLength(1);
      }
    });

    it("an overdue hold reads as expired and cannot be extended; release ends it as expired", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("H", 7)));
      await backdate(h.holdId);
      expect((await getHold(db, p.venueId, h.holdId, h.token))?.status).toBe("expired");
      expect(await extendHold(db, p.venueId, h.holdId, h.token)).toEqual({
        ok: false,
        error: "hold_ended",
      });
      const rel = await releaseHold(db, p.venueId, h.holdId, h.token);
      expect(rel?.status).toBe("expired");
      expect(await outboxTypes(h.holdId)).toEqual(["hold.created", "hold.expired"]);
      const again = await releaseHold(db, p.venueId, h.holdId, h.token);
      expect(again).toEqual(rel);
    });
  });

  describe("AC 8 access needs", () => {
    const accessReq = (): HoldRequest => ({
      seats: [
        { seatId: stallsSeat("J", 1), role: "access", accessNeed: "wheelchair_space" },
        { seatId: stallsSeat("J", 2), role: "companion" },
        { seatId: stallsSeat("A", 5), role: "access", accessNeed: "hearing_loop" },
        { seatId: stallsSeat("A", 6), role: "companion" },
      ],
      ga: [],
    });

    it("stores needs apart while active and deletes them on release", async () => {
      const p = await perf();
      const h = await create(p, accessReq());
      const needs = await sql<{ need: string; seat_id: string }[]>`
        select need, seat_id from hold_access_need where hold_id = ${h.holdId} order by need`;
      expect(needs.map((n) => n.need).sort()).toEqual(["hearing_loop", "wheelchair_space"]);
      // Needs are not on hold or hold_seat rows.
      const dump = await sql<{ t: string }[]>`
        select (select string_agg(row_to_json(h)::text, '') from hold h where h.id = ${h.holdId})
            || (select string_agg(row_to_json(s)::text, '') from hold_seat s where s.hold_id = ${h.holdId}) as t`;
      for (const f of ACCESS_FEATURES) expect(dump[0]!.t).not.toContain(f);
      const view = await getHold(db, p.venueId, h.holdId, h.token);
      expect(JSON.stringify(view)).not.toMatch(new RegExp(ACCESS_FEATURES.join("|")));
      expect(JSON.stringify(view)).not.toContain(h.token);
      expect(view!.seats.map((s) => s.role).sort()).toEqual([
        "access",
        "access",
        "companion",
        "companion",
      ]);

      await releaseHold(db, p.venueId, h.holdId, h.token);
      expect(await needCount(h.holdId)).toBe(0);
    });

    it("deletes needs on expiry", async () => {
      const p = await perf();
      const h = await create(p, accessReq());
      await backdate(h.holdId);
      await expireHoldIfDue(db, p.venueId, h.holdId);
      expect(await needCount(h.holdId)).toBe(0);
    });

    it("never puts a need value or a token in outbox payloads (checked in the last test)", async () => {
      const p = await perf();
      const h = await create(p, accessReq());
      await extendHold(db, p.venueId, h.holdId, h.token);
      await releaseHold(db, p.venueId, h.holdId, h.token);
      const h2 = await create(p, accessReq());
      await backdate(h2.holdId);
      await expireHoldIfDue(db, p.venueId, h2.holdId);
      for (const id of [h.holdId, h2.holdId]) {
        for (const r of await outboxRows(id)) {
          expect(
            Object.keys(r.payload)
              .sort()
              .every((k) =>
                ["holdId", "venueId", "performanceId", "expiresAt", "endedAt"].includes(k),
              ),
          ).toBe(true);
        }
      }
    });
  });

  describe("validation (422 rules)", () => {
    it.each([
      [
        "access seat as standard",
        [{ seatId: stallsSeat("J", 1), role: "standard" as const }],
        "access_seat_wrong_role",
      ],
      [
        "access seat without a need",
        [{ seatId: stallsSeat("J", 1), role: "access" as const }],
        "access_need_missing",
      ],
      [
        "access seat with an out-of-list need",
        [{ seatId: stallsSeat("J", 1), role: "access" as const, accessNeed: "banana" }],
        "access_need_invalid",
      ],
      [
        "companion alone",
        [{ seatId: stallsSeat("J", 2), role: "companion" as const }],
        "companion_without_access_seat",
      ],
      [
        "companion held as standard",
        [{ seatId: stallsSeat("J", 2), role: "standard" as const }],
        "companion_wrong_role",
      ],
      [
        "companion of a different access seat",
        [
          { seatId: stallsSeat("J", 1), role: "access" as const, accessNeed: "aisle" },
          { seatId: stallsSeat("A", 6), role: "companion" as const },
        ],
        "companion_without_access_seat",
      ],
      [
        "companion role on a plain seat",
        [{ seatId: stallsSeat("B", 1), role: "companion" as const }],
        "access_role_on_standard_seat",
      ],
      [
        "access role on a plain seat",
        [{ seatId: stallsSeat("B", 1), role: "access" as const, accessNeed: "aisle" }],
        "access_role_on_standard_seat",
      ],
    ])("%s is rejected with %s", async (_name, seats, rule) => {
      const p = await perf();
      const e = await failure(p, { seats, ga: [] });
      expect(e).toMatchObject({ code: "invalid_hold" });
      expect(e.code === "invalid_hold" && e.violations.map((v) => v.rule)).toContain(rule);
      expect(await rowCounts(p)).toEqual({ hold: 0, seat: 0, ga: 0, need: 0, outbox: 0, inv: 0 });
    });

    it("accepts access plus companion pairs at J1/J2, J10/J9 and A5/A6", async () => {
      const p = await perf();
      const h = await create(p, {
        seats: [
          { seatId: stallsSeat("J", 1), role: "access", accessNeed: "wheelchair_space" },
          { seatId: stallsSeat("J", 2), role: "companion" },
          { seatId: stallsSeat("J", 10), role: "access", accessNeed: "transfer_seat" },
          { seatId: stallsSeat("J", 9), role: "companion" },
          { seatId: stallsSeat("A", 5), role: "access", accessNeed: "hearing_loop" },
          { seatId: stallsSeat("A", 6), role: "companion" },
        ],
        ga: [],
      });
      expect(await needCount(h.holdId)).toBe(3);
    });

    it("companions do not count towards the 10-place limit; 11 places or 0 are rejected", async () => {
      const p = await perf();
      const nine = ["B", "C", "D", "E", "F", "G", "H", "I"].map((r) => std(stallsSeat(r, 9)));
      const ok10 = await create(p, {
        seats: [
          ...nine,
          { seatId: stallsSeat("J", 1), role: "access", accessNeed: "wheelchair_space" },
          { seatId: stallsSeat("J", 2), role: "companion" },
          std(stallsSeat("I", 1)),
        ],
        ga: [],
      });
      expect(ok10.holdId).toBeTruthy();
      const p2 = await perf();
      const eleven = Array.from({ length: 11 }, (_, i) =>
        std(stallsSeat("B", i + 1 > 10 ? 1 : i + 1)),
      );
      const twelve = [...eleven.slice(0, 10), std(stallsSeat("C", 1))];
      expect(await failure(p2, { seats: twelve, ga: [] })).toMatchObject({
        code: "invalid_hold",
        rule: "place_count_out_of_range",
      });
      expect(await failure(p2, { seats: [], ga: [] })).toMatchObject({
        code: "invalid_hold",
        rule: "place_count_out_of_range",
      });
      expect(
        await failure(p2, {
          seats: [std(stallsSeat("B", 1))],
          ga: [{ sectionId: STANDING, quantity: 10 }],
        }),
      ).toMatchObject({
        rule: "place_count_out_of_range",
      });
    });

    it("rejects GA lines on reserved sections, GA quantity < 1 and duplicate GA sections", async () => {
      const p = await perf();
      expect(
        await failure(p, { seats: [], ga: [{ sectionId: STALLS, quantity: 2 }] }),
      ).toMatchObject({
        rule: "ga_line_on_reserved_section",
      });
      for (const q of [0, -1, 1.5]) {
        expect(
          await failure(p, { seats: [], ga: [{ sectionId: STANDING, quantity: q }] }),
        ).toMatchObject({
          code: "invalid_hold",
        });
      }
      expect(
        await failure(p, {
          seats: [],
          ga: [
            { sectionId: STANDING, quantity: 1 },
            { sectionId: STANDING, quantity: 1 },
          ],
        }),
      ).toMatchObject({ rule: "duplicate_ga_section" });
      expect(await rowCounts(p)).toEqual({ hold: 0, seat: 0, ga: 0, need: 0, outbox: 0, inv: 0 });
    });

    it("rejects a started performance", async () => {
      const p = await perf(-1);
      expect(await failure(p, seatsReq(stallsSeat("B", 1)))).toMatchObject({
        code: "invalid_hold",
        rule: "performance_started",
      });
      expect(await rowCounts(p)).toEqual({ hold: 0, seat: 0, ga: 0, need: 0, outbox: 0, inv: 0 });
    });

    it("rejects seats and sections from another layout or venue; never throws", async () => {
      const p = await perf();
      const other = graph.venues.find((v) => v.slug === "harbour-lane-theatre")!;
      const foreignSeat = seedId("seat", other.slug, "End-on", "Stalls", "A", "1");
      const foreignSection = seedId("section", other.slug, "End-on", "Stalls");
      expect(await failure(p, seatsReq(foreignSeat))).toMatchObject({
        rule: "seat_outside_layout",
      });
      expect(
        await failure(p, { seats: [], ga: [{ sectionId: foreignSection, quantity: 1 }] }),
      ).toMatchObject({ code: "invalid_hold" });
      // Seat from a different layout of the same venue.
      const allStanding = seedId("section", STUDIO, "All standing", "Standing");
      expect(
        await failure(p, { seats: [], ga: [{ sectionId: allStanding, quantity: 1 }] }),
      ).toMatchObject({ rule: "ga_section_outside_layout" });
      expect(await failure(p, seatsReq(randomUUID()))).toMatchObject({
        rule: "seat_outside_layout",
      });
    });

    it("unknown performance, and a performance of another venue, give performance_not_found", async () => {
      const p = await perf();
      const other = graph.venues.find((v) => v.slug === "harbour-lane-theatre")!;
      const otherPerf = graph.events
        .filter((e) => e.venueId === other.id)
        .flatMap((e) => e.performances)[0]!;
      for (const id of [randomUUID(), otherPerf.id]) {
        const r = await createHold(db, p.venueId, id, seatsReq(stallsSeat("B", 1)), {
          lengthSeconds: LEN,
        });
        expect(r).toEqual({ ok: false, error: { code: "performance_not_found" } });
      }
    });
  });

  describe("extend, release, tokens (data parts of AC 11-14)", () => {
    it("extend moves expiry later, drops extensionsRemaining, limit at the 11th", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("I", 2)), 60);
      expect(h.extensionsRemaining).toBe(10);
      let last = h.expiresAt.getTime();
      for (let i = 1; i <= 10; i += 1) {
        const r = await extendHold(db, p.venueId, h.holdId, h.token, { lengthSeconds: 600 });
        expect(r?.ok).toBe(true);
        if (r?.ok) {
          expect(r.value.extensionsRemaining).toBe(10 - i);
          expect(r.value.expiresAt.getTime()).toBeGreaterThan(i === 1 ? last : last - 1);
          last = r.value.expiresAt.getTime();
          expect(r.value.status).toBe("active");
        }
      }
      expect(await extendHold(db, p.venueId, h.holdId, h.token)).toEqual({
        ok: false,
        error: "extension_limit",
      });
      const view = await getHold(db, p.venueId, h.holdId, h.token);
      expect(view?.extensionsRemaining).toBe(0);
      expect((await outboxTypes(h.holdId)).filter((t) => t === "hold.extended")).toHaveLength(10);
    });

    it("extend on an ended hold gives hold_ended", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("I", 3)));
      await releaseHold(db, p.venueId, h.holdId, h.token);
      expect(await extendHold(db, p.venueId, h.holdId, h.token)).toEqual({
        ok: false,
        error: "hold_ended",
      });
    });

    it("concurrent extends never exceed 10 and each writes one row", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("I", 4)));
      const rs = await Promise.all(
        Array.from({ length: 15 }, () => extendHold(db, p.venueId, h.holdId, h.token)),
      );
      expect(rs.filter((r) => r?.ok)).toHaveLength(10);
      expect(rs.filter((r) => r && !r.ok && r.error === "extension_limit")).toHaveLength(5);
      expect((await outboxTypes(h.holdId)).filter((t) => t === "hold.extended")).toHaveLength(10);
    });

    it("release frees seats and GA at once and is idempotent", async () => {
      const p = await perf();
      const seat = stallsSeat("I", 5);
      const h = await create(p, { seats: [std(seat)], ga: [{ sectionId: STANDING, quantity: 4 }] });
      expect(await gaHeld(p)).toBe(4);
      const r1 = await releaseHold(db, p.venueId, h.holdId, h.token);
      expect(r1).toMatchObject({
        holdId: h.holdId,
        performanceId: p.id,
        status: "released",
        seats: [{ seatId: seat, role: "standard" }],
        ga: [{ sectionId: STANDING, quantity: 4 }],
      });
      expect(Object.keys(r1!).sort()).toEqual([
        "expiresAt",
        "extensionsRemaining",
        "ga",
        "holdId",
        "performanceId",
        "seats",
        "status",
      ]);
      expect(await gaHeld(p)).toBe(0);
      const r2 = await releaseHold(db, p.venueId, h.holdId, h.token);
      expect(r2).toEqual(r1);
      expect(await gaHeld(p)).toBe(0);
      await create(p, seatsReq(seat));
    });

    it("wrong, empty, other hold's token and other venue give null everywhere", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("I", 6)));
      const other = await create(p, seatsReq(stallsSeat("I", 7)));
      const otherVenue = graph.venues.find((v) => v.slug === "harbour-lane-theatre")!.id;
      const cases: [string, string][] = [
        [p.venueId, "nope"],
        [p.venueId, ""],
        [p.venueId, other.token],
        [otherVenue, h.token],
      ];
      for (const [v, t] of cases) {
        expect(await getHold(db, v, h.holdId, t)).toBeNull();
        expect(await extendHold(db, v, h.holdId, t)).toBeNull();
        expect(await releaseHold(db, v, h.holdId, t)).toBeNull();
      }
      expect(await getHold(db, p.venueId, randomUUID(), h.token)).toBeNull();
      expect(await getHoldExpiry(db, otherVenue, h.holdId)).toBeNull();
      expect(await expireHoldIfDue(db, otherVenue, h.holdId)).toMatchObject({
        reason: "not_found",
      });
      // Nothing changed.
      expect((await getHold(db, p.venueId, h.holdId, h.token))?.status).toBe("active");
      expect(await outboxTypes(h.holdId)).toEqual(["hold.created"]);
    });

    it("stores a 32-byte hash that is not the token, and the token is nowhere in the database", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("I", 8)));
      const [row] = await sql<{ token_hash: Buffer; len: number }[]>`
        select token_hash, octet_length(token_hash) as len from hold where id = ${h.holdId}`;
      expect(row!.len).toBe(32);
      expect(Buffer.from(row!.token_hash).equals(Buffer.from(h.token, "base64url"))).toBe(false);
      expect(Buffer.from(row!.token_hash).equals(Buffer.from(h.token))).toBe(false);
      expect(Buffer.from(h.token, "base64url")).toHaveLength(32);
      expect(h.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const rows = await sql<{ t: string }[]>`
        select row_to_json(h)::text as t from hold h where h.id = ${h.holdId}`;
      expect(rows[0]!.t).not.toContain(h.token);
      expect(
        await num(
          sql`select count(*)::int n from outbox where payload::text like ${"%" + h.token + "%"}`,
        ),
      ).toBe(0);
      // Tokens are random per hold.
      const h2 = await create(p, seatsReq(stallsSeat("I", 9)));
      expect(h2.token).not.toBe(h.token);
    });

    it("getHold returns the view of an active hold", async () => {
      const p = await perf();
      const seat = stallsSeat("I", 10);
      const h = await create(p, { seats: [std(seat)], ga: [{ sectionId: STANDING, quantity: 2 }] });
      const v = await getHold(db, p.venueId, h.holdId, h.token);
      expect(v).toEqual({
        holdId: h.holdId,
        performanceId: p.id,
        status: "active",
        expiresAt: h.expiresAt,
        extensionsRemaining: 10,
        seats: [{ seatId: seat, role: "standard" }],
        ga: [{ sectionId: STANDING, quantity: 2 }],
      });
    });

    it("expiresAt follows the database clock and lengthSeconds", async () => {
      const p = await perf();
      const h = await create(p, seatsReq(stallsSeat("A", 1)), 90);
      const [r] = await sql<{ secs: number }[]>`
        select extract(epoch from (expires_at - created_at))::float8 as secs from hold where id = ${h.holdId}`;
      expect(r!.secs).toBeGreaterThan(89);
      expect(r!.secs).toBeLessThan(91);
    });
  });

  describe("purgeEndedHolds", () => {
    it("removes only ended holds older than the age, with their lines", async () => {
      const p = await perf();
      const oldEnded = await create(p, {
        seats: [std(stallsSeat("A", 2))],
        ga: [{ sectionId: STANDING, quantity: 1 }],
      });
      const recentEnded = await create(p, seatsReq(stallsSeat("A", 3)));
      const activeOld = await create(p, seatsReq(stallsSeat("A", 4)));
      await releaseHold(db, p.venueId, oldEnded.holdId, oldEnded.token);
      await releaseHold(db, p.venueId, recentEnded.holdId, recentEnded.token);
      await sql`update hold set ended_at = now() - interval '10 days' where id = ${oldEnded.holdId}`;
      await sql`update hold set created_at = now() - interval '30 days' where id = ${activeOld.holdId}`;
      await sql`update hold set ended_at = now() - interval '6 days' where id = ${recentEnded.holdId}`;

      expect(await purgeEndedHolds(db, 7)).toBe(1);
      const has = async (id: string) => num(sql`select count(*)::int n from hold where id = ${id}`);
      expect(await has(oldEnded.holdId)).toBe(0);
      expect(await has(recentEnded.holdId)).toBe(1);
      expect(await has(activeOld.holdId)).toBe(1);
      expect(
        await num(sql`select count(*)::int n from hold_seat where hold_id = ${oldEnded.holdId}`),
      ).toBe(0);
      expect(
        await num(sql`select count(*)::int n from hold_ga where hold_id = ${oldEnded.holdId}`),
      ).toBe(0);
      // Idempotent.
      expect(await purgeEndedHolds(db, 7)).toBe(0);
    });
  });

  it("LAST: no outbox payload written by this file contains a need value or a token", async () => {
    const rows = await sql<{ payload: unknown; type: string }[]>`select payload, type from outbox`;
    expect(rows.length).toBeGreaterThan(50);
    expect(tokens.length).toBeGreaterThan(50);
    const types = new Set(rows.map((r) => r.type));
    expect([...types].sort()).toEqual([
      "hold.created",
      "hold.expired",
      "hold.extended",
      "hold.released",
    ]);
    for (const r of rows) {
      const text = JSON.stringify(r.payload);
      for (const f of ACCESS_FEATURES) expect(text).not.toContain(f);
      expect(text).not.toContain("accessNeed");
      expect(text).not.toContain("token");
    }
    const all = rows.map((r) => JSON.stringify(r.payload)).join("\n");
    for (const t of tokens) expect(all).not.toContain(t);
    // venueId param is used so the lint rule for unused vars stays quiet.
    expect(venueId).toBeTruthy();
  });
});
