import { describe, expect, expectTypeOf, it } from "vitest";
import * as queries from "../src/queries.js";

// AC 9: every query takes a required string venueId as its second parameter.
// Only listVenues (DEV-ONLY) may be unscoped.
const UNSCOPED_ALLOW_LIST = new Set(["listVenues"]);

describe("queries venue-scoping convention (AC 9)", () => {
  it("every runtime export is a function and is either scoped (length >= 2) or allow-listed", () => {
    const names = Object.keys(queries);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const fn = (queries as Record<string, unknown>)[name];
      expect(typeof fn, `${name} must be a function`).toBe("function");
      if (UNSCOPED_ALLOW_LIST.has(name)) continue;
      expect(
        (fn as (...a: unknown[]) => unknown).length,
        `${name} is not allow-listed so it must declare (db, venueId, ...)`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("the allow-list contains exactly listVenues and it exists", () => {
    expect([...UNSCOPED_ALLOW_LIST]).toEqual(["listVenues"]);
    expect(Object.keys(queries)).toContain("listVenues");
  });

  it("the exported query set is the known one (new exports must be reviewed)", () => {
    expect(Object.keys(queries).sort()).toEqual(
      ["getEvent", "getLayoutView", "getVenue", "listEvents", "listLayouts", "listVenues"].sort(),
    );
  });

  it("scoped queries take venueId: string as the second parameter", () => {
    expectTypeOf<Parameters<typeof queries.getVenue>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof queries.listEvents>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof queries.listLayouts>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof queries.getEvent>[1]>().toEqualTypeOf<string>();
    expectTypeOf<Parameters<typeof queries.getLayoutView>[1]>().toEqualTypeOf<string>();
    // venueId is required, not optional
    expectTypeOf<Parameters<typeof queries.getVenue>["length"]>().toEqualTypeOf<2>();
    expectTypeOf<Parameters<typeof queries.listEvents>["length"]>().toEqualTypeOf<2>();
    expectTypeOf<Parameters<typeof queries.listLayouts>["length"]>().toEqualTypeOf<2>();
    expectTypeOf<Parameters<typeof queries.getEvent>["length"]>().toEqualTypeOf<3>();
    expectTypeOf<Parameters<typeof queries.getLayoutView>["length"]>().toEqualTypeOf<3>();
  });

  it("listVenues takes only db", () => {
    expectTypeOf<Parameters<typeof queries.listVenues>["length"]>().toEqualTypeOf<1>();
  });
});
