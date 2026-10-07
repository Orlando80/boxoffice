import {
  ACCESS_FEATURES,
  ACCESS_NEED_CATEGORIES,
  HOLD_STATUSES,
  HOLD_VIOLATION_RULES,
  MAX_EXTENSIONS,
  PERFORMANCE_ACCESS_TAGS,
  SEAT_ROLES,
} from "@boxoffice/domain";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CreateHoldRequest,
  HoldCreated,
  HoldView,
  InvalidHoldBody,
  PerformanceAvailability,
  PerformanceDetail,
  SeatsUnavailableBody,
} from "../src/index.js";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Schema = { safeParse: (v: unknown) => { success: boolean } };
const ok = (s: Schema, v: unknown) => s.safeParse(v).success;
const issues = (s: { safeParse: (v: unknown) => unknown }, v: unknown) =>
  (s.safeParse(v) as { error: { issues: { values?: unknown[] }[] } }).error.issues;

const ISO = "2026-10-24T19:00:00.000Z";

const createReq = () => ({
  seats: [
    { seatId: u(1), role: "access", accessNeed: ACCESS_NEED_CATEGORIES[0] },
    { seatId: u(2), role: "companion" },
    { seatId: u(3), role: "standard" },
  ],
  ga: [{ sectionId: u(9), quantity: 2 }],
});
const created = () => ({ holdId: u(10), token: "tok", expiresAt: ISO, extensionsRemaining: 10 });
const view = () => ({
  holdId: u(10),
  performanceId: u(11),
  status: "active",
  expiresAt: ISO,
  extensionsRemaining: 4,
  seats: [{ seatId: u(1), role: "standard" }],
  ga: [{ sectionId: u(9), quantity: 3 }],
});
const detail = () => ({
  id: u(11),
  venueId: u(1),
  eventId: u(2),
  eventName: "An Event",
  startsAt: ISO,
  layoutId: u(3),
  accessTags: ["relaxed"],
});
const avail = () => ({
  performanceId: u(11),
  asOf: ISO,
  heldSeatIds: [u(1), u(2)],
  ga: [{ sectionId: u(9), held: 0, capacity: 500 }],
});
const unavailable = () => ({ error: "seats_unavailable", seatIds: [u(1)], sectionIds: [u(9)] });
const invalid = () => ({ error: "invalid_hold", rule: "duplicate_seat" });

const samples = [
  ["CreateHoldRequest", CreateHoldRequest, createReq],
  ["HoldCreated", HoldCreated, created],
  ["HoldView", HoldView, view],
  ["PerformanceDetail", PerformanceDetail, detail],
  ["PerformanceAvailability", PerformanceAvailability, avail],
  ["SeatsUnavailableBody", SeatsUnavailableBody, unavailable],
  ["InvalidHoldBody", InvalidHoldBody, invalid],
] as const;

describe("valid samples parse", () => {
  it.each(samples)("%s", (_n, schema, mk) => {
    expect(schema.safeParse(mk()).success).toBe(true);
  });

  it("parse preserves data and survives JSON", () => {
    for (const [, schema, mk] of samples) {
      const parsed: unknown = (schema as unknown as { parse: (v: unknown) => unknown }).parse(mk());
      expect(parsed).toEqual(mk());
      expect(
        (schema as unknown as { parse: (v: unknown) => unknown }).parse(
          JSON.parse(JSON.stringify(parsed)),
        ),
      ).toEqual(parsed);
    }
  });

  it("empty collections are valid in views", () => {
    expect(ok(HoldView, { ...view(), seats: [], ga: [] })).toBe(true);
    expect(ok(PerformanceAvailability, { ...avail(), heldSeatIds: [], ga: [] })).toBe(true);
    expect(ok(PerformanceDetail, { ...detail(), accessTags: [] })).toBe(true);
    expect(ok(SeatsUnavailableBody, { ...unavailable(), seatIds: [], sectionIds: [] })).toBe(true);
  });

  it("every status, rule, role, need and tag is accepted", () => {
    for (const status of HOLD_STATUSES) expect(ok(HoldView, { ...view(), status })).toBe(true);
    for (const rule of HOLD_VIOLATION_RULES)
      expect(ok(InvalidHoldBody, { ...invalid(), rule })).toBe(true);
    for (const role of SEAT_ROLES) {
      expect(ok(HoldView, { ...view(), seats: [{ seatId: u(1), role }] })).toBe(true);
      expect(ok(CreateHoldRequest, { seats: [{ seatId: u(1), role }], ga: [] })).toBe(true);
    }
    for (const accessNeed of ACCESS_NEED_CATEGORIES) {
      expect(
        ok(CreateHoldRequest, { seats: [{ seatId: u(1), role: "access", accessNeed }], ga: [] }),
      ).toBe(true);
    }
    expect(ok(PerformanceDetail, { ...detail(), accessTags: [...PERFORMANCE_ACCESS_TAGS] })).toBe(
      true,
    );
  });
});

describe("strictness: extra keys rejected at every level", () => {
  it.each(samples)("%s top level", (_n, schema, mk) => {
    expect(schema.safeParse({ ...mk(), extra: 1 }).success).toBe(false);
  });

  it("CreateHoldRequest seat and ga lines", () => {
    expect(
      ok(CreateHoldRequest, { ...createReq(), seats: [{ ...createReq().seats[2]!, x: 1 }] }),
    ).toBe(false);
    expect(
      ok(CreateHoldRequest, { ...createReq(), ga: [{ sectionId: u(9), quantity: 1, x: 1 }] }),
    ).toBe(false);
  });

  it("HoldView seat and ga lines", () => {
    expect(ok(HoldView, { ...view(), seats: [{ seatId: u(1), role: "standard", x: 1 }] })).toBe(
      false,
    );
    expect(ok(HoldView, { ...view(), ga: [{ sectionId: u(9), quantity: 1, x: 1 }] })).toBe(false);
  });

  it("PerformanceAvailability ga line", () => {
    expect(ok(PerformanceAvailability, { ...avail(), ga: [{ ...avail().ga[0]!, x: 1 }] })).toBe(
      false,
    );
  });

  it("HoldView rejects a token key and an accessNeed key, at top level and on seats", () => {
    expect(ok(HoldView, { ...view(), token: "secret" })).toBe(false);
    expect(ok(HoldView, { ...view(), accessNeed: "wheelchair" })).toBe(false);
    expect(
      ok(HoldView, {
        ...view(),
        seats: [{ seatId: u(1), role: "access", accessNeed: ACCESS_NEED_CATEGORIES[0] }],
      }),
    ).toBe(false);
    expect(
      ok(HoldView, { ...view(), seats: [{ seatId: u(1), role: "standard", token: "t" }] }),
    ).toBe(false);
  });

  it("the HoldView shape has no token or need key", () => {
    const keys = Object.keys((HoldView as unknown as { shape: Record<string, unknown> }).shape);
    expect(keys.sort()).toEqual(
      [
        "holdId",
        "performanceId",
        "status",
        "expiresAt",
        "extensionsRemaining",
        "seats",
        "ga",
      ].sort(),
    );
  });

  it("SeatsUnavailableBody and InvalidHoldBody reject mixed fields", () => {
    expect(ok(SeatsUnavailableBody, { ...unavailable(), rule: "duplicate_seat" })).toBe(false);
    expect(ok(InvalidHoldBody, { ...invalid(), seatIds: [] })).toBe(false);
  });
});

describe("enums match domain constants", () => {
  it("seat roles", () => {
    const i = issues(HoldView, { ...view(), seats: [{ seatId: u(1), role: "zzz" }] });
    expect([...i[0]!.values!].sort()).toEqual([...SEAT_ROLES].sort());
    expect([...SEAT_ROLES].sort()).toEqual(["access", "companion", "standard"]);
  });

  it("access needs", () => {
    const i = issues(CreateHoldRequest, {
      seats: [{ seatId: u(1), role: "access", accessNeed: "zzz" }],
      ga: [],
    });
    expect([...i[0]!.values!].sort()).toEqual([...ACCESS_NEED_CATEGORIES].sort());
    expect([...ACCESS_NEED_CATEGORIES].sort()).toEqual([...ACCESS_FEATURES].sort());
  });

  it("hold statuses", () => {
    const i = issues(HoldView, { ...view(), status: "zzz" });
    expect([...i[0]!.values!].sort()).toEqual([...HOLD_STATUSES].sort());
    expect([...HOLD_STATUSES].sort()).toEqual(["active", "expired", "released"]);
  });

  it("violation rules", () => {
    const i = issues(InvalidHoldBody, { ...invalid(), rule: "zzz" });
    expect([...i[0]!.values!].sort()).toEqual([...HOLD_VIOLATION_RULES].sort());
    expect(new Set(HOLD_VIOLATION_RULES).size).toBe(HOLD_VIOLATION_RULES.length);
    expect(HOLD_VIOLATION_RULES).toHaveLength(17);
  });

  it("performance access tags", () => {
    const i = issues(PerformanceDetail, { ...detail(), accessTags: ["zzz"] });
    expect([...i[0]!.values!].sort()).toEqual([...PERFORMANCE_ACCESS_TAGS].sort());
  });

  it("case and near-miss values are rejected", () => {
    expect(ok(HoldView, { ...view(), status: "ACTIVE" })).toBe(false);
    expect(ok(HoldView, { ...view(), status: "ended" })).toBe(false);
    expect(ok(InvalidHoldBody, { ...invalid(), rule: "" })).toBe(false);
    expect(ok(InvalidHoldBody, { error: "invalid_hold" })).toBe(false);
  });

  it("error discriminators are literals", () => {
    expect(ok(SeatsUnavailableBody, { ...unavailable(), error: "not_found" })).toBe(false);
    expect(ok(InvalidHoldBody, { ...invalid(), error: "seats_unavailable" })).toBe(false);
    expect(ok(SeatsUnavailableBody, { seatIds: [], sectionIds: [] })).toBe(false);
  });
});

describe("CreateHoldRequest", () => {
  it("defaults seats and ga to []", () => {
    expect(CreateHoldRequest.parse({})).toEqual({ seats: [], ga: [] });
    expect(CreateHoldRequest.parse({ seats: [{ seatId: u(1), role: "standard" }] })).toEqual({
      seats: [{ seatId: u(1), role: "standard" }],
      ga: [],
    });
    expect(CreateHoldRequest.parse({ ga: [{ sectionId: u(9), quantity: 1 }] }).seats).toEqual([]);
  });

  it("accessNeed is optional and not defaulted", () => {
    const p = CreateHoldRequest.parse({ seats: [{ seatId: u(1), role: "standard" }] });
    expect("accessNeed" in p.seats[0]!).toBe(false);
  });

  it("rejects bad ids, roles, quantities", () => {
    expect(ok(CreateHoldRequest, { seats: [{ seatId: "nope", role: "standard" }] })).toBe(false);
    expect(ok(CreateHoldRequest, { seats: [{ role: "standard" }] })).toBe(false);
    expect(ok(CreateHoldRequest, { seats: [{ seatId: u(1) }] })).toBe(false);
    expect(ok(CreateHoldRequest, { ga: [{ sectionId: "nope", quantity: 1 }] })).toBe(false);
    for (const quantity of [0, -1, 1.5, "2", null, Number.NaN]) {
      expect(ok(CreateHoldRequest, { ga: [{ sectionId: u(9), quantity }] })).toBe(false);
    }
    expect(ok(CreateHoldRequest, { seats: null })).toBe(false);
    expect(ok(CreateHoldRequest, { seats: {} })).toBe(false);
    expect(ok(CreateHoldRequest, null)).toBe(false);
  });

  it("input type allows omitting seats and ga", () => {
    expectTypeOf<CreateHoldRequest["seats"]>().toEqualTypeOf<
      | {
          seatId: string;
          role: "standard" | "access" | "companion";
          accessNeed?: (typeof ACCESS_NEED_CATEGORIES)[number] | undefined;
        }[]
      | undefined
    >();
    expectTypeOf<CreateHoldRequest>().toExtend<{ seats?: unknown; ga?: unknown }>();
  });
});

describe("HoldCreated", () => {
  it(`extensionsRemaining must be an integer in 0..${MAX_EXTENSIONS}`, () => {
    for (const n of [0, 1, MAX_EXTENSIONS]) {
      expect(ok(HoldCreated, { ...created(), extensionsRemaining: n })).toBe(true);
    }
    for (const n of [-1, MAX_EXTENSIONS + 1, 1.5, "10", null, Number.NaN, Infinity]) {
      expect(ok(HoldCreated, { ...created(), extensionsRemaining: n })).toBe(false);
    }
    for (const n of [-1, MAX_EXTENSIONS + 1, 2.5]) {
      expect(ok(HoldView, { ...view(), extensionsRemaining: n })).toBe(false);
    }
    expect(MAX_EXTENSIONS).toBe(10);
  });

  it("requires token, ids and datetime", () => {
    const noToken: Record<string, unknown> = { ...created() };
    delete noToken.token;
    expect(ok(HoldCreated, noToken)).toBe(false);
    expect(ok(HoldCreated, { ...created(), token: 5 })).toBe(false);
    expect(ok(HoldCreated, { ...created(), holdId: "x" })).toBe(false);
    expect(ok(HoldCreated, { ...created(), expiresAt: "2026-10-24 19:00" })).toBe(false);
    expect(ok(HoldCreated, { ...created(), expiresAt: "2026-10-24T19:00:00+01:00" })).toBe(false);
  });
});

describe("views: ids, datetimes, numbers", () => {
  it("rejects non-uuid ids", () => {
    expect(ok(HoldView, { ...view(), holdId: "x" })).toBe(false);
    expect(ok(HoldView, { ...view(), performanceId: "x" })).toBe(false);
    expect(ok(PerformanceDetail, { ...detail(), layoutId: "x" })).toBe(false);
    expect(ok(PerformanceAvailability, { ...avail(), heldSeatIds: ["x"] })).toBe(false);
    expect(ok(SeatsUnavailableBody, { ...unavailable(), seatIds: ["x"] })).toBe(false);
    expect(ok(SeatsUnavailableBody, { ...unavailable(), sectionIds: ["x"] })).toBe(false);
  });

  it("rejects non-ISO datetimes", () => {
    expect(ok(PerformanceDetail, { ...detail(), startsAt: "tomorrow" })).toBe(false);
    expect(ok(PerformanceAvailability, { ...avail(), asOf: 0 })).toBe(false);
    expect(ok(HoldView, { ...view(), expiresAt: new Date() })).toBe(false);
  });

  it("availability counts", () => {
    for (const held of [-1, 1.5, "0", null]) {
      expect(ok(PerformanceAvailability, { ...avail(), ga: [{ ...avail().ga[0]!, held }] })).toBe(
        false,
      );
    }
    for (const capacity of [0, -1, 1.5]) {
      expect(
        ok(PerformanceAvailability, { ...avail(), ga: [{ ...avail().ga[0]!, capacity }] }),
      ).toBe(false);
    }
  });

  it("HoldView ga quantity is a positive integer", () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(ok(HoldView, { ...view(), ga: [{ sectionId: u(9), quantity }] })).toBe(false);
    }
  });

  it("missing required fields", () => {
    for (const [, schema, mk] of samples) {
      for (const key of Object.keys(mk())) {
        if (schema === CreateHoldRequest) continue;
        const copy: Record<string, unknown> = { ...mk() };
        delete copy[key];
        expect(schema.safeParse(copy).success, `${key} is required`).toBe(false);
      }
    }
  });
});

describe("types", () => {
  it("inferred types", () => {
    expectTypeOf<HoldCreated["extensionsRemaining"]>().toEqualTypeOf<number>();
    expectTypeOf<HoldView["status"]>().toEqualTypeOf<"active" | "released" | "expired">();
    expectTypeOf<HoldView["seats"][number]["role"]>().toEqualTypeOf<
      "standard" | "access" | "companion"
    >();
    expectTypeOf<HoldView>().not.toHaveProperty("token");
    expectTypeOf<PerformanceAvailability["heldSeatIds"]>().toEqualTypeOf<string[]>();
    expectTypeOf<SeatsUnavailableBody["error"]>().toEqualTypeOf<"seats_unavailable">();
    expectTypeOf<InvalidHoldBody["error"]>().toEqualTypeOf<"invalid_hold">();
    expectTypeOf<InvalidHoldBody["rule"]>().toEqualTypeOf<(typeof HOLD_VIOLATION_RULES)[number]>();
  });
});
