import { createDb, runMigrations, type Db } from "@boxoffice/db";
import {
  ErrorBody,
  HoldCreated,
  HoldView,
  InvalidHoldBody,
  PerformanceAvailability,
  PerformanceDetail,
  SeatsUnavailableBody,
} from "@boxoffice/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository } from "../src/repository.js";
import { buildSeed, seedId } from "../../../packages/db/src/seed/data.js";
import { seedDatabase } from "../../../packages/db/src/seed/run.js";
import {
  futurePerformance,
  type FuturePerformance,
} from "../../../packages/db/test/support/performances.js";

const STUDIO = "quillmarsh-studio";
const STUDIO_LAYOUT = "Standing and stalls";
const THEATRE = "harbour-lane-theatre";
const ARENA = "fernhollow-arena";
const MISSING = "99999999-9999-4999-8999-999999999999";
const stalls = (row: string, n: number): string =>
  seedId("seat", STUDIO, STUDIO_LAYOUT, "Stalls", row, String(n));
const STANDING = seedId("section", STUDIO, STUDIO_LAYOUT, "Standing");

const std = (seatId: string) => ({ seatId, role: "standard" as const });

// The api package has no direct `postgres` dependency, so type the client's tag minimally.
type SqlTag = <T extends unknown[] = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

describe("hold API against seeded Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let sql: SqlTag;
  const graph = buildSeed();
  const tokens: string[] = [];
  const logLines: string[] = [];

  const perf = (venueSlug = STUDIO, eventSlug = "late-night-comedy", layoutName = STUDIO_LAYOUT) =>
    futurePerformance(sql as never, { venueSlug, eventSlug, layoutName, daysAhead: 5 });
  const studioPerf = () => perf();
  const theatrePerf = () => perf(THEATRE, "the-lantern-keeper", "End-on");

  const holdsUrl = (p: FuturePerformance, v = p.venueId) =>
    `/venues/${v}/performances/${p.id}/holds`;
  const holdUrl = (venueId: string, holdId: string) => `/venues/${venueId}/holds/${holdId}`;
  const availUrl = (p: FuturePerformance) =>
    `/venues/${p.venueId}/performances/${p.id}/availability`;
  const hdr = (token?: string) => (token === undefined ? {} : { "hold-token": token });

  const create = (p: FuturePerformance, payload: unknown, v = p.venueId) =>
    app.inject({ method: "POST", url: holdsUrl(p, v), payload: payload as never });
  /** Creates a hold that must succeed; remembers the token for the log check. */
  const mustCreate = async (p: FuturePerformance, payload: unknown): Promise<HoldCreated> => {
    const r = await create(p, payload);
    expect(r.statusCode, r.body).toBe(201);
    const h = HoldCreated.parse(r.json());
    tokens.push(h.token);
    return h;
  };
  const getHold = (v: string, h: string, t?: string) =>
    app.inject({ method: "GET", url: holdUrl(v, h), headers: hdr(t) });
  const extend = (v: string, h: string, t?: string) =>
    app.inject({ method: "POST", url: `${holdUrl(v, h)}/extend`, headers: hdr(t) });
  const release = (v: string, h: string, t?: string) =>
    app.inject({ method: "DELETE", url: holdUrl(v, h), headers: hdr(t) });
  const avail = async (p: FuturePerformance) => {
    const r = await app.inject({ method: "GET", url: availUrl(p) });
    expect(r.statusCode, r.body).toBe(200);
    return PerformanceAvailability.parse(r.json());
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
    const url = container.getConnectionUri();
    await runMigrations(url);
    await seedDatabase(url, graph);
    let db: Db;
    ({ db, close } = createDb(url));
    sql = (db as unknown as { $client: SqlTag }).$client;
    app = buildApp(createRepository(db, 600), {
      logger: {
        level: "info",
        stream: { write: (s: string) => void logLines.push(s) },
        redact: ['req.headers["hold-token"]'],
      },
    });
    await app.ready();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await close?.().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  }, 60_000);

  it("GET performance detail parses PerformanceDetail; unknown and cross-venue are 404", async () => {
    const p = await studioPerf();
    const r = await app.inject({
      method: "GET",
      url: `/venues/${p.venueId}/performances/${p.id}`,
    });
    expect(r.statusCode).toBe(200);
    const d = PerformanceDetail.parse(r.json());
    expect(d).toMatchObject({ id: p.id, venueId: p.venueId, layoutId: p.layoutId });
    expect(d.accessTags).toEqual([]);
    expect(Math.abs(Date.parse(d.startsAt) - (Date.now() + 5 * 86_400_000))).toBeLessThan(
      3_600_000,
    );

    const t = await theatrePerf();
    for (const u of [
      `/venues/${p.venueId}/performances/${MISSING}`,
      `/venues/${p.venueId}/performances/${t.id}`,
      `/venues/${t.venueId}/performances/${p.id}`,
    ]) {
      const x = await app.inject({ method: "GET", url: u });
      expect(x.statusCode, u).toBe(404);
      expect(x.json()).toEqual({ error: "not_found" });
    }
    expect(
      (await app.inject({ method: "GET", url: `/venues/${p.venueId}/performances/zz` })).statusCode,
    ).toBe(400);
  });

  describe("AC 10 create", () => {
    it("201 parses HoldCreated with 10 extensions; same seats again is 409 listing exactly the conflicts", async () => {
      const p = await studioPerf();
      const [b1, b2, b3] = [stalls("B", 1), stalls("B", 2), stalls("B", 3)] as [
        string,
        string,
        string,
      ];
      const r = await create(p, {
        seats: [std(b1), std(b2)],
        ga: [{ sectionId: STANDING, quantity: 3 }],
      });
      expect(r.statusCode).toBe(201);
      const h = HoldCreated.parse(r.json());
      tokens.push(h.token);
      expect(h.extensionsRemaining).toBe(10);
      expect(h.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(h.expiresAt)).toBeGreaterThan(Date.now() + 590_000);
      expect(Date.parse(h.expiresAt)).toBeLessThan(Date.now() + 610_000);

      // Exactly the same seats (GA has room, so no section conflict).
      const again = await create(p, {
        seats: [std(b2), std(b1)],
        ga: [{ sectionId: STANDING, quantity: 3 }],
      });
      expect(again.statusCode).toBe(409);
      const body = SeatsUnavailableBody.parse(again.json());
      expect([...body.seatIds].sort()).toEqual([b1, b2].sort());
      expect(body.sectionIds).toEqual([]);

      // Partial overlap: only the held seat is listed, the free one is not.
      const partial = await create(p, { seats: [std(b2), std(b3)] });
      expect(partial.statusCode).toBe(409);
      expect(SeatsUnavailableBody.parse(partial.json()).seatIds).toEqual([b2]);

      // The free seat was not taken by the failed request.
      const ok = await create(p, { seats: [std(b3)] });
      expect(ok.statusCode).toBe(201);
      tokens.push(HoldCreated.parse(ok.json()).token);
    });

    it("GA exhaustion lists the section, no seats", async () => {
      const p = await studioPerf();
      for (let i = 0; i < 19; i += 1)
        await mustCreate(p, { ga: [{ sectionId: STANDING, quantity: 10 }] });
      await mustCreate(p, { ga: [{ sectionId: STANDING, quantity: 5 }] });
      const r = await create(p, { ga: [{ sectionId: STANDING, quantity: 6 }] });
      expect(r.statusCode).toBe(409);
      expect(SeatsUnavailableBody.parse(r.json())).toEqual({
        error: "seats_unavailable",
        seatIds: [],
        sectionIds: [STANDING],
      });
      // 5 left exactly: succeeds, then 1 more fails.
      await mustCreate(p, { ga: [{ sectionId: STANDING, quantity: 5 }] });
      expect((await create(p, { ga: [{ sectionId: STANDING, quantity: 1 }] })).statusCode).toBe(
        409,
      );
      const a = await avail(p);
      expect(a.ga).toEqual([{ sectionId: STANDING, held: 200, capacity: 200 }]);
    });

    it("422 invalid_hold with the rule name; nothing is held", async () => {
      const p = await studioPerf();
      const cases: [string, unknown, string][] = [
        ["access seat as standard", { seats: [std(stalls("J", 1))] }, "access_seat_wrong_role"],
        [
          "access seat without a need",
          { seats: [{ seatId: stalls("J", 1), role: "access" }] },
          "access_need_missing",
        ],
        [
          "companion alone",
          { seats: [{ seatId: stalls("J", 2), role: "companion" }] },
          "companion_without_access_seat",
        ],
        ["empty request", {}, "place_count_out_of_range"],
        ["duplicate seat", { seats: [std(stalls("C", 1)), std(stalls("C", 1))] }, "duplicate_seat"],
        ["seat in GA section", { seats: [std(MISSING)] }, "seat_outside_layout"],
        [
          "GA line on missing section",
          { ga: [{ sectionId: MISSING, quantity: 1 }] },
          "ga_section_outside_layout",
        ],
      ];
      for (const [name, payload, rule] of cases) {
        const r = await create(p, payload);
        expect(r.statusCode, name).toBe(422);
        expect(InvalidHoldBody.parse(r.json()), name).toEqual({ error: "invalid_hold", rule });
      }
      expect((await avail(p)).heldSeatIds).toEqual([]);
    });

    it("an access seat plus companion is created with a need, and 422s without one", async () => {
      const p = await studioPerf();
      const j1 = stalls("J", 1);
      const j2 = stalls("J", 2);
      const withNeed = {
        seats: [
          { seatId: j1, role: "access", accessNeed: "wheelchair_space" },
          { seatId: j2, role: "companion" },
        ],
      };
      const without = {
        seats: [
          { seatId: j1, role: "access" },
          { seatId: j2, role: "companion" },
        ],
      };
      const bad = await create(p, without);
      expect(bad.statusCode).toBe(422);
      expect(InvalidHoldBody.parse(bad.json()).rule).toBe("access_need_missing");

      const h = await mustCreate(p, withNeed);
      const v = HoldView.parse((await getHold(p.venueId, h.holdId, h.token)).json());
      expect(v.seats.map((s) => `${s.seatId}:${s.role}`).sort()).toEqual(
        [`${j1}:access`, `${j2}:companion`].sort(),
      );
      const raw = (await getHold(p.venueId, h.holdId, h.token)).body;
      expect(raw).not.toContain("wheelchair_space");
      expect(raw).not.toMatch(/accessNeed|token/);
      expect((await avail(p)).heldSeatIds.sort()).toEqual([j1, j2].sort());
    });

    it("unknown access-need category is rejected at the API (400), cross-venue seat is 422", async () => {
      const p = await studioPerf();
      const r = await create(p, {
        seats: [{ seatId: stalls("J", 1), role: "access", accessNeed: "banana" }],
      });
      expect(r.statusCode).toBe(400);
      const theatreSeat = graph.layouts.find(
        (l) => l.venueId === graph.venues.find((v) => v.slug === THEATRE)!.id,
      )!.sections[0]!.seats[0]!.id;
      const x = await create(p, { seats: [std(theatreSeat)] });
      expect(x.statusCode).toBe(422);
      expect(InvalidHoldBody.parse(x.json()).rule).toBe("seat_outside_layout");
    });

    it("a performance that has started is 422 performance_started", async () => {
      const started = await futurePerformance(sql as never, {
        venueSlug: STUDIO,
        eventSlug: "late-night-comedy",
        layoutName: STUDIO_LAYOUT,
        daysAhead: -1,
      });
      const r = await create(started, { seats: [std(stalls("D", 1))] });
      expect(r.statusCode).toBe(422);
      expect(InvalidHoldBody.parse(r.json()).rule).toBe("performance_started");
    });
  });

  describe("AC 11 extend", () => {
    it("later expiresAt, remaining decrements; the 11th extend is 409 extension_limit", async () => {
      const p = await studioPerf();
      const h = await mustCreate(p, { seats: [std(stalls("E", 1))] });
      let prev = Date.parse(h.expiresAt);
      for (let left = 9; left >= 0; left -= 1) {
        const r = await extend(p.venueId, h.holdId, h.token);
        expect(r.statusCode, r.body).toBe(200);
        const v = HoldView.parse(r.json());
        expect(v.extensionsRemaining).toBe(left);
        expect(Date.parse(v.expiresAt)).toBeGreaterThan(prev);
        expect(v.status).toBe("active");
        prev = Date.parse(v.expiresAt);
      }
      const r = await extend(p.venueId, h.holdId, h.token);
      expect(r.statusCode).toBe(409);
      expect(ErrorBody.parse(r.json())).toEqual({ error: "extension_limit" });
      // Still held, expiry not moved by the refused extend.
      const v = HoldView.parse((await getHold(p.venueId, h.holdId, h.token)).json());
      expect(Date.parse(v.expiresAt)).toBe(prev);
      expect(v.extensionsRemaining).toBe(0);
    });

    it("extending a released or expired hold is 409 hold_ended", async () => {
      const p = await studioPerf();
      const a = await mustCreate(p, { seats: [std(stalls("E", 2))] });
      expect((await release(p.venueId, a.holdId, a.token)).statusCode).toBe(200);
      const r1 = await extend(p.venueId, a.holdId, a.token);
      expect(r1.statusCode).toBe(409);
      expect(ErrorBody.parse(r1.json())).toEqual({ error: "hold_ended" });

      const b = await mustCreate(p, { seats: [std(stalls("E", 3))] });
      await sql`update hold set expires_at = now() - interval '1 minute' where id = ${b.holdId}`;
      const r2 = await extend(p.venueId, b.holdId, b.token);
      expect(r2.statusCode).toBe(409);
      expect(ErrorBody.parse(r2.json())).toEqual({ error: "hold_ended" });
      const v = HoldView.parse((await getHold(p.venueId, b.holdId, b.token)).json());
      expect(v.status).toBe("expired");
    });

    it("concurrent extends never exceed the cap of 10", async () => {
      const p = await studioPerf();
      const h = await mustCreate(p, { seats: [std(stalls("E", 4))] });
      const rs = await Promise.all(
        Array.from({ length: 15 }, () => extend(p.venueId, h.holdId, h.token)),
      );
      expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(10);
      expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(5);
      expect(rs.every((r) => [200, 409].includes(r.statusCode))).toBe(true);
    });
  });

  describe("AC 12 release", () => {
    it("200 released, seats and GA available at once, second release returns the same body", async () => {
      const p = await studioPerf();
      const seat = stalls("F", 1);
      const h = await mustCreate(p, {
        seats: [std(seat)],
        ga: [{ sectionId: STANDING, quantity: 4 }],
      });
      let a = await avail(p);
      expect(a.heldSeatIds).toEqual([seat]);
      expect(a.ga).toEqual([{ sectionId: STANDING, held: 4, capacity: 200 }]);

      const r = await release(p.venueId, h.holdId, h.token);
      expect(r.statusCode).toBe(200);
      expect(HoldView.parse(r.json()).status).toBe("released");
      a = await avail(p);
      expect(a.heldSeatIds).toEqual([]);
      expect(a.ga).toEqual([{ sectionId: STANDING, held: 0, capacity: 200 }]);

      const again = await release(p.venueId, h.holdId, h.token);
      expect(again.statusCode).toBe(200);
      expect(again.body).toBe(r.body);

      // The seat can be re-held straight away.
      await mustCreate(p, { seats: [std(seat)] });
    });

    it("release with a wrong token does nothing", async () => {
      const p = await studioPerf();
      const h = await mustCreate(p, { seats: [std(stalls("F", 2))] });
      expect((await release(p.venueId, h.holdId, "C".repeat(43))).statusCode).toBe(404);
      expect((await avail(p)).heldSeatIds).toEqual([stalls("F", 2)]);
    });

    it("an expired hold frees its seats in availability without any release", async () => {
      const p = await studioPerf();
      const h = await mustCreate(p, { seats: [std(stalls("F", 3))] });
      await sql`update hold set expires_at = now() - interval '1 second' where id = ${h.holdId}`;
      expect((await avail(p)).heldSeatIds).toEqual([]);
      await mustCreate(p, { seats: [std(stalls("F", 3))] });
    });

    it("releasing an access hold deletes its stored access needs", async () => {
      const p = await studioPerf();
      const h = await mustCreate(p, {
        seats: [
          { seatId: stalls("J", 10), role: "access", accessNeed: "transfer_seat" },
          { seatId: stalls("J", 9), role: "companion" },
        ],
      });
      const n = async () =>
        Number(
          (await sql`select count(*)::int n from hold_access_need where hold_id = ${h.holdId}`)[0]!
            .n,
        );
      expect(await n()).toBe(1);
      expect((await release(p.venueId, h.holdId, h.token)).statusCode).toBe(200);
      expect(await n()).toBe(0);
    });
  });

  describe("AC 13 tokens and venue scoping", () => {
    it("wrong, missing, malformed and other hold's token are the same 404 as an unknown hold", async () => {
      const p = await studioPerf();
      const a = await mustCreate(p, { seats: [std(stalls("G", 1))] });
      const b = await mustCreate(p, { seats: [std(stalls("G", 2))] });
      const unknown = await getHold(p.venueId, MISSING, a.token);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.body).toBe(JSON.stringify({ error: "not_found" }));

      const attempts: [string, string | undefined][] = [
        ["wrong", "C".repeat(43)],
        ["other hold's", b.token],
        ["missing", undefined],
        ["malformed", "short"],
        ["near miss", a.token.slice(0, 42) + (a.token.endsWith("A") ? "B" : "A")],
      ];
      for (const [name, t] of attempts) {
        for (const call of [getHold, extend, release]) {
          const r = await call(p.venueId, a.holdId, t);
          expect(r.statusCode, `${name} ${call.name}`).toBe(404);
          expect(r.body, name).toBe(unknown.body);
          expect(r.headers["content-length"]).toBe(unknown.headers["content-length"]);
        }
      }
      // None of that changed hold A.
      const v = HoldView.parse((await getHold(p.venueId, a.holdId, a.token)).json());
      expect(v.status).toBe("active");
      expect(v.extensionsRemaining).toBe(10);
    });

    it("a hold's right token under another venue's path is 404", async () => {
      const p = await studioPerf();
      const t = await theatrePerf();
      const h = await mustCreate(p, { seats: [std(stalls("G", 3))] });
      for (const call of [getHold, extend, release]) {
        const r = await call(t.venueId, h.holdId, h.token);
        expect(r.statusCode).toBe(404);
        expect(r.json()).toEqual({ error: "not_found" });
      }
      expect(HoldView.parse((await getHold(p.venueId, h.holdId, h.token)).json()).status).toBe(
        "active",
      );
    });

    it("venue B's performance, section and seat under venue A's path: 404 or 422, never 500", async () => {
      const p = await studioPerf();
      const t = await theatrePerf();
      const theatreSeat = graph.layouts.find((l) => l.venueId === t.venueId)!.sections[0]!.seats[5]!
        .id;
      const arenaFloor = seedId("section", ARENA, "Concert", "Floor");

      const crossPerf = await create(t, { seats: [std(theatreSeat)] }, p.venueId);
      expect(crossPerf.statusCode).toBe(404);
      expect(ErrorBody.parse(crossPerf.json())).toEqual({ error: "not_found" });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/venues/${p.venueId}/performances/${t.id}/availability`,
          })
        ).statusCode,
      ).toBe(404);

      const crossSeat = await create(p, { seats: [std(theatreSeat)] });
      const crossSection = await create(p, { ga: [{ sectionId: arenaFloor, quantity: 1 }] });
      for (const r of [crossSeat, crossSection]) {
        expect([404, 422]).toContain(r.statusCode);
        expect(r.statusCode).not.toBe(500);
      }
      // Nothing was held on either performance.
      expect((await avail(p)).heldSeatIds).toEqual([]);
      expect((await avail(t)).heldSeatIds).toEqual([]);
    });
  });

  describe("AC 14 token storage and logs", () => {
    it("DB holds a 32-byte hash that is not the token, and the token is nowhere in the hold rows or outbox", async () => {
      const p = await studioPerf();
      const h = await mustCreate(p, {
        seats: [
          { seatId: stalls("J", 1), role: "access", accessNeed: "hearing_loop" },
          { seatId: stalls("J", 2), role: "companion" },
        ],
      });
      const rows = await sql<{ token_hash: Buffer; as_text: string }[]>`
        select token_hash, row_to_json(h)::text as as_text from hold h where id = ${h.holdId}`;
      const row = rows[0]!;
      expect(Buffer.isBuffer(row.token_hash)).toBe(true);
      expect(row.token_hash.length).toBe(32);
      const hash = Buffer.from(row.token_hash);
      expect(hash.equals(Buffer.from(h.token, "base64url"))).toBe(false);
      expect(hash.toString("utf8")).not.toBe(h.token);
      expect(hash.toString("hex")).not.toBe(h.token);
      expect(hash.toString("base64url")).not.toBe(h.token);
      expect(hash.equals(createHash("sha256").update(h.token).digest())).toBe(true);
      expect(row.as_text).not.toContain(h.token);

      const outbox = await sql<
        { t: string }[]
      >`select payload::text t from outbox where aggregate_id = ${h.holdId}`;
      expect(outbox.length).toBeGreaterThan(0);
      for (const o of outbox) {
        expect(o.t).not.toContain(h.token);
        expect(o.t).not.toContain("hearing_loop");
      }
    });

    it("captured API logs for the whole run contain no token, access need or hold-token header", () => {
      expect(tokens.length).toBeGreaterThan(10);
      expect(logLines.length).toBeGreaterThan(0);
      const all = logLines.join("\n");
      for (const t of tokens) expect(all.includes(t)).toBe(false);
      for (const need of ["wheelchair_space", "hearing_loop", "transfer_seat", "accessNeed"]) {
        expect(all).not.toContain(need);
      }
      expect(all.toLowerCase()).not.toContain("hold-token");
    });
  });

  describe("AC 15 availability", () => {
    it("reports only active holds: held seats and per-GA-section held/capacity", async () => {
      const p = await studioPerf();
      const live = await mustCreate(p, {
        seats: [std(stalls("H", 1))],
        ga: [{ sectionId: STANDING, quantity: 7 }],
      });
      const dead = await mustCreate(p, {
        seats: [std(stalls("H", 2))],
        ga: [{ sectionId: STANDING, quantity: 3 }],
      });
      const rel = await mustCreate(p, { seats: [std(stalls("H", 3))] });
      await sql`update hold set expires_at = now() - interval '1 second' where id = ${dead.holdId}`;
      await release(p.venueId, rel.holdId, rel.token);
      const a = await avail(p);
      expect(a.performanceId).toBe(p.id);
      expect(a.heldSeatIds).toEqual([stalls("H", 1)]);
      expect(a.ga).toEqual([{ sectionId: STANDING, held: 7, capacity: 200 }]);
      expect(Math.abs(Date.parse(a.asOf) - Date.now())).toBeLessThan(60_000);
      expect(live.holdId).toBeTruthy();
    });

    it("an empty performance returns empty held list and zero GA held", async () => {
      const p = await studioPerf();
      const a = await avail(p);
      expect(a.heldSeatIds).toEqual([]);
      expect(a.ga).toEqual([{ sectionId: STANDING, held: 0, capacity: 200 }]);
    });

    it("arena (5,000 seats) responds with median of 5 under 1 s, with holds in place", async () => {
      const p = await perf(ARENA, "midnight-circuit-live", "Concert");
      const arena = graph.venues.find((v) => v.slug === ARENA)!;
      const bowl = graph.layouts
        .find((l) => l.venueId === arena.id)!
        .sections.filter((s) => s.kind === "reserved")
        .flatMap((s) => s.seats)
        .filter((s) => s.accessFeatures.length === 0 && s.companionOf === null);
      expect(bowl.length).toBeGreaterThan(2000);
      // 300 holds of 5 seats = 1,500 held seats, plus the GA floor.
      const floor = seedId("section", ARENA, "Concert", "Floor");
      let held = 0;
      for (let batch = 0; batch < 15; batch += 1) {
        const rs = await Promise.all(
          Array.from({ length: 20 }, (_, k) => {
            const start = (batch * 20 + k) * 5;
            const seats = bowl.slice(start, start + 5).map((s) => std(s.id));
            return create(p, { seats, ga: k === 0 ? [{ sectionId: floor, quantity: 2 }] : [] });
          }),
        );
        for (const r of rs) {
          expect(r.statusCode, r.body).toBe(201);
          tokens.push(HoldCreated.parse(r.json()).token);
          held += 5;
        }
      }
      expect(held).toBe(1500);

      const warm = await avail(p);
      expect(warm.heldSeatIds).toHaveLength(1500);
      const times: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const t0 = performance.now();
        const r = await app.inject({ method: "GET", url: availUrl(p) });
        times.push(performance.now() - t0);
        expect(r.statusCode).toBe(200);
      }
      times.sort((a, b) => a - b);
      console.log("ARENA AVAILABILITY ms:", times.map((t) => t.toFixed(1)).join(", "));
      expect(times[2]!).toBeLessThan(1000);
    });
  });

  describe("50-way race through the HTTP layer", () => {
    it("60 concurrent creates for one seat: exactly one 201, the rest 409 listing that seat", async () => {
      const p = await studioPerf();
      const seat = stalls("I", 5);
      const rs = await Promise.all(
        Array.from({ length: 60 }, () => create(p, { seats: [std(seat)] })),
      );
      const wins = rs.filter((r) => r.statusCode === 201);
      const losses = rs.filter((r) => r.statusCode === 409);
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(59);
      for (const l of losses) expect(SeatsUnavailableBody.parse(l.json()).seatIds).toEqual([seat]);
      for (const w of wins) tokens.push(HoldCreated.parse(w.json()).token);
      const dup = await sql`
        select seat_id from hold_seat where performance_id = ${p.id} and ended_at is null
        group by seat_id having count(*) > 1`;
      expect(dup).toHaveLength(0);
    });
  });

  // Last: stops the database underneath the running app.
  it("DB drops while running: hold routes 503 unavailable, no internals, /health stays 200", async () => {
    const p = await studioPerf();
    const h = await mustCreate(p, { seats: [std(stalls("I", 1))] });
    await container.stop();
    const calls = [
      app.inject({ method: "GET", url: `/venues/${p.venueId}/performances/${p.id}` }),
      app.inject({ method: "GET", url: availUrl(p) }),
      create(p, { seats: [std(stalls("I", 2))] }),
      getHold(p.venueId, h.holdId, h.token),
      extend(p.venueId, h.holdId, h.token),
      release(p.venueId, h.holdId, h.token),
    ];
    for (const r of await Promise.all(calls)) {
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ error: "unavailable" });
      expect(r.body).not.toMatch(/postgres|ECONN|host|password|relation/i);
      expect(r.body).not.toContain(h.token);
    }
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(logLines.join("\n")).not.toContain(h.token);
  }, 120_000);
});
