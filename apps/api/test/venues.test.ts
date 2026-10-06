import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErrorBody,
  EventDetail,
  EventSummary,
  HealthResponse,
  LayoutView,
  VenueDetail,
  VenueSummary,
} from "@boxoffice/contracts";
import { z } from "zod";
import { buildApp, type VenueRepository } from "../src/app.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LAYOUT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LAYOUT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MISSING = "99999999-9999-4999-8999-999999999999";
const SEAT_1 = "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1";
const SEAT_2 = "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2";
const SECRET = "SENTINEL-conn-refused-postgres://u:pw@internal-host:5432/db";

const venues = [
  { id: A, name: "Venue A (Example)", slug: "venue-a", timeZone: "Europe/London" },
  { id: B, name: "Venue B (Example)", slug: "venue-b", timeZone: "Europe/London" },
];
// Deliberately carries venueId (not in the contract) to prove it never leaks.
const events = [
  {
    id: EVENT_A,
    venueId: A,
    name: "Show A",
    slug: "show-a",
    description: "d",
    runningTimeMinutes: 90,
    ageGuidance: null,
  },
  {
    id: EVENT_B,
    venueId: B,
    name: "Show B",
    slug: "show-b",
    description: null,
    runningTimeMinutes: null,
    ageGuidance: "12+",
  },
];
const layouts = [
  { id: LAYOUT_A, venueId: A, name: "Layout A" },
  { id: LAYOUT_B, venueId: B, name: "Layout B" },
];

function layoutView(l: (typeof layouts)[number]) {
  return {
    id: l.id,
    venueId: l.venueId,
    name: l.name,
    sections: [
      {
        id: "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1",
        name: "Stalls",
        kind: "reserved" as const,
        gaCapacity: null,
        rows: [
          {
            label: "A",
            seats: [
              {
                id: SEAT_1,
                rowLabel: "A",
                seatLabel: "1",
                x: 0,
                y: 0,
                accessFeatures: ["wheelchair_space" as never],
                companionOf: null,
              },
              {
                id: SEAT_2,
                rowLabel: "A",
                seatLabel: "2",
                x: 1,
                y: 0,
                accessFeatures: [],
                companionOf: SEAT_1,
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Fake that enforces scoping the way the real queries do. */
function fakeRepo(): VenueRepository {
  return {
    listVenues: () => Promise.resolve(venues),
    getVenue: (v) => Promise.resolve(venues.find((x) => x.id === v) ?? null),
    listLayouts: (v) =>
      Promise.resolve(
        layouts.filter((l) => l.venueId === v).map((l) => ({ id: l.id, name: l.name })),
      ) as never,
    listEvents: (v) => Promise.resolve(events.filter((e) => e.venueId === v)),
    getEvent: (v, e) => {
      const ev = events.find((x) => x.id === e && x.venueId === v);
      return Promise.resolve(
        ev
          ? {
              ...ev,
              performances: [
                {
                  id: "abababab-abab-4bab-8bab-abababababab",
                  startsAt: new Date("2030-03-31T19:30:00.000Z"),
                  layoutId: ev.venueId === A ? LAYOUT_A : LAYOUT_B,
                  accessTags: [],
                },
              ],
            }
          : null,
      );
    },
    getLayoutView: (v, l) => {
      const lay = layouts.find((x) => x.id === l && x.venueId === v);
      return Promise.resolve(lay ? (layoutView(lay) as never) : null);
    },
  };
}

function throwingRepo(msg = SECRET): VenueRepository {
  const boom = () => Promise.reject(new Error(msg));
  return {
    listVenues: boom,
    getVenue: boom,
    listLayouts: boom,
    listEvents: boom,
    getEvent: boom,
    getLayoutView: boom,
  };
}

let app: ReturnType<typeof buildApp>;
afterEach(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: "GET", url });

describe("200 bodies parse with their contracts", () => {
  it("GET /venues", async () => {
    app = buildApp(fakeRepo());
    const res = await get("/venues");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(z.array(VenueSummary).parse(res.json())).toHaveLength(2);
  });
  it("GET /venues/:venueId includes layouts and events, nothing from the other venue", async () => {
    app = buildApp(fakeRepo());
    const res = await get(`/venues/${A}`);
    expect(res.statusCode).toBe(200);
    const body = VenueDetail.parse(res.json());
    expect(body.venue.id).toBe(A);
    expect(body.layouts).toEqual([{ id: LAYOUT_A, name: "Layout A" }]);
    expect(body.events.map((e) => e.id)).toEqual([EVENT_A]);
    expect(res.body).not.toContain(EVENT_B);
    expect(res.body).not.toContain(LAYOUT_B);
  });
  it("GET /venues/:venueId/events (no venueId leak from rows)", async () => {
    app = buildApp(fakeRepo());
    const res = await get(`/venues/${A}/events`);
    expect(res.statusCode).toBe(200);
    expect(z.array(EventSummary).parse(res.json())).toHaveLength(1);
    expect(res.body).not.toContain("venueId");
  });
  it("GET /venues/:venueId/events/:eventId serialises Dates as ISO", async () => {
    app = buildApp(fakeRepo());
    const res = await get(`/venues/${A}/events/${EVENT_A}`);
    expect(res.statusCode).toBe(200);
    const body = EventDetail.parse(res.json());
    expect(body.performances[0]!.startsAt).toBe("2030-03-31T19:30:00.000Z");
    expect(res.body).not.toContain("venueId");
  });
  it("GET /venues/:venueId/layouts/:layoutId", async () => {
    app = buildApp(fakeRepo());
    const res = await get(`/venues/${A}/layouts/${LAYOUT_A}`);
    expect(res.statusCode).toBe(200);
    const body = LayoutView.parse(res.json());
    expect(body.sections[0]!.rows[0]!.seats).toHaveLength(2);
  });
  it("passes the path venueId as the scope argument", async () => {
    const repo = fakeRepo();
    const getEvent = vi.spyOn(repo, "getEvent");
    const getLayoutView = vi.spyOn(repo, "getLayoutView");
    app = buildApp(repo);
    await get(`/venues/${A}/events/${EVENT_B}`);
    await get(`/venues/${B}/layouts/${LAYOUT_A}`);
    expect(getEvent).toHaveBeenCalledWith(A, EVENT_B);
    expect(getLayoutView).toHaveBeenCalledWith(B, LAYOUT_A);
  });
});

describe("404 not_found (AC 6, 7)", () => {
  const notFound = { error: "not_found" };

  it("cross-venue event: body byte-identical to a missing event", async () => {
    app = buildApp(fakeRepo());
    const cross = await get(`/venues/${A}/events/${EVENT_B}`);
    const missing = await get(`/venues/${A}/events/${MISSING}`);
    expect(cross.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(cross.body).toBe(missing.body);
    expect(cross.json()).toEqual(notFound);
    expect(ErrorBody.parse(cross.json())).toEqual(notFound);
    expect(cross.headers["content-type"]).toBe(missing.headers["content-type"]);
    expect(cross.headers["content-length"]).toBe(missing.headers["content-length"]);
  });
  it("cross-venue layout: body byte-identical to a missing layout", async () => {
    app = buildApp(fakeRepo());
    const cross = await get(`/venues/${A}/layouts/${LAYOUT_B}`);
    const missing = await get(`/venues/${A}/layouts/${MISSING}`);
    expect(cross.statusCode).toBe(404);
    expect(cross.body).toBe(missing.body);
    expect(cross.headers["content-length"]).toBe(missing.headers["content-length"]);
  });
  it("unknown venue: detail, events, event, layout all 404 with the same body", async () => {
    app = buildApp(fakeRepo());
    const urls = [
      `/venues/${MISSING}`,
      `/venues/${MISSING}/events`,
      `/venues/${MISSING}/events/${EVENT_A}`,
      `/venues/${MISSING}/layouts/${LAYOUT_A}`,
    ];
    for (const u of urls) {
      const res = await get(u);
      expect(res.statusCode, u).toBe(404);
      expect(res.body, u).toBe(JSON.stringify(notFound));
    }
  });
});

describe("400 bad_request for malformed ids", () => {
  const bad = ["not-a-uuid", "123", "11111111-1111-4111-8111-11111111111", "%20", "1;drop"];
  it.each(bad)(
    "venueId %j on every route is 400 ErrorBody, not Fastify's default shape",
    async (id) => {
      app = buildApp(fakeRepo());
      for (const u of [
        `/venues/${id}`,
        `/venues/${id}/events`,
        `/venues/${id}/events/${EVENT_A}`,
        `/venues/${id}/layouts/${LAYOUT_A}`,
      ]) {
        const res = await get(u);
        expect(res.statusCode, u).toBe(400);
        expect(res.json(), u).toStrictEqual({ error: "bad_request" });
        expect(res.body).not.toMatch(/statusCode|message|params|validation/i);
      }
    },
  );
  it("malformed eventId / layoutId are 400 even with a valid venue", async () => {
    app = buildApp(fakeRepo());
    for (const u of [`/venues/${A}/events/xyz`, `/venues/${A}/layouts/xyz`]) {
      const res = await get(u);
      expect(res.statusCode, u).toBe(400);
      expect(res.json()).toStrictEqual({ error: "bad_request" });
    }
  });
  it("malformed ids never reach the repository", async () => {
    const repo = fakeRepo();
    const spies = Object.keys(repo).map((k) => vi.spyOn(repo, k as keyof VenueRepository));
    app = buildApp(repo);
    await get(`/venues/nope/events/nope`);
    await get(`/venues/${A}/layouts/nope`);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("503 unavailable when the repository throws (failure mode: DB drops)", () => {
  const urls = [
    "/venues",
    `/venues/${A}`,
    `/venues/${A}/events`,
    `/venues/${A}/events/${EVENT_A}`,
    `/venues/${A}/layouts/${LAYOUT_A}`,
  ];
  it.each(urls)("%s -> 503 ErrorBody, no internals", async (u) => {
    app = buildApp(throwingRepo());
    const res = await get(u);
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(JSON.stringify({ error: "unavailable" }));
    expect(ErrorBody.parse(res.json())).toEqual({ error: "unavailable" });
    expect(res.body).not.toContain("SENTINEL");
    expect(res.body).not.toContain("postgres://");
    expect(JSON.stringify(res.headers)).not.toContain("SENTINEL");
  });
  it("synchronous throw and non-Error rejection also give 503", async () => {
    const repo = fakeRepo();
    repo.listVenues = () => {
      throw new Error(SECRET);
    };
    repo.getVenue = () => Promise.reject(SECRET) as never;
    app = buildApp(repo);
    expect((await get("/venues")).statusCode).toBe(503);
    const r = await get(`/venues/${A}`);
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain("SENTINEL");
  });
  it("DB drops midway through venue detail (getVenue ok, listLayouts throws)", async () => {
    const repo = fakeRepo();
    repo.listLayouts = () => Promise.reject(new Error(SECRET));
    app = buildApp(repo);
    const res = await get(`/venues/${A}`);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("SENTINEL");
  });
  it("a recovered DB serves 200 again (no sticky failure)", async () => {
    const repo = fakeRepo();
    let down = true;
    const ok = repo.listVenues;
    repo.listVenues = () => (down ? Promise.reject(new Error(SECRET)) : ok());
    app = buildApp(repo);
    expect((await get("/venues")).statusCode).toBe(503);
    down = false;
    expect((await get("/venues")).statusCode).toBe(200);
  });
  it("the error is not logged with its message or URL", async () => {
    const lines: string[] = [];
    app = buildApp(throwingRepo());
    const spy = vi.spyOn(app.log, "error").mockImplementation(((...a: unknown[]) => {
      lines.push(JSON.stringify(a));
    }) as never);
    await app.ready();
    await get("/venues");
    spy.mockRestore();
    expect(lines.join("\n")).not.toContain("SENTINEL");
  });
});

describe("/health independence", () => {
  it("is 200 and HealthResponse while every repository call throws", async () => {
    const repo = throwingRepo();
    const spies = Object.keys(repo).map((k) => vi.spyOn(repo, k as keyof VenueRepository));
    app = buildApp(repo);
    const res = await get("/health");
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json())).toEqual({ status: "ok" });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
  it("stays 200 after venue routes returned 503", async () => {
    app = buildApp(throwingRepo());
    expect((await get("/venues")).statusCode).toBe(503);
    expect((await get("/health")).statusCode).toBe(200);
  });
});

describe("routing is unchanged", () => {
  it("unknown route 404 body is identical with and without venue routes", async () => {
    app = buildApp();
    const bare = await get("/nope");
    await app.close();
    app = buildApp(fakeRepo());
    const withRepo = await get("/nope");
    expect(withRepo.statusCode).toBe(404);
    expect(withRepo.body.replace(/\/nope/g, "")).toBe(bare.body.replace(/\/nope/g, ""));
  });
  it("venue routes are absent without a repository", async () => {
    app = buildApp();
    expect((await get("/venues")).statusCode).toBe(404);
  });
  it("unknown sub-path under /venues/:id is 404 (not 400/500)", async () => {
    app = buildApp(fakeRepo());
    expect((await get(`/venues/${A}/nope`)).statusCode).toBe(404);
    expect((await get(`/venues/${A}/events/${EVENT_A}/extra`)).statusCode).toBe(404);
  });
  it("non-GET methods on venue routes are not 2xx/5xx", async () => {
    app = buildApp(fakeRepo());
    const res = await app.inject({ method: "POST", url: "/venues" });
    expect(res.statusCode).toBe(404);
  });
});

describe("exploratory: handler-side failure outside the repository", () => {
  it("an invalid Date from the repo gives 503 unavailable without internals", async () => {
    const repo = fakeRepo();
    const orig = repo.getEvent;
    repo.getEvent = async (v, e) => {
      const r = await orig(v, e);
      return r && { ...r, performances: [{ ...r.performances[0]!, startsAt: new Date("x") }] };
    };
    app = buildApp(repo);
    const res = await get(`/venues/${A}/events/${EVENT_A}`);
    expect(res.statusCode).toBe(503);
    expect(res.body).toBe(JSON.stringify({ error: "unavailable" }));
    expect(res.body).not.toMatch(/Invalid time value|statusCode/);
    expect(res.body).not.toMatch(/Invalid time value|RangeError|at \w+/);
  });
});
