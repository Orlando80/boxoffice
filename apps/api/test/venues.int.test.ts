import { createDb, runMigrations, type Db } from "@boxoffice/db";
import * as queries from "@boxoffice/db";
import {
  ErrorBody,
  EventDetail,
  EventSummary,
  LayoutView,
  VenueDetail,
  VenueSummary,
} from "@boxoffice/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp, type VenueRepository } from "../src/app.js";
import { buildSeed } from "../../../packages/db/src/seed/data.js";
import { seedDatabase } from "../../../packages/db/src/seed/run.js";

const MISSING = "99999999-9999-4999-8999-999999999999";

function repoFor(db: Db): VenueRepository {
  return {
    listVenues: () => queries.listVenues(db),
    getVenue: (v) => queries.getVenue(db, v),
    listLayouts: (v) => queries.listLayouts(db, v),
    listEvents: (v) => queries.listEvents(db, v),
    getEvent: (v, e) => queries.getEvent(db, v, e),
    getLayoutView: (v, l) => queries.getLayoutView(db, v, l),
  };
}

describe("venue API against seeded Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  const graph = buildSeed();
  const layoutsOf = (venueId: string) => graph.layouts.filter((l) => l.venueId === venueId);
  const eventsOf = (venueId: string) => graph.events.filter((e) => e.venueId === venueId);
  const get = (url: string) => app.inject({ method: "GET", url });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
    const url = container.getConnectionUri();
    await runMigrations(url);
    await seedDatabase(url, graph);
    let db: Db;
    ({ db, close } = createDb(url));
    app = buildApp(repoFor(db));
    await app.ready();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await close?.().catch(() => undefined);
    await container?.stop().catch(() => undefined);
  }, 60_000);

  it("seed has three venues (sanity)", () => {
    expect(graph.venues).toHaveLength(3);
  });

  it("AC5: all five endpoints parse with their contracts for each seed venue", async () => {
    const list = await get("/venues");
    expect(list.statusCode).toBe(200);
    const summaries = z.array(VenueSummary).parse(list.json());
    expect(summaries.map((v) => v.id).sort()).toEqual(graph.venues.map((v) => v.id).sort());

    for (const v of graph.venues) {
      const detail = await get(`/venues/${v.id}`);
      expect(detail.statusCode, v.name).toBe(200);
      const d = VenueDetail.parse(detail.json());
      expect(d.venue.id).toBe(v.id);
      expect(d.layouts.map((l) => l.id).sort()).toEqual(
        layoutsOf(v.id)
          .map((l) => l.id)
          .sort(),
      );
      expect(d.events.map((e) => e.id).sort()).toEqual(
        eventsOf(v.id)
          .map((e) => e.id)
          .sort(),
      );

      const evs = await get(`/venues/${v.id}/events`);
      expect(evs.statusCode).toBe(200);
      expect(z.array(EventSummary).parse(evs.json())).toHaveLength(eventsOf(v.id).length);

      for (const e of eventsOf(v.id)) {
        const r = await get(`/venues/${v.id}/events/${e.id}`);
        expect(r.statusCode, e.name).toBe(200);
        const body = EventDetail.parse(r.json());
        expect(body.performances).toHaveLength(e.performances.length);
        for (const p of body.performances) {
          expect(layoutsOf(v.id).map((l) => l.id)).toContain(p.layoutId);
        }
      }
      for (const l of layoutsOf(v.id)) {
        const r = await get(`/venues/${v.id}/layouts/${l.id}`);
        expect(r.statusCode, l.name).toBe(200);
        const body = LayoutView.parse(r.json());
        expect(body.venueId).toBe(v.id);
        const seatCount = body.sections.reduce(
          (n, s) => n + s.rows.reduce((m, row) => m + row.seats.length, 0),
          0,
        );
        const expected = l.sections.reduce((n, s) => n + s.seats.length, 0);
        expect(seatCount).toBe(expected);
      }
    }
  });

  it("AC6: cross-venue event and layout ids are 404 with the body of a missing id", async () => {
    const missingEvent = await get(`/venues/${graph.venues[0]!.id}/events/${MISSING}`);
    const missingLayout = await get(`/venues/${graph.venues[0]!.id}/layouts/${MISSING}`);
    expect(missingEvent.statusCode).toBe(404);
    expect(missingLayout.statusCode).toBe(404);
    let pairs = 0;
    for (const a of graph.venues) {
      for (const b of graph.venues) {
        if (a.id === b.id) continue;
        for (const e of eventsOf(b.id)) {
          const r = await get(`/venues/${a.id}/events/${e.id}`);
          expect(r.statusCode).toBe(404);
          expect(r.body).toBe(missingEvent.body);
          expect(r.headers["content-length"]).toBe(missingEvent.headers["content-length"]);
          pairs++;
        }
        for (const l of layoutsOf(b.id)) {
          const r = await get(`/venues/${a.id}/layouts/${l.id}`);
          expect(r.statusCode).toBe(404);
          expect(r.body).toBe(missingLayout.body);
          expect(r.headers["content-length"]).toBe(missingLayout.headers["content-length"]);
          pairs++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(0);
    expect(ErrorBody.parse(missingEvent.json())).toEqual({ error: "not_found" });
  });

  it("AC7: unknown ids are 404, malformed ids are 400, never 500", async () => {
    const v = graph.venues[0]!.id;
    const e = eventsOf(v)[0]!.id;
    const l = layoutsOf(v)[0]!.id;
    const notFound = [
      `/venues/${MISSING}`,
      `/venues/${MISSING}/events`,
      `/venues/${MISSING}/events/${e}`,
      `/venues/${MISSING}/layouts/${l}`,
      `/venues/${v}/events/${MISSING}`,
      `/venues/${v}/layouts/${MISSING}`,
      `/venues/00000000-0000-0000-0000-000000000000`,
      `/venues/ffffffff-ffff-ffff-ffff-ffffffffffff/events`,
    ];
    for (const u of notFound) {
      const r = await get(u);
      expect(r.statusCode, u).toBe(404);
      expect(r.json(), u).toEqual({ error: "not_found" });
    }
    const malformed = [
      "/venues/abc",
      "/venues/abc/events",
      `/venues/${v}/events/abc`,
      `/venues/${v}/layouts/abc`,
      `/venues/${v}%27%3B%20drop%20table%20venue%3B--`,
      `/venues/${v}/events/${e}x`,
      `/venues/${v}x`,
      "/venues/%00",
      "/venues/1",
    ];
    for (const u of malformed) {
      const r = await get(u);
      expect(r.statusCode, u).toBe(400);
      expect(r.json(), u).toEqual({ error: "bad_request" });
    }
  });

  it("uppercase UUIDs for real ids behave sensibly (never 500)", async () => {
    const v = graph.venues[0]!.id;
    const r = await get(`/venues/${v.toUpperCase()}`);
    console.log("UPPERCASE UUID STATUS:", r.statusCode);
    expect([200, 404]).toContain(r.statusCode);
  });

  it("AC8 (P5): arena layout, median of 5 after warm-up < 1000 ms, < 1 MB, all 5,000 seats", async () => {
    const arena = graph.layouts
      .map((l) => ({
        l,
        reserved: l.sections
          .filter((s) => s.kind === "reserved")
          .reduce((n, s) => n + s.seats.length, 0),
      }))
      .sort((a, b) => b.reserved - a.reserved)[0]!;
    expect(arena.reserved).toBe(5000);
    const url = `/venues/${arena.l.venueId}/layouts/${arena.l.id}`;

    const warm = await get(url);
    expect(warm.statusCode).toBe(200);

    const times: number[] = [];
    let last = warm;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      last = await get(url);
      times.push(performance.now() - t0);
      expect(last.statusCode).toBe(200);
    }
    times.sort((a, b) => a - b);
    const median = times[2]!;
    console.log(
      "ARENA LAYOUT ms:",
      times.map((t) => t.toFixed(1)).join(", "),
      "bytes:",
      Buffer.byteLength(last.body),
    );
    expect(median).toBeLessThan(1000);
    expect(Buffer.byteLength(last.body)).toBeLessThan(1024 * 1024);

    const view = LayoutView.parse(last.json());
    const got = new Set<string>();
    for (const s of view.sections) {
      if (s.kind !== "reserved") continue;
      for (const row of s.rows) for (const seat of row.seats) got.add(seat.id);
    }
    const want = arena.l.sections
      .filter((s) => s.kind === "reserved")
      .flatMap((s) => s.seats.map((x) => x.id));
    expect(want).toHaveLength(5000);
    expect(got.size).toBe(5000);
    for (const id of want) expect(got.has(id)).toBe(true);
  });

  it("concurrent reads give identical bodies (no cross-request state)", async () => {
    const v = graph.venues[0]!;
    const l = layoutsOf(v.id)[0]!;
    const bodies = await Promise.all(
      Array.from({ length: 30 }, () => get(`/venues/${v.id}/layouts/${l.id}`).then((r) => r.body)),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  // Last: stops the database underneath the running app.
  it("DB drops while running: venue routes 503 unavailable, /health stays 200", async () => {
    const v = graph.venues[0]!.id;
    await container.stop();
    for (const u of ["/venues", `/venues/${v}`, `/venues/${v}/events`]) {
      const r = await get(u);
      expect(r.statusCode, u).toBe(503);
      expect(r.json(), u).toEqual({ error: "unavailable" });
      expect(r.body).not.toMatch(/postgres|ECONN|host|password/i);
    }
    const h = await get("/health");
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ status: "ok" });
  }, 120_000);
});
