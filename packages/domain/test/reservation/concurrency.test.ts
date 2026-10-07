/**
 * The domain layer is stateless and pure, so it cannot arbitrate between
 * competing reservations. The database-level exactly-one-winner races over a
 * single seat block (AC 5) live in packages/db/test/holds.int.test.ts.
 *
 * What is asserted here: racing many validations and state-machine checks over
 * one seat block gives identical, deterministic verdicts and mutates no shared
 * state (facts, requests).
 */
import { describe, expect, it } from "vitest";
import {
  canTransition,
  checkExtension,
  validateHoldRequest,
  type HoldRequest,
} from "../../src/index.js";
import { NOW, baseFacts } from "./support.js";

const RACERS = 100;
const block = ["s1", "s2", "s3", "s4"];

describe("racing reservations over one seat block", () => {
  it("100 concurrent validations of the same block agree and mutate nothing", async () => {
    const facts = baseFacts();
    const seatsBefore = JSON.stringify([...facts.seats]);
    const sectionsBefore = JSON.stringify([...facts.sections]);
    const requests: HoldRequest[] = Array.from({ length: RACERS }, () => ({
      seats: block.map((seatId) => ({ seatId, role: "standard" as const })),
      ga: [],
    }));
    const frozen = JSON.stringify(requests);

    const results = await Promise.all(
      requests.map(async (r, i) => {
        for (let t = 0; t < i % 7; t++) await Promise.resolve();
        return validateHoldRequest(r, facts, NOW);
      }),
    );

    expect(results).toHaveLength(RACERS);
    for (const res of results) expect(res).toEqual(results[0]);
    expect(results[0]?.ok).toBe(true);
    // Stateless: validation claims nothing, so every racer sees success.
    expect(JSON.stringify([...facts.seats])).toBe(seatsBefore);
    expect(JSON.stringify([...facts.sections])).toBe(sectionsBefore);
    expect(JSON.stringify(requests)).toBe(frozen);
  });

  it("mixed valid and invalid racers keep their own verdicts", async () => {
    const facts = baseFacts();
    const mk = (i: number): HoldRequest =>
      i % 2 === 0
        ? { seats: [{ seatId: "s1", role: "standard" }], ga: [] }
        : { seats: [{ seatId: "s1", role: "access", accessNeed: "aisle" }], ga: [] };
    const results = await Promise.all(
      Array.from({ length: RACERS }, async (_, i) => validateHoldRequest(mk(i), facts, NOW)),
    );
    results.forEach((res, i) => expect(res.ok).toBe(i % 2 === 0));
  });

  it("100 raced state-machine checks are deterministic", async () => {
    const out = await Promise.all(
      Array.from({ length: RACERS }, async (_, i) => ({
        rel: canTransition(i % 2 ? "active" : "released", "release"),
        exp: canTransition(i % 2 ? "active" : "expired", "expire"),
        ext: checkExtension(i % 12),
      })),
    );
    out.forEach((o, i) => {
      expect(o.rel).toBe(i % 2 === 1);
      expect(o.exp).toBe(i % 2 === 1);
      expect(o.ext).toEqual(checkExtension(i % 12));
    });
  });
});
