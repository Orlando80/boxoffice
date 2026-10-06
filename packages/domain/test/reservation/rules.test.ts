import { describe, expect, it } from "vitest";
import {
  ACCESS_FEATURES,
  ACCESS_NEED_CATEGORIES,
  HOLD_LENGTH_SECONDS,
  MAX_EXTENSIONS,
  MAX_PLACES,
  validateHoldRequest,
} from "../../src/index.js";
import { NOW, baseFacts, req, rulesOf } from "./support.js";

const std = (...ids: string[]) => ids.map((seatId) => ({ seatId, role: "standard" as const }));
const n = (count: number) => Array.from({ length: count }, (_, i) => `s${i + 1}`);

const fails = (r: ReturnType<typeof req>, facts = baseFacts()) => {
  const res = validateHoldRequest(r, facts, NOW);
  expect(res.ok).toBe(false);
  return res.ok ? [] : res.error;
};

describe("constants", () => {
  it("match the spec", () => {
    expect(HOLD_LENGTH_SECONDS).toBe(600);
    expect(MAX_EXTENSIONS).toBe(10);
    expect(MAX_PLACES).toBe(10);
    expect(ACCESS_NEED_CATEGORIES).toBe(ACCESS_FEATURES);
  });
});

describe("AC1 rejections, each with its named rule", () => {
  it("seat outside the layout (unknown id)", () => {
    expect(rulesOf(fails(req({ seats: std("nope") })))).toContain("seat_outside_layout");
  });
  it("seat outside the layout (other layout)", () => {
    expect(fails(req({ seats: std("other") }))[0]).toMatchObject({
      rule: "seat_outside_layout",
      item: "seat:other",
    });
  });
  it("GA section outside the layout (unknown and other layout)", () => {
    expect(rulesOf(fails(req({ ga: [{ sectionId: "zzz", quantity: 1 }] })))).toContain(
      "ga_section_outside_layout",
    );
    expect(rulesOf(fails(req({ ga: [{ sectionId: "far", quantity: 1 }] })))).toContain(
      "ga_section_outside_layout",
    );
  });
  it("GA line on a reserved section", () => {
    expect(fails(req({ ga: [{ sectionId: "res", quantity: 1 }] }))[0]).toMatchObject({
      rule: "ga_line_on_reserved_section",
      item: "section:res",
    });
  });
  it("seat in a GA section", () => {
    expect(fails(req({ seats: std("ga-seat") }))[0]).toMatchObject({
      rule: "seat_in_ga_section",
      item: "seat:ga-seat",
    });
  });
  it("duplicate seat", () => {
    expect(rulesOf(fails(req({ seats: std("s1", "s1") })))).toEqual(["duplicate_seat"]);
  });
  it("duplicate seat with differing roles", () => {
    const v = fails(
      req({
        seats: [
          { seatId: "s1", role: "standard" },
          { seatId: "s1", role: "access", accessNeed: "aisle" },
        ],
      }),
    );
    expect(rulesOf(v)).toContain("duplicate_seat");
  });
  it("duplicate GA section", () => {
    const v = fails(
      req({
        ga: [
          { sectionId: "g1", quantity: 1 },
          { sectionId: "g1", quantity: 1 },
        ],
      }),
    );
    expect(rulesOf(v)).toContain("duplicate_ga_section");
  });
  it.each([0, -1, 1.5, Number.NaN, Infinity])("GA quantity %s is invalid", (quantity) => {
    const v = fails(req({ seats: std("s1"), ga: [{ sectionId: "g1", quantity }] }));
    expect(rulesOf(v)).toContain("ga_quantity_invalid");
  });
  it("zero places (empty request)", () => {
    expect(rulesOf(fails(req({})))).toEqual(["place_count_out_of_range"]);
  });
  it("more than 10 places (seats)", () => {
    expect(rulesOf(fails(req({ seats: std(...n(11)) })))).toEqual(["place_count_out_of_range"]);
  });
  it("more than 10 places (GA)", () => {
    expect(rulesOf(fails(req({ ga: [{ sectionId: "g1", quantity: 11 }] })))).toEqual([
      "place_count_out_of_range",
    ]);
  });
  it("more than 10 places (mixed seats + GA across sections)", () => {
    const v = fails(
      req({
        seats: std("s1", "s2", "s3"),
        ga: [
          { sectionId: "g1", quantity: 5 },
          { sectionId: "g2", quantity: 3 },
        ],
      }),
    );
    expect(rulesOf(v)).toEqual(["place_count_out_of_range"]);
  });
  it("performance that has started, including one starting exactly now", () => {
    const past = baseFacts({ performanceStartsAt: new Date(NOW.getTime() - 1) });
    expect(rulesOf(fails(req({ seats: std("s1") }), past))).toEqual(["performance_started"]);
    const exact = baseFacts({ performanceStartsAt: NOW });
    expect(rulesOf(fails(req({ seats: std("s1") }), exact))).toEqual(["performance_started"]);
    const justAfter = baseFacts({ performanceStartsAt: new Date(NOW.getTime() + 1) });
    expect(validateHoldRequest(req({ seats: std("s1") }), justAfter, NOW).ok).toBe(true);
  });
  it("access seat without a need", () => {
    expect(fails(req({ seats: [{ seatId: "w1", role: "access" }] }))[0]).toMatchObject({
      rule: "access_need_missing",
      item: "seat:w1",
    });
  });
  it("access seat with an empty need", () => {
    const v = fails(req({ seats: [{ seatId: "w1", role: "access", accessNeed: "" }] }));
    expect(rulesOf(v)).toContain("access_need_missing");
  });
  it("access seat with a need outside the list", () => {
    const v = fails(req({ seats: [{ seatId: "w1", role: "access", accessNeed: "jetpack" }] }));
    expect(rulesOf(v)).toEqual(["access_need_invalid"]);
  });
  it("access seat held as standard", () => {
    expect(rulesOf(fails(req({ seats: std("w1") })))).toEqual(["access_seat_wrong_role"]);
  });
  it("access seat held as companion", () => {
    expect(
      rulesOf(fails(req({ seats: [{ seatId: "w1", role: "companion" }] }))).length,
    ).toBeGreaterThan(0);
  });
  it("companion held as standard or access", () => {
    expect(rulesOf(fails(req({ seats: std("c1") })))).toContain("companion_wrong_role");
    const v = fails(req({ seats: [{ seatId: "c1", role: "access", accessNeed: "aisle" }] }));
    expect(rulesOf(v)).toContain("companion_wrong_role");
  });
  it("companion without its linked access seat in the hold", () => {
    const v = fails(req({ seats: [{ seatId: "c1", role: "companion" }, ...std("s1")] }));
    expect(v[0]).toMatchObject({ rule: "companion_without_access_seat", item: "seat:c1" });
  });
  it("companion alongside a DIFFERENT access seat is still rejected", () => {
    const v = fails(
      req({
        seats: [
          { seatId: "t1", role: "access", accessNeed: "aisle" },
          { seatId: "c1", role: "companion" },
        ],
      }),
    );
    expect(rulesOf(v)).toContain("companion_without_access_seat");
  });
  it("companion whose linked seat is in the hold only with standard role", () => {
    const v = fails(
      req({
        seats: [
          { seatId: "w1", role: "standard" },
          { seatId: "c1", role: "companion" },
        ],
      }),
    );
    expect(rulesOf(v)).toContain("companion_without_access_seat");
  });
  it("companion role on a seat that is not linked to an access seat", () => {
    const v = fails(
      req({
        seats: [
          { seatId: "w1", role: "access", accessNeed: "aisle" },
          { seatId: "s1", role: "companion" },
        ],
      }),
    );
    expect(rulesOf(v)).toContain("access_role_on_standard_seat");
  });
  it("access role on a plain standard seat", () => {
    const v = fails(req({ seats: [{ seatId: "s1", role: "access", accessNeed: "aisle" }] }));
    expect(rulesOf(v)).toContain("access_role_on_standard_seat");
  });
  it("second companion for one access seat", () => {
    const v = fails(
      req({
        seats: [
          { seatId: "w1", role: "access", accessNeed: "wheelchair_space" },
          { seatId: "c1", role: "companion" },
          { seatId: "c1b", role: "companion" },
        ],
      }),
    );
    expect(rulesOf(v)).toEqual(["companion_duplicate_for_access_seat"]);
    expect(v[0]!.item).toBe("seat:c1b");
  });
  it("collects several violations at once", () => {
    const v = fails(req({ seats: std("nope", "ga-seat", "s1", "s1") }));
    expect(new Set(rulesOf(v))).toEqual(
      new Set(["seat_outside_layout", "seat_in_ga_section", "duplicate_seat"]),
    );
  });
});

describe("valid requests", () => {
  it("accepts a single standard seat", () => {
    expect(validateHoldRequest(req({ seats: std("s1") }), baseFacts(), NOW)).toMatchObject({
      ok: true,
      value: { placeCount: 1 },
    });
  });
  it("accepts mixed reserved + GA across sections", () => {
    const r = validateHoldRequest(
      req({
        seats: std("s1", "s2"),
        ga: [
          { sectionId: "g1", quantity: 3 },
          { sectionId: "g2", quantity: 2 },
        ],
      }),
      baseFacts(),
      NOW,
    );
    expect(r).toMatchObject({ ok: true, value: { placeCount: 7 } });
  });
  it("accepts GA-only up to 10", () => {
    const r = validateHoldRequest(
      req({ ga: [{ sectionId: "g1", quantity: 10 }] }),
      baseFacts(),
      NOW,
    );
    expect(r).toMatchObject({ ok: true, value: { placeCount: 10 } });
  });
  it("accepts exactly 10 seats", () => {
    expect(validateHoldRequest(req({ seats: std(...n(10)) }), baseFacts(), NOW)).toMatchObject({
      ok: true,
      value: { placeCount: 10 },
    });
  });
  it("accepts every access-need category", () => {
    for (const accessNeed of ACCESS_NEED_CATEGORIES) {
      const r = validateHoldRequest(
        req({ seats: [{ seatId: "w1", role: "access", accessNeed }] }),
        baseFacts(),
        NOW,
      );
      expect(r.ok, accessNeed).toBe(true);
    }
  });
  it("companions do not count toward the 10-place limit", () => {
    const seats = [
      ...std(...n(8)),
      { seatId: "w1", role: "access" as const, accessNeed: "wheelchair_space" },
      { seatId: "t1", role: "access" as const, accessNeed: "aisle" },
      { seatId: "c1", role: "companion" as const },
      { seatId: "c2", role: "companion" as const },
    ];
    const r = validateHoldRequest(req({ seats }), baseFacts(), NOW);
    expect(r).toMatchObject({ ok: true, value: { placeCount: 10 } });
    if (r.ok) expect(r.value.seats).toHaveLength(12);
  });
  it("an 11th non-companion place still fails with companions present", () => {
    const seats = [
      ...std(...n(9)),
      { seatId: "w1", role: "access" as const, accessNeed: "aisle" },
      { seatId: "c1", role: "companion" as const },
      { seatId: "s10", role: "standard" as const },
    ];
    expect(rulesOf(fails(req({ seats })))).toEqual(["place_count_out_of_range"]);
  });
  it("a companion-only request is rejected", () => {
    expect(rulesOf(fails(req({ seats: [{ seatId: "c1", role: "companion" }] })))).toContain(
      "companion_without_access_seat",
    );
  });
  it("does not mutate its inputs", () => {
    const request = req({ seats: std("s1") });
    const snap = JSON.stringify(request);
    validateHoldRequest(request, baseFacts(), NOW);
    expect(JSON.stringify(request)).toBe(snap);
  });
});
