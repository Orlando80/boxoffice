import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErrorBody,
  HoldCreated,
  HoldView,
  InvalidHoldBody,
  PerformanceAvailability,
  PerformanceDetail,
  SeatsUnavailableBody,
} from "@boxoffice/contracts";
import { HOLD_VIOLATION_RULES } from "../../../packages/domain/src/index.js";
import { buildApp, type HoldRepository, type Repositories } from "../src/app.js";

const V = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const PERF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOLD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_HOLD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MISSING = "99999999-9999-4999-8999-999999999999";
const SEAT_1 = "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1";
const SEAT_2 = "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2";
const SECTION = "f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1";
const LAYOUT = "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1";
const EVENT = "d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2";
const SECRET = "SENTINEL-conn-refused-postgres://u:pw@internal-host:5432/db";

// 32 bytes as base64url, no padding = 43 characters.
const TOKEN = "A".repeat(43);
const OTHER_TOKEN = "B-_".repeat(14) + "Zz"; // 43 chars, uses - and _
const EXPIRES = new Date("2030-03-31T19:30:00.000Z");

const view = (holdId = HOLD, extensionsRemaining = 10) => ({
  holdId,
  performanceId: PERF,
  status: "active" as const,
  expiresAt: EXPIRES,
  extensionsRemaining,
  seats: [{ seatId: SEAT_1, role: "standard" as const }],
  ga: [{ sectionId: SECTION, quantity: 2 }],
});

/** Fake scoped like the real queries: venue V, hold HOLD (TOKEN) and OTHER_HOLD (OTHER_TOKEN). */
function fakeHolds(): HoldRepository {
  const tokens = new Map([
    [HOLD, TOKEN],
    [OTHER_HOLD, OTHER_TOKEN],
  ]);
  const owns = (v: string, h: string, t: string) => v === V && tokens.get(h) === t;
  let extensions = 10;
  return {
    getPerformance: (v, p) =>
      Promise.resolve(
        v === V && p === PERF
          ? {
              id: PERF,
              venueId: V,
              eventId: EVENT,
              eventName: "Show",
              startsAt: EXPIRES,
              layoutId: LAYOUT,
              accessTags: ["captioned" as const],
            }
          : null,
      ),
    getAvailability: (v, p) =>
      Promise.resolve(
        v === V && p === PERF
          ? {
              performanceId: PERF,
              asOf: EXPIRES,
              heldSeatIds: [SEAT_1],
              ga: [{ sectionId: SECTION, held: 2, capacity: 200 }],
            }
          : null,
      ),
    createHold: (v, p) =>
      Promise.resolve(
        v === V && p === PERF
          ? {
              ok: true as const,
              value: { holdId: HOLD, token: TOKEN, expiresAt: EXPIRES, extensionsRemaining: 10 },
            }
          : { ok: false as const, error: { code: "performance_not_found" as const } },
      ),
    getHold: (v, h, t) => Promise.resolve(owns(v, h, t) ? view(h) : null),
    extendHold: (v, h, t) => {
      if (!owns(v, h, t)) return Promise.resolve(null);
      extensions -= 1;
      return Promise.resolve({ ok: true as const, value: view(h, extensions) });
    },
    releaseHold: (v, h, t) =>
      Promise.resolve(owns(v, h, t) ? { ...view(h), status: "released" as const } : null),
  };
}

function throwingHolds(): HoldRepository {
  const boom = () => Promise.reject(new Error(SECRET));
  return {
    getPerformance: boom,
    getAvailability: boom,
    createHold: boom,
    getHold: boom,
    extendHold: boom,
    releaseHold: boom,
  };
}

/** Minimal venue repo, so the venue routes are registered alongside the hold routes. */
const venueRepo = {
  listVenues: () =>
    Promise.resolve([{ id: V, name: "Venue", slug: "venue", timeZone: "Europe/London" }]),
  getVenue: () => Promise.resolve(null),
  listLayouts: () => Promise.resolve([]),
  listEvents: () => Promise.resolve([]),
  getEvent: () => Promise.resolve(null),
  getLayoutView: () => Promise.resolve(null),
} as unknown as Omit<Repositories, "holds">;

let app: ReturnType<typeof buildApp>;
const make = (holds: HoldRepository, opts?: Parameters<typeof buildApp>[1]) => {
  app = buildApp({ ...venueRepo, holds }, opts);
  return app;
};
afterEach(async () => {
  await app.close();
});

const tok = (t?: string) => (t === undefined ? {} : { "hold-token": t });
const get = (url: string, t?: string) => app.inject({ method: "GET", url, headers: tok(t) });
const post = (url: string, payload?: unknown, t?: string) =>
  app.inject({ method: "POST", url, payload: payload as never, headers: tok(t) });
const del = (url: string, t?: string) => app.inject({ method: "DELETE", url, headers: tok(t) });

const CREATE = `/venues/${V}/performances/${PERF}/holds`;
const holdUrl = (h = HOLD, v = V) => `/venues/${v}/holds/${h}`;
const body = {
  seats: [{ seatId: SEAT_1, role: "standard" }],
  ga: [{ sectionId: SECTION, quantity: 2 }],
};

describe("success paths parse with their contracts", () => {
  it("GET performance -> 200 PerformanceDetail with ISO startsAt", async () => {
    make(fakeHolds());
    const r = await get(`/venues/${V}/performances/${PERF}`);
    expect(r.statusCode).toBe(200);
    const b = PerformanceDetail.parse(r.json());
    expect(b.startsAt).toBe("2030-03-31T19:30:00.000Z");
    expect(b.accessTags).toEqual(["captioned"]);
  });
  it("GET availability -> 200 PerformanceAvailability with ISO asOf", async () => {
    make(fakeHolds());
    const r = await get(`/venues/${V}/performances/${PERF}/availability`);
    expect(r.statusCode).toBe(200);
    const b = PerformanceAvailability.parse(r.json());
    expect(b.asOf).toBe("2030-03-31T19:30:00.000Z");
    expect(b.heldSeatIds).toEqual([SEAT_1]);
    expect(b.ga).toEqual([{ sectionId: SECTION, held: 2, capacity: 200 }]);
  });
  it("POST create -> 201 HoldCreated, repo gets path ids and the body", async () => {
    const repo = fakeHolds();
    const spy = vi.spyOn(repo, "createHold");
    make(repo);
    const r = await post(CREATE, body);
    expect(r.statusCode).toBe(201);
    expect(HoldCreated.parse(r.json())).toEqual({
      holdId: HOLD,
      token: TOKEN,
      expiresAt: "2030-03-31T19:30:00.000Z",
      extensionsRemaining: 10,
    });
    expect(spy).toHaveBeenCalledWith(V, PERF, body);
  });
  it("GET hold -> 200 HoldView with no token", async () => {
    make(fakeHolds());
    const r = await get(holdUrl(), TOKEN);
    expect(r.statusCode).toBe(200);
    const b = HoldView.parse(r.json());
    expect(b.expiresAt).toBe("2030-03-31T19:30:00.000Z");
    expect(r.body).not.toContain(TOKEN);
    expect(r.body).not.toMatch(/token|accessNeed/i);
  });
  it("POST extend -> 200 HoldView, remaining decrements", async () => {
    make(fakeHolds());
    const r = await post(`${holdUrl()}/extend`, undefined, TOKEN);
    expect(r.statusCode).toBe(200);
    expect(HoldView.parse(r.json()).extensionsRemaining).toBe(9);
  });
  it("DELETE -> 200 HoldView released", async () => {
    make(fakeHolds());
    const r = await del(holdUrl(), TOKEN);
    expect(r.statusCode).toBe(200);
    expect(HoldView.parse(r.json()).status).toBe("released");
  });
  it("create body defaults: {} reaches the repo as empty seats and ga", async () => {
    const repo = fakeHolds();
    const spy = vi.spyOn(repo, "createHold");
    make(repo);
    const r = await post(CREATE, {});
    expect(r.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledWith(V, PERF, { seats: [], ga: [] });
  });
});

describe("error mapping", () => {
  it("unknown / cross-venue performance: detail, availability and create are 404 not_found", async () => {
    make(fakeHolds());
    for (const u of [
      `/venues/${V}/performances/${MISSING}`,
      `/venues/${V2}/performances/${PERF}`,
      `/venues/${V}/performances/${MISSING}/availability`,
      `/venues/${V2}/performances/${PERF}/availability`,
    ]) {
      const r = await get(u);
      expect(r.statusCode, u).toBe(404);
      expect(r.body, u).toBe(JSON.stringify({ error: "not_found" }));
    }
    for (const u of [
      `/venues/${V}/performances/${MISSING}/holds`,
      `/venues/${V2}/performances/${PERF}/holds`,
    ]) {
      const r = await post(u, body);
      expect(r.statusCode, u).toBe(404);
      expect(r.body, u).toBe(JSON.stringify({ error: "not_found" }));
    }
  });

  it("409 seats_unavailable parses as SeatsUnavailableBody with exactly the repo's ids", async () => {
    const repo = fakeHolds();
    repo.createHold = () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: "seats_unavailable" as const,
          seatIds: [SEAT_1, SEAT_2],
          sectionIds: [SECTION],
        },
      });
    make(repo);
    const r = await post(CREATE, body);
    expect(r.statusCode).toBe(409);
    expect(SeatsUnavailableBody.parse(r.json())).toEqual({
      error: "seats_unavailable",
      seatIds: [SEAT_1, SEAT_2],
      sectionIds: [SECTION],
    });
  });

  it.each(HOLD_VIOLATION_RULES)(
    "422 invalid_hold %s parses as InvalidHoldBody, no violation detail leaks",
    async (rule) => {
      const repo = fakeHolds();
      repo.createHold = () =>
        Promise.resolve({
          ok: false as const,
          error: {
            code: "invalid_hold" as const,
            rule,
            violations: [{ rule, item: `seat:${SEAT_1}`, message: "SENTINEL-detail" }],
          },
        });
      make(repo);
      const r = await post(CREATE, body);
      expect(r.statusCode).toBe(422);
      expect(InvalidHoldBody.parse(r.json())).toEqual({ error: "invalid_hold", rule });
      expect(r.body).not.toContain("SENTINEL");
      expect(r.body).not.toContain(SEAT_1);
    },
  );

  it("extend: 409 extension_limit and hold_ended parse as ErrorBody", async () => {
    const repo = fakeHolds();
    make(repo);
    for (const code of ["extension_limit", "hold_ended"] as const) {
      repo.extendHold = () => Promise.resolve({ ok: false as const, error: code });
      const r = await post(`${holdUrl()}/extend`, undefined, TOKEN);
      expect(r.statusCode, code).toBe(409);
      expect(ErrorBody.parse(r.json())).toEqual({ error: code });
    }
  });

  it("malformed path ids are 400 bad_request on every route and never reach the repo", async () => {
    const repo = fakeHolds();
    const spies = (Object.keys(repo) as (keyof HoldRepository)[]).map((k) => vi.spyOn(repo, k));
    make(repo);
    const results = await Promise.all([
      get(`/venues/nope/performances/${PERF}`),
      get(`/venues/${V}/performances/nope`),
      get(`/venues/${V}/performances/nope/availability`),
      post(`/venues/${V}/performances/nope/holds`, body),
      post(`/venues/nope/performances/${PERF}/holds`, body),
      get(`/venues/${V}/holds/nope`, TOKEN),
      post(`/venues/${V}/holds/nope/extend`, undefined, TOKEN),
      del(`/venues/nope/holds/${HOLD}`, TOKEN),
    ]);
    for (const r of results) {
      expect(r.statusCode).toBe(400);
      expect(r.body).toBe(JSON.stringify({ error: "bad_request" }));
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it.each([
    ["extra top-level key", { ...body, extra: 1 }],
    ["extra seat key", { seats: [{ seatId: SEAT_1, role: "standard", x: 1 }] }],
    ["bad role", { seats: [{ seatId: SEAT_1, role: "vip" }] }],
    ["non-uuid seat", { seats: [{ seatId: "x", role: "standard" }] }],
    ["unknown access need", { seats: [{ seatId: SEAT_1, role: "access", accessNeed: "banana" }] }],
    ["zero quantity", { ga: [{ sectionId: SECTION, quantity: 0 }] }],
    ["fractional quantity", { ga: [{ sectionId: SECTION, quantity: 1.5 }] }],
    ["string quantity", { ga: [{ sectionId: SECTION, quantity: "2" }] }],
    ["seats not an array", { seats: "x" }],
    ["null body", null],
    ["array body", []],
  ])("create with %s is 400 bad_request and never reaches the repo", async (_n, payload) => {
    const repo = fakeHolds();
    const spy = vi.spyOn(repo, "createHold");
    make(repo);
    const r = await post(CREATE, payload);
    expect(r.statusCode).toBe(400);
    expect(r.body).toBe(JSON.stringify({ error: "bad_request" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("create with no body at all is 400, not 500", async () => {
    make(fakeHolds());
    const r = await app.inject({ method: "POST", url: CREATE });
    expect(r.statusCode).toBe(400);
    expect(r.body).toBe(JSON.stringify({ error: "bad_request" }));
  });

  it.each([
    ["malformed JSON", "{not json", "application/json"],
    ["empty JSON body", "", "application/json"],
    ["unsupported media type", "<a/>", "application/xml"],
  ])("create with %s is a 4xx bad_request, not 503 unavailable", async (_n, payload, ct) => {
    make(fakeHolds());
    const r = await app.inject({
      method: "POST",
      url: CREATE,
      headers: { "content-type": ct },
      payload,
    });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
    expect(r.body).not.toContain("unavailable");
  });
});

describe("client errors are 400 bad_request and not error-logged", () => {
  const cases: [string, string, string][] = [
    ["malformed JSON", "{not json", "application/json"],
    ["empty JSON body", "", "application/json"],
    ["unsupported media type", "<a/>", "application/xml"],
    ["2 MB payload", "x".repeat(2_000_000), "application/json"],
  ];
  it.each(cases)("%s -> exactly 400 bad_request, no error-level log, repo untouched", async (_n, payload, ct) => {
    const lines: string[] = [];
    const repo = fakeHolds();
    const spy = vi.spyOn(repo, "createHold");
    make(repo, { logger: { level: "info", stream: { write: (s: string) => void lines.push(s) } } });
    const r = await app.inject({ method: "POST", url: CREATE, headers: { "content-type": ct }, payload });
    expect(r.statusCode).toBe(400);
    expect(r.body).toBe(JSON.stringify({ error: "bad_request" }));
    expect(spy).not.toHaveBeenCalled();
    const levels = lines.map((l) => (JSON.parse(l) as { level: number }).level);
    expect(levels.length).toBeGreaterThan(0);
    expect(Math.max(...levels)).toBeLessThan(50); // pino error = 50
  });
  it("a genuine 503 still logs at error level", async () => {
    const lines: string[] = [];
    make(throwingHolds(), { logger: { level: "info", stream: { write: (s: string) => void lines.push(s) } } });
    expect((await post(CREATE, body)).statusCode).toBe(503);
    expect(lines.some((l) => (JSON.parse(l) as { level: number }).level >= 50)).toBe(true);
  });
});

describe("Hold-Token handling (AC 13)", () => {
  const unknown = async () => get(holdUrl(MISSING), TOKEN);

  const badTokens: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["short", "abc"],
    ["42 chars", "A".repeat(42)],
    ["44 chars", "A".repeat(44)],
    ["padded base64", "A".repeat(42) + "="],
    ["standard base64 plus", "A".repeat(42) + "+"],
    ["standard base64 slash", "A".repeat(42) + "/"],
    ["whitespace", " ".repeat(43)],
    ["leading space", " " + "A".repeat(42)],
    ["sql", "' or 1=1 --" + "A".repeat(32)],
    ["bearer prefix", "Bearer " + TOKEN],
  ];
  const routes: [string, (t?: string) => Promise<LightMyRequestResponse>][] = [
    ["GET", (t) => get(holdUrl(), t)],
    ["extend", (t) => post(`${holdUrl()}/extend`, undefined, t)],
    ["DELETE", (t) => del(holdUrl(), t)],
  ];

  it.each(badTokens)(
    "%s token: 404 body identical to an unknown hold, on every route",
    async (_n, t) => {
      make(fakeHolds());
      const ref = await unknown();
      expect(ref.statusCode).toBe(404);
      expect(ref.body).toBe(JSON.stringify({ error: "not_found" }));
      for (const [name, call] of routes) {
        const r = await call(t);
        expect(r.statusCode, name).toBe(404);
        expect(r.body, name).toBe(ref.body);
        expect(r.headers["content-type"], name).toBe(ref.headers["content-type"]);
        expect(r.headers["content-length"], name).toBe(ref.headers["content-length"]);
      }
    },
  );

  it("malformed or missing tokens never reach the repo (no DB call, no timing signal)", async () => {
    const repo = fakeHolds();
    const spies = [
      vi.spyOn(repo, "getHold"),
      vi.spyOn(repo, "extendHold"),
      vi.spyOn(repo, "releaseHold"),
    ];
    make(repo);
    for (const [, t] of badTokens) for (const [, call] of routes) await call(t);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("wrong (well-formed) token, other hold's token, and wrong venue are all the same 404", async () => {
    make(fakeHolds());
    const ref = await unknown();
    const wrong = "C".repeat(43);
    const cases = [
      [HOLD, wrong, V],
      [HOLD, OTHER_TOKEN, V], // another hold's token
      [OTHER_HOLD, TOKEN, V],
      [HOLD, TOKEN, V2], // right token, other venue
      [MISSING, TOKEN, V],
    ] as const;
    for (const [h, t, v] of cases) {
      for (const [name, call] of [
        ["GET", () => get(holdUrl(h, v), t)],
        ["extend", () => post(`${holdUrl(h, v)}/extend`, undefined, t)],
        ["DELETE", () => del(holdUrl(h, v), t)],
      ] as const) {
        const r = await call();
        expect(r.statusCode, `${name} ${h} ${t}`).toBe(404);
        expect(r.body).toBe(ref.body);
        expect(r.headers["content-length"]).toBe(ref.headers["content-length"]);
      }
    }
  });

  it("a valid token passes through unmodified to the repo", async () => {
    const repo = fakeHolds();
    const g = vi.spyOn(repo, "getHold");
    const e = vi.spyOn(repo, "extendHold");
    const d = vi.spyOn(repo, "releaseHold");
    make(repo);
    await get(holdUrl(), TOKEN);
    await post(`${holdUrl()}/extend`, undefined, TOKEN);
    await del(holdUrl(), TOKEN);
    expect(g).toHaveBeenCalledWith(V, HOLD, TOKEN);
    expect(e).toHaveBeenCalledWith(V, HOLD, TOKEN);
    expect(d).toHaveBeenCalledWith(V, HOLD, TOKEN);
  });

  it("a token in the query string or body is not accepted", async () => {
    make(fakeHolds());
    expect((await get(`${holdUrl()}?token=${TOKEN}`)).statusCode).toBe(404);
    expect((await get(`${holdUrl()}?hold-token=${TOKEN}`)).statusCode).toBe(404);
  });

  it("bad path id with no token: 400 (path validation first), unknown hold with no token: 404", async () => {
    make(fakeHolds());
    expect((await get(`/venues/${V}/holds/nope`)).statusCode).toBe(400);
    expect((await get(holdUrl(MISSING))).statusCode).toBe(404);
  });
});

describe("503 unavailable when the repository throws", () => {
  const calls: [string, () => Promise<LightMyRequestResponse>][] = [
    ["performance", () => get(`/venues/${V}/performances/${PERF}`)],
    ["availability", () => get(`/venues/${V}/performances/${PERF}/availability`)],
    ["create", () => post(CREATE, body)],
    ["get hold", () => get(holdUrl(), TOKEN)],
    ["extend", () => post(`${holdUrl()}/extend`, undefined, TOKEN)],
    ["release", () => del(holdUrl(), TOKEN)],
  ];
  it.each(calls)("%s -> 503 ErrorBody, no internals", async (_n, call) => {
    make(throwingHolds());
    const r = await call();
    expect(r.statusCode).toBe(503);
    expect(r.body).toBe(JSON.stringify({ error: "unavailable" }));
    expect(ErrorBody.parse(r.json())).toEqual({ error: "unavailable" });
    expect(r.body).not.toContain("SENTINEL");
    expect(JSON.stringify(r.headers)).not.toContain("SENTINEL");
    expect(r.body).not.toContain(TOKEN);
  });

  it("synchronous throw and non-Error rejection also give 503", async () => {
    const repo = fakeHolds();
    repo.createHold = () => {
      throw new Error(SECRET);
    };
    repo.getHold = () => Promise.reject(SECRET) as never;
    make(repo);
    for (const r of [await post(CREATE, body), await get(holdUrl(), TOKEN)]) {
      expect(r.statusCode).toBe(503);
      expect(r.body).not.toContain("SENTINEL");
    }
  });

  it("a repo result the serializer rejects (invalid Date) is 503 without internals", async () => {
    const repo = fakeHolds();
    repo.getHold = () => Promise.resolve({ ...view(), expiresAt: new Date("x") });
    make(repo);
    const r = await get(holdUrl(), TOKEN);
    expect(r.statusCode).toBe(503);
    expect(r.body).toBe(JSON.stringify({ error: "unavailable" }));
  });

  it("503s do not break /health or later requests", async () => {
    const repo = fakeHolds();
    let down = true;
    const ok = repo.getPerformance;
    repo.getPerformance = (v, p) => (down ? Promise.reject(new Error(SECRET)) : ok(v, p));
    make(repo);
    expect((await get(`/venues/${V}/performances/${PERF}`)).statusCode).toBe(503);
    expect((await get("/health")).statusCode).toBe(200);
    down = false;
    expect((await get(`/venues/${V}/performances/${PERF}`)).statusCode).toBe(200);
  });
});

describe("routing and venue routes unchanged", () => {
  it("hold routes are absent without repos.holds; venue routes still work", async () => {
    app = buildApp(venueRepo as Repositories);
    expect((await get(`/venues/${V}/performances/${PERF}`)).statusCode).toBe(404);
    expect((await post(CREATE, body)).statusCode).toBe(404);
    expect((await get("/venues")).statusCode).toBe(200);
  });
  it("venue routes behave the same with hold routes registered", async () => {
    make(fakeHolds());
    const r = await get("/venues");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
    expect((await get("/venues/not-a-uuid")).json()).toEqual({ error: "bad_request" });
    expect((await get(`/venues/${V}`)).json()).toEqual({ error: "not_found" });
  });
  it("wrong methods on hold URLs are 404 or 405, never 2xx or 5xx", async () => {
    make(fakeHolds());
    for (const [method, url] of [
      ["PUT", holdUrl()],
      ["PATCH", holdUrl()],
      ["GET", `${holdUrl()}/extend`],
      ["DELETE", CREATE],
      ["POST", `/venues/${V}/performances/${PERF}`],
    ] as const) {
      const r = await app.inject({ method, url, headers: tok(TOKEN) });
      expect([404, 405], `${method} ${url}`).toContain(r.statusCode);
    }
  });
});

describe("AC 14: captured logs contain no token, access need or hold-token header", () => {
  function capture() {
    const lines: string[] = [];
    const stream = {
      write: (s: string) => {
        lines.push(s);
      },
    };
    return { lines, stream };
  }
  const accessBody = {
    seats: [
      { seatId: SEAT_1, role: "access", accessNeed: "wheelchair_space" },
      { seatId: SEAT_2, role: "companion" },
    ],
    ga: [],
  };

  const assertClean = (lines: string[]) => {
    const all = lines.join("\n");
    expect(all.length).toBeGreaterThan(0); // not vacuous
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(OTHER_TOKEN);
    expect(all).not.toContain("wheelchair_space");
    expect(all).not.toContain("accessNeed");
    expect(all.toLowerCase()).not.toContain("hold-token");
    expect(all).not.toContain("SENTINEL");
  };

  it("after create, get, extend and release (incl. a 404 and a malformed token)", async () => {
    const { lines, stream } = capture();
    make(fakeHolds(), {
      logger: { level: "info", stream, redact: ['req.headers["hold-token"]'] },
    });
    expect((await post(CREATE, accessBody)).statusCode).toBe(201);
    expect((await get(holdUrl(), TOKEN)).statusCode).toBe(200);
    expect((await post(`${holdUrl()}/extend`, undefined, TOKEN)).statusCode).toBe(200);
    expect((await del(holdUrl(), TOKEN)).statusCode).toBe(200);
    expect((await get(holdUrl(), "C".repeat(43))).statusCode).toBe(404);
    expect((await get(holdUrl(), "bad")).statusCode).toBe(404);
    expect((await get(holdUrl(), OTHER_TOKEN)).statusCode).toBe(404);
    assertClean(lines);
    // the request lines are really being logged
    expect(lines.join("\n")).toContain("incoming request");
  });

  it("with the log level at debug and trace", async () => {
    for (const level of ["debug", "trace"]) {
      const { lines, stream } = capture();
      make(fakeHolds(), { logger: { level, stream, redact: ['req.headers["hold-token"]'] } });
      await post(CREATE, accessBody);
      await get(holdUrl(), TOKEN);
      await post(`${holdUrl()}/extend`, undefined, TOKEN);
      await del(holdUrl(), TOKEN);
      assertClean(lines);
      await app.close();
    }
    make(fakeHolds()); // so afterEach has an open app
  });

  it("when the repo throws (error path logs), with the token in the header and an access need in the body", async () => {
    const { lines, stream } = capture();
    make(throwingHolds(), {
      logger: { level: "info", stream, redact: ['req.headers["hold-token"]'] },
    });
    expect((await post(CREATE, accessBody)).statusCode).toBe(503);
    expect((await get(holdUrl(), TOKEN)).statusCode).toBe(503);
    expect((await post(`${holdUrl()}/extend`, undefined, TOKEN)).statusCode).toBe(503);
    expect((await del(holdUrl(), TOKEN)).statusCode).toBe(503);
    assertClean(lines);
  });

  it("a validation failure (400) for a body with an access need does not log the body", async () => {
    const { lines, stream } = capture();
    make(fakeHolds(), { logger: { level: "info", stream, redact: ['req.headers["hold-token"]'] } });
    const r = await post(CREATE, { ...accessBody, bogus: true }, TOKEN);
    expect(r.statusCode).toBe(400);
    assertClean(lines);
  });

  it("buildApp without a logger option stays silent (default false)", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
      writes.push(String(s));
      return true;
    }) as never);
    make(fakeHolds());
    await get(holdUrl(), TOKEN);
    spy.mockRestore();
    expect(writes.join("")).not.toContain(TOKEN);
  });
});
