import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_PLACES,
  validateHoldRequest,
  type HoldRequest,
  type HoldSeatLine,
} from "../../src/index.js";
import { NOW, baseFacts, makeFacts, seatFact } from "./support.js";

const RUNS = { numRuns: 300 };
const NEEDS = [
  "wheelchair_space",
  "transfer_seat",
  "step_free",
  "aisle",
  "extra_legroom",
  "hearing_loop",
  "near_exit",
];

const facts = baseFacts();

const seatIds = [
  ...Array.from({ length: 12 }, (_, i) => `s${i + 1}`),
  "w1",
  "c1",
  "c1b",
  "t1",
  "c2",
  "ga-seat",
  "other",
  "missing",
];
const seatLine = fc.record({
  seatId: fc.constantFrom(...seatIds),
  role: fc.constantFrom("standard", "access", "companion"),
  accessNeed: fc.constantFrom(undefined, "", "wheelchair_space", "aisle", "bogus"),
}) as fc.Arbitrary<HoldSeatLine>;
const gaLine = fc.record({
  sectionId: fc.constantFrom("g1", "g2", "res", "far", "nope"),
  quantity: fc.oneof(fc.integer({ min: -2, max: 12 }), fc.constant(1.5), fc.constant(Number.NaN)),
});
const request: fc.Arbitrary<HoldRequest> = fc.record({
  seats: fc.array(seatLine, { maxLength: 8 }),
  ga: fc.array(gaLine, { maxLength: 3 }),
});

/** Well-formed lines only, so that a good share of samples are accepted. */
const goodSeat: fc.Arbitrary<HoldSeatLine> = fc.oneof(
  fc.integer({ min: 1, max: 12 }).map((n) => ({ seatId: `s${n}`, role: "standard" as const })),
  fc.constantFrom(...NEEDS).map((n) => ({ seatId: "w1", role: "access" as const, accessNeed: n })),
  fc.constantFrom(...NEEDS).map((n) => ({ seatId: "t1", role: "access" as const, accessNeed: n })),
  fc.constant({ seatId: "c1", role: "companion" as const }),
  fc.constant({ seatId: "c2", role: "companion" as const }),
);
const goodRequest: fc.Arbitrary<HoldRequest> = fc.record({
  seats: fc.array(goodSeat, { maxLength: 11 }),
  ga: fc.array(
    fc.record({ sectionId: fc.constantFrom("g1", "g2"), quantity: fc.integer({ min: 1, max: 6 }) }),
    { maxLength: 2 },
  ),
});

/** Independent oracle: a plain predicate over the fixture layout, not a copy of the rule list. */
const oracleAccepts = (r: HoldRequest, startsInFuture: boolean): boolean => {
  if (!startsInFuture) return false;
  const ids = r.seats.map((s) => s.seatId);
  if (new Set(ids).size !== ids.length) return false;
  const secs = r.ga.map((g) => g.sectionId);
  if (new Set(secs).size !== secs.length) return false;
  const roleOf = new Map(r.seats.map((s) => [s.seatId, s.role]));
  const accessSeats = new Set(["w1", "t1"]);
  const companionOf: Record<string, string> = { c1: "w1", c1b: "w1", c2: "t1" };
  const usedCompanion = new Set<string>();
  let places = 0;
  for (const s of r.seats) {
    if (/^s([1-9]|1[0-2])$/.test(s.seatId)) {
      if (s.role !== "standard") return false;
    } else if (accessSeats.has(s.seatId)) {
      if (s.role !== "access" || !NEEDS.includes(s.accessNeed ?? "")) return false;
    } else if (s.seatId in companionOf) {
      const parent = companionOf[s.seatId] as string;
      if (s.role !== "companion") return false;
      if (roleOf.get(parent) !== "access") return false;
      if (usedCompanion.has(parent)) return false;
      usedCompanion.add(parent);
      continue;
    } else {
      return false; // ga-seat, other layout, unknown
    }
    places += 1;
  }
  for (const g of r.ga) {
    if (g.sectionId !== "g1" && g.sectionId !== "g2") return false;
    if (!Number.isInteger(g.quantity) || g.quantity < 1) return false;
    places += g.quantity;
  }
  return places >= 1 && places <= MAX_PLACES;
};

const reordered = <T>(xs: readonly T[], keys: readonly number[]): T[] =>
  xs
    .map((x, i) => [x, keys[i % keys.length] ?? 0, i] as const)
    .sort((a, b) => a[1] - b[1] || a[2] - b[2])
    .map(([x]) => x);

describe("property: validateHoldRequest", () => {
  it("agrees with an independent oracle on random requests", () => {
    let accepted = 0;
    fc.assert(
      fc.property(fc.oneof(request, goodRequest), (r) => {
        const res = validateHoldRequest(r, facts, NOW);
        if (res.ok) accepted++;
        expect(res.ok).toBe(oracleAccepts(r, true));
      }),
      RUNS,
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it("accepted holds have 1-10 places = non-companion seats + GA quantity", () => {
    let accepted = 0;
    fc.assert(
      fc.property(goodRequest, (r) => {
        const res = validateHoldRequest(r, facts, NOW);
        if (!res.ok) return;
        accepted++;
        const expected =
          r.seats.filter((s) => s.role !== "companion").length +
          r.ga.reduce((n, g) => n + g.quantity, 0);
        expect(res.value.placeCount).toBe(expected);
        expect(res.value.placeCount).toBeGreaterThanOrEqual(1);
        expect(res.value.placeCount).toBeLessThanOrEqual(MAX_PLACES);
      }),
      RUNS,
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it("adding a valid companion never changes placeCount", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.constantFrom(...NEEDS),
        fc.constantFrom(["w1", "c1"], ["w1", "c1b"], ["t1", "c2"]),
        fc.integer({ min: 0, max: 5 }),
        (n, need, [access, companion], ga) => {
          const base: HoldRequest = {
            seats: [
              { seatId: `s${n}`, role: "standard" },
              { seatId: access as string, role: "access", accessNeed: need },
            ],
            ga: ga > 0 ? [{ sectionId: "g1", quantity: ga }] : [],
          };
          const withCompanion: HoldRequest = {
            ...base,
            seats: [...base.seats, { seatId: companion as string, role: "companion" }],
          };
          const a = validateHoldRequest(base, facts, NOW);
          const b = validateHoldRequest(withCompanion, facts, NOW);
          expect(a.ok).toBe(true);
          expect(b.ok).toBe(true);
          if (a.ok && b.ok) expect(b.value.placeCount).toBe(a.value.placeCount);
        },
      ),
      RUNS,
    );
  });

  it("a started performance is always rejected", () => {
    fc.assert(
      fc.property(
        fc.oneof(request, goodRequest),
        fc.integer({ min: 0, max: 86_400_000 }),
        (r, ago) => {
          const started = baseFacts({ performanceStartsAt: new Date(NOW.getTime() - ago) });
          const res = validateHoldRequest(r, started, NOW);
          expect(res.ok).toBe(false);
          if (!res.ok) expect(res.error.map((e) => e.rule)).toContain("performance_started");
        },
      ),
      RUNS,
    );
  });

  it("verdict is independent of line order", () => {
    fc.assert(
      fc.property(
        fc.oneof(request, goodRequest),
        fc.array(fc.integer(), { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer(), { minLength: 1, maxLength: 3 }),
        (r, k1, k2) => {
          const p: HoldRequest = { seats: reordered(r.seats, k1), ga: reordered(r.ga, k2) };
          const a = validateHoldRequest(r, facts, NOW);
          const b = validateHoldRequest(p, facts, NOW);
          expect(b.ok).toBe(a.ok);
          if (a.ok && b.ok) expect(b.value.placeCount).toBe(a.value.placeCount);
          // Violation detail is only order-stable when ids are unique: with duplicate ids the
          // the first occurrence decides which per-line rules fire (verdict still agrees).
          const unique =
            new Set(r.seats.map((x) => x.seatId)).size === r.seats.length &&
            new Set(r.ga.map((x) => x.sectionId)).size === r.ga.length;
          if (unique && !a.ok && !b.ok) {
            const key = (e: typeof a.error) => e.map((x) => `${x.rule}|${x.item}`).sort();
            expect(key(b.error)).toEqual(key(a.error));
          }
        },
      ),
      RUNS,
    );
  });

  it("is deterministic and does not mutate its input", () => {
    fc.assert(
      fc.property(fc.oneof(request, goodRequest), (r) => {
        const before = JSON.stringify(r);
        const a = validateHoldRequest(r, facts, NOW);
        const b = validateHoldRequest(r, facts, NOW);
        expect(b).toEqual(a);
        expect(JSON.stringify(r)).toBe(before);
      }),
      RUNS,
    );
  });

  it("boundary: starting exactly now is rejected, one ms later is accepted", () => {
    const r: HoldRequest = { seats: [{ seatId: "s1", role: "standard" }], ga: [] };
    const at = (d: Date) => makeFacts([seatFact("s1")], [], { performanceStartsAt: d });
    expect(validateHoldRequest(r, at(NOW), NOW).ok).toBe(false);
    expect(validateHoldRequest(r, at(new Date(NOW.getTime() + 1)), NOW).ok).toBe(true);
  });
});
