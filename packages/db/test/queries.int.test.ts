import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/client.js";
import { createHold, releaseHold } from "../src/holds.js";
import {
  getAvailability,
  getEvent,
  getLayoutView,
  getPerformance,
  getVenue,
  listEvents,
  listVenues,
  type LayoutView,
} from "../src/queries.js";
import { buildSeed, seedId } from "../src/seed/data.js";
import { seedDatabase } from "../src/seed/run.js";
import { futurePerformance } from "./support/performances.js";

describe("queries against the seeded database", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let close: () => Promise<void>;
  let sql: ReturnType<typeof postgres>;
  const graph = buildSeed();
  const byName = (n: string) => graph.venues.find((v) => v.name.startsWith(n))!;
  const studio = byName("Quillmarsh");
  const theatre = byName("Harbour");
  const arena = byName("Fernhollow");
  const eventsOf = (v: { id: string }) => graph.events.filter((e) => e.venueId === v.id);
  const layoutsOf = (v: { id: string }) => graph.layouts.filter((l) => l.venueId === v.id);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
    const url = container.getConnectionUri();
    await seedDatabase(url, graph);
    ({ db, close } = createDb(url));
    sql = postgres(url, { max: 1 });
  }, 180_000);
  afterAll(async () => {
    await close?.();
    await sql?.end();
    await container?.stop();
  }, 60_000);

  it("listVenues returns the three venues", async () => {
    const vs = await listVenues(db);
    expect(vs.map((v) => v.name)).toEqual([
      "Fernhollow Arena (Example)",
      "Harbour Lane Theatre (Example)",
      "Quillmarsh Studio (Example)",
    ]);
  });

  it.each([studio, theatre, arena])("getVenue returns $name", async (v) => {
    expect(await getVenue(db, v.id)).toEqual({
      id: v.id,
      name: v.name,
      slug: v.slug,
      timeZone: "Europe/London",
    });
  });

  it("getVenue of an unknown id is null", async () => {
    expect(await getVenue(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it.each([studio, theatre, arena])("listEvents returns only $name's events", async (v) => {
    const rows = await listEvents(db, v.id);
    expect(rows.map((e) => e.id).sort()).toEqual(
      eventsOf(v)
        .map((e) => e.id)
        .sort(),
    );
    expect(rows.every((e) => e.venueId === v.id)).toBe(true);
  });

  it("listEvents for an unknown venue is empty", async () => {
    expect(await listEvents(db, "00000000-0000-4000-8000-000000000000")).toEqual([]);
  });

  it("getEvent returns the event with its performances in time order", async () => {
    for (const v of [studio, theatre, arena]) {
      for (const e of eventsOf(v)) {
        const got = await getEvent(db, v.id, e.id);
        expect(got).not.toBeNull();
        expect(got!.name).toBe(e.name);
        expect(got!.performances.map((p) => p.id)).toEqual(
          [...e.performances]
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
            .map((p) => p.id),
        );
        for (const p of got!.performances) {
          const src = e.performances.find((x) => x.id === p.id)!;
          expect(p.layoutId).toBe(src.layoutId);
          expect([...p.accessTags].sort()).toEqual([...src.accessTags].sort());
        }
      }
    }
  });

  it("performances total 12 and the 2026-10-25 ones carry the UTC instant", async () => {
    let total = 0;
    for (const v of [studio, theatre, arena]) {
      for (const e of eventsOf(v)) {
        const got = (await getEvent(db, v.id, e.id))!;
        total += got.performances.length;
        for (const p of got.performances) expect(p.startsAt).toBeInstanceOf(Date);
      }
    }
    expect(total).toBe(12);
    const comedy = (await getEvent(db, studio.id, eventsOf(studio)[0]!.id))!;
    const p25 = comedy.performances.find((p) => p.startsAt.toISOString().startsWith("2026-10-25"))!;
    expect(p25.startsAt.toISOString()).toBe("2026-10-25T19:30:00.000Z");
    expect(p25.startsAt.getTime()).toBe(Date.UTC(2026, 9, 25, 19, 30));
    const p24 = comedy.performances.find((p) => p.startsAt.toISOString().startsWith("2026-10-24"))!;
    expect(p24.startsAt.toISOString()).toBe("2026-10-24T18:30:00.000Z");
    // Raw column agrees (timestamptz stored as an instant)
    const [raw] =
      await sql`select starts_at::text as t, pg_typeof(starts_at)::text as ty from performance where id = ${p25.id}`;
    expect(raw!.ty).toBe("timestamp with time zone");
  });

  it("cross-venue access returns null", async () => {
    const studioEvent = eventsOf(studio)[0]!;
    const theatreEvent = eventsOf(theatre)[0]!;
    const studioLayout = layoutsOf(studio)[0]!;
    const arenaLayout = layoutsOf(arena)[0]!;
    expect(await getEvent(db, theatre.id, studioEvent.id)).toBeNull();
    expect(await getEvent(db, studio.id, theatreEvent.id)).toBeNull();
    expect(await getEvent(db, arena.id, studioEvent.id)).toBeNull();
    expect(await getLayoutView(db, theatre.id, studioLayout.id)).toBeNull();
    expect(await getLayoutView(db, studio.id, arenaLayout.id)).toBeNull();
    expect(await getLayoutView(db, arena.id, studioLayout.id)).toBeNull();
    // same-venue still works
    expect(await getEvent(db, studio.id, studioEvent.id)).not.toBeNull();
    expect(await getLayoutView(db, studio.id, studioLayout.id)).not.toBeNull();
  });

  it("missing ids return null", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect(await getEvent(db, studio.id, ghost)).toBeNull();
    expect(await getLayoutView(db, studio.id, ghost)).toBeNull();
  });

  const seatsOf = (v: LayoutView) => v.sections.flatMap((s) => s.rows.flatMap((r) => r.seats));

  it("getLayoutView(arena) returns 5,000 reserved seats plus the GA floor", async () => {
    const l = layoutsOf(arena)[0]!;
    const view = (await getLayoutView(db, arena.id, l.id))!;
    expect(view.venueId).toBe(arena.id);
    expect(view.sections).toHaveLength(3);
    const floor = view.sections.find((s) => s.kind === "ga")!;
    expect(floor.gaCapacity).toBe(500);
    expect(floor.rows).toEqual([]);
    expect(
      view.sections.filter((s) => s.kind === "reserved").every((s) => s.gaCapacity === null),
    ).toBe(true);
    const seats = seatsOf(view);
    expect(seats).toHaveLength(5000);
    expect(new Set(seats.map((s) => s.id)).size).toBe(5000);

    // Every seat matches the source graph, including features and companionOf.
    const src = new Map(l.sections.flatMap((s) => s.seats).map((s) => [s.id, s] as const));
    for (const s of seats) {
      const e = src.get(s.id)!;
      expect(s.rowLabel).toBe(e.rowLabel);
      expect(s.seatLabel).toBe(e.seatLabel);
      expect([s.x, s.y]).toEqual([e.x, e.y]);
      expect([...s.accessFeatures].sort()).toEqual([...e.accessFeatures].sort());
      expect(s.companionOf).toBe(e.companionOf);
    }
  });

  it("companionOf and accessFeatures match the DB tables for every layout", async () => {
    const links = await sql`select access_seat_id, companion_seat_id from companion_link`;
    const feats = await sql`select seat_id, feature from seat_access_feature`;
    const allSeats = [];
    for (const v of [studio, theatre, arena]) {
      for (const l of layoutsOf(v)) {
        const view = (await getLayoutView(db, v.id, l.id))!;
        allSeats.push(...seatsOf(view));
      }
    }
    const comp = allSeats.filter((s) => s.companionOf !== null);
    expect(comp).toHaveLength(23);
    expect(links).toHaveLength(23);
    for (const r of links) {
      const s = allSeats.find((x) => x.id === r.companion_seat_id)!;
      expect(s.companionOf).toBe(r.access_seat_id);
    }
    const featCount = allSeats.reduce((n, s) => n + s.accessFeatures.length, 0);
    expect(featCount).toBe(40);
    expect(feats).toHaveLength(40);
    for (const r of feats) {
      expect(allSeats.find((x) => x.id === r.seat_id)!.accessFeatures).toContain(r.feature);
    }
  });

  it("getLayoutView per venue has the expected seat counts and rows", async () => {
    const counts: Record<string, number> = {};
    for (const v of [studio, theatre, arena]) {
      for (const l of layoutsOf(v)) {
        const view = (await getLayoutView(db, v.id, l.id))!;
        counts[`${v.slug}/${l.name}`] = seatsOf(view).length;
        for (const s of view.sections) {
          for (const r of s.rows) {
            expect(r.seats.every((x) => x.rowLabel === r.label)).toBe(true);
          }
        }
      }
    }
    expect(counts).toEqual({
      "quillmarsh-studio/Standing and stalls": 100,
      "quillmarsh-studio/All standing": 0,
      "harbour-lane-theatre/End-on": 1200,
      "fernhollow-arena/Concert": 5000,
    });
  });

  describe("getPerformance and getAvailability (step 5)", () => {
    const STUDIO = "quillmarsh-studio";
    const LAYOUT = "Standing and stalls";
    const STANDING = seedId("section", STUDIO, LAYOUT, "Standing");
    const seatId = (row: string, n: number) =>
      seedId("seat", STUDIO, LAYOUT, "Stalls", row, String(n));
    const UNKNOWN = "00000000-0000-4000-8000-000000000000";
    const studioPerf = () =>
      futurePerformance(sql, {
        venueSlug: STUDIO,
        eventSlug: "late-night-comedy",
        layoutName: LAYOUT,
        daysAhead: 7,
      });
    const hold = async (
      p: { venueId: string; id: string },
      seats: string[],
      gaQty = 0,
    ): Promise<{ holdId: string; token: string }> => {
      const r = await createHold(
        db,
        p.venueId,
        p.id,
        {
          seats: seats.map((s) => ({ seatId: s, role: "standard" as const })),
          ga: gaQty > 0 ? [{ sectionId: STANDING, quantity: gaQty }] : [],
        },
        { lengthSeconds: 600 },
      );
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    };

    it("getPerformance returns the row", async () => {
      const p = await studioPerf();
      const ev = graph.events.find(
        (e) => e.venueId === p.venueId && e.slug === "late-night-comedy",
      )!;
      const row = await getPerformance(db, p.venueId, p.id);
      expect(row).not.toBeNull();
      expect(row!.id).toBe(p.id);
      expect(row!.venueId).toBe(p.venueId);
      expect(row!.layoutId).toBe(p.layoutId);
      expect(row!.eventName).toBe(ev.name);
      expect(row!.eventId).toBe(ev.id);
      expect(row!.startsAt).toBeInstanceOf(Date);
      expect(row!.startsAt.getTime()).toBeGreaterThan(Date.now());
      expect(Array.isArray(row!.accessTags)).toBe(true);
    });

    it("getPerformance returns null for unknown and cross-venue ids", async () => {
      const p = await studioPerf();
      expect(await getPerformance(db, p.venueId, UNKNOWN)).toBeNull();
      expect(await getPerformance(db, theatre.id, p.id)).toBeNull();
      expect(await getPerformance(db, arena.id, p.id)).toBeNull();
    });

    it("getAvailability returns null for unknown and cross-venue ids", async () => {
      const p = await studioPerf();
      expect(await getAvailability(db, p.venueId, UNKNOWN)).toBeNull();
      expect(await getAvailability(db, theatre.id, p.id)).toBeNull();
    });

    it("no holds: empty seats, GA held 0 of capacity, asOf near DB now", async () => {
      const p = await studioPerf();
      const a = (await getAvailability(db, p.venueId, p.id))!;
      expect(a.performanceId).toBe(p.id);
      expect(a.heldSeatIds).toEqual([]);
      expect(a.ga).toEqual([{ sectionId: STANDING, held: 0, capacity: 200 }]);
      expect(a.asOf).toBeInstanceOf(Date);
      expect(Math.abs(a.asOf.getTime() - Date.now())).toBeLessThan(60_000);
    });

    it("counts active holds; heldSeatIds sorted; GA sums across holds", async () => {
      const p = await studioPerf();
      await hold(p, [seatId("C", 5), seatId("A", 2)], 3);
      await hold(p, [seatId("B", 9), seatId("A", 1)], 4);
      const a = (await getAvailability(db, p.venueId, p.id))!;
      const expected = [seatId("C", 5), seatId("A", 2), seatId("B", 9), seatId("A", 1)].sort();
      expect(a.heldSeatIds).toEqual(expected);
      expect(a.ga).toEqual([{ sectionId: STANDING, held: 7, capacity: 200 }]);
    });

    it("holds on another performance of the same layout are not counted", async () => {
      const p1 = await studioPerf();
      const p2 = await studioPerf();
      await hold(p1, [seatId("D", 1)], 5);
      const a = (await getAvailability(db, p2.venueId, p2.id))!;
      expect(a.heldSeatIds).toEqual([]);
      expect(a.ga[0]!.held).toBe(0);
    });

    it("released holds are not counted", async () => {
      const p = await studioPerf();
      const h = await hold(p, [seatId("E", 1)], 6);
      await hold(p, [seatId("E", 2)], 2);
      expect(await releaseHold(db, p.venueId, h.holdId, h.token)).not.toBeNull();
      const a = (await getAvailability(db, p.venueId, p.id))!;
      expect(a.heldSeatIds).toEqual([seatId("E", 2)]);
      expect(a.ga[0]!.held).toBe(2);
    });

    it("an overdue but not ended hold is NOT counted (H-8)", async () => {
      const p = await studioPerf();
      const overdue = await hold(p, [seatId("F", 1)], 9);
      await hold(p, [seatId("F", 2)], 1);
      await sql`update hold set expires_at = now() - interval '1 minute' where id = ${overdue.holdId}`;
      const row = await sql<{ status: string; ended_at: Date | null }[]>`
        select status, ended_at from hold where id = ${overdue.holdId}`;
      expect(row[0]!.status).toBe("active");
      expect(row[0]!.ended_at).toBeNull();
      const a = (await getAvailability(db, p.venueId, p.id))!;
      expect(a.heldSeatIds).toEqual([seatId("F", 2)]);
      expect(a.ga[0]!.held).toBe(1);
    });

    it("expired-status holds are not counted", async () => {
      const p = await studioPerf();
      const h = await hold(p, [seatId("G", 1)], 2);
      await sql`update hold set status = 'expired', ended_at = now() where id = ${h.holdId}`;
      await sql`update hold_seat set ended_at = now() where hold_id = ${h.holdId}`;
      await sql`update hold_ga set ended_at = now() where hold_id = ${h.holdId}`;
      const a = (await getAvailability(db, p.venueId, p.id))!;
      expect(a.heldSeatIds).toEqual([]);
      expect(a.ga[0]!.held).toBe(0);
    });

    it("a hold with expires_at in the future is counted", async () => {
      const p = await studioPerf();
      const h = await hold(p, [seatId("H", 1)]);
      await sql`update hold set expires_at = now() + interval '1 hour' where id = ${h.holdId}`;
      expect((await getAvailability(db, p.venueId, p.id))!.heldSeatIds).toEqual([seatId("H", 1)]);
    });

    it("arena: no holds gives 0 held seats, Floor 0 of 500, median of 5 under 1 s", async () => {
      const p = await futurePerformance(sql, {
        venueSlug: "fernhollow-arena",
        eventSlug: "midnight-circuit-live",
        layoutName: "Concert",
        daysAhead: 9,
      });
      const floor = seedId("section", "fernhollow-arena", "Concert", "Floor");
      const first = (await getAvailability(db, p.venueId, p.id))!;
      expect(first.heldSeatIds).toEqual([]);
      expect(first.ga).toEqual([{ sectionId: floor, held: 0, capacity: 500 }]);
      const times: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const t = performance.now();
        await getAvailability(db, p.venueId, p.id);
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      expect(times[2]!).toBeLessThan(1000);
    });

    it("arena with 1000 held seats stays under 1 s (median of 5) and is sorted", async () => {
      const p = await futurePerformance(sql, {
        venueSlug: "fernhollow-arena",
        eventSlug: "midnight-circuit-live",
        layoutName: "Concert",
        daysAhead: 10,
      });
      const ids = await sql<{ id: string }[]>`
        select s.id from seat s join section sec on sec.id = s.section_id
        where sec.layout_id = ${p.layoutId} and sec.kind = 'reserved'
          and s.id not in (select seat_id from seat_access_feature)
          and s.id not in (select companion_seat_id from companion_link)
          and s.id not in (select access_seat_id from companion_link)
        order by s.id limit 1000`;
      for (let i = 0; i < ids.length; i += 10) {
        const r = await createHold(
          db,
          p.venueId,
          p.id,
          {
            seats: ids.slice(i, i + 10).map((x) => ({ seatId: x.id, role: "standard" as const })),
            ga: [],
          },
          { lengthSeconds: 600 },
        );
        if (!r.ok) throw new Error(JSON.stringify(r.error));
      }
      const times: number[] = [];
      let last = await getAvailability(db, p.venueId, p.id);
      for (let i = 0; i < 5; i += 1) {
        const t = performance.now();
        last = await getAvailability(db, p.venueId, p.id);
        times.push(performance.now() - t);
      }
      expect(last!.heldSeatIds).toHaveLength(1000);
      expect(last!.heldSeatIds).toEqual([...last!.heldSeatIds].sort());
      times.sort((a, b) => a - b);
      expect(times[2]!).toBeLessThan(1000);
    }, 120_000);
  });
}, 300_000);
