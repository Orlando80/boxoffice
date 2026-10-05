import { describe, expect, it } from "vitest";
import { buildSeed } from "../../packages/db/src/seed/data.ts";

// Plan P1: public repo, invented fixtures only.
const graph = buildSeed();
const dump = JSON.stringify(graph);
// Ids are UUIDs; strip them so hex fragments are not mistaken for phone numbers.
const prose = dump.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "");

describe("seed fixtures hygiene (P1)", () => {
  it("has venues", () => {
    expect(graph.venues.length).toBe(3);
  });

  it("every venue name ends with ' (Example)'", () => {
    for (const v of graph.venues) expect(v.name.endsWith(" (Example)"), v.name).toBe(true);
  });

  it("contains no email addresses other than @example.com", () => {
    const emails = dump.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    for (const e of emails) expect(e.toLowerCase().endsWith("@example.com"), e).toBe(true);
  });

  it("contains no UK phone numbers outside 07700 900000-900999", () => {
    const candidates = prose.match(/(?:\+44|0044|\b0)[\d\s()-]{9,}/g) ?? [];
    for (const raw of candidates) {
      const digits = raw.replace(/[^\d+]/g, "").replace(/^\+44|^0044/, "0");
      const n = Number(digits.slice(5));
      expect(
        digits.startsWith("07700") && n >= 900000 && n <= 900999,
        `phone-like value ${raw}`,
      ).toBe(true);
    }
  });

  it("has no address-like fields or values", () => {
    const keys = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x !== null && typeof x === "object" && !(x instanceof Date))
        for (const [k, v] of Object.entries(x)) {
          keys.add(k);
          walk(v);
        }
    };
    walk(graph);
    for (const k of keys)
      expect(k, `field ${k}`).not.toMatch(
        /address|postcode|postalcode|street|phone|email|contact/i,
      );
    // UK postcode shape
    expect(dump).not.toMatch(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/);
  });
});
