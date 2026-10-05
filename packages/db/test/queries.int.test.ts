import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/client.js";
import {
  getEvent,
  getLayoutView,
  getVenue,
  listEvents,
  listVenues,
  type LayoutView,
} from "../src/queries.js";
import { buildSeed } from "../src/seed/data.js";
import { seedDatabase } from "../src/seed/run.js";

describe("queries against the seeded database", () => {
  let container: StartedPostgreSqlContainer;
  let db: Db;
  let close: () => Promise<void>;
  let sql: ReturnType<typeof postgres>;
  const graph = buildSeed();
  const byName = (n: string) => graph.venues.find((v) => v.name.startsWith(n))!;
  const studio = byName("Riverside");
  const theatre = byName("Harbour");
  const arena = byName("Northgate");
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
      "Harbour Lane Theatre (Example)",
      "Northgate Arena (Example)",
      "Riverside Studio (Example)",
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
      "riverside-studio/Standing and stalls": 100,
      "riverside-studio/All standing": 0,
      "harbour-lane-theatre/End-on": 1200,
      "northgate-arena/Concert": 5000,
    });
  });
}, 300_000);
