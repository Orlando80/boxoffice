import { describe, expect, expectTypeOf, it } from "vitest";
import { HealthResponse } from "../src/index.js";

describe("HealthResponse", () => {
  it("parses { status: 'ok' }", () => {
    expect(HealthResponse.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rejects extra keys", () => {
    expect(HealthResponse.safeParse({ status: "ok", extra: 1 }).success).toBe(false);
  });

  it("rejects wrong status values", () => {
    for (const status of ["OK", "error", "", " ok", 1, true, null, undefined]) {
      expect(HealthResponse.safeParse({ status }).success).toBe(false);
    }
  });

  it("rejects missing status", () => {
    expect(HealthResponse.safeParse({}).success).toBe(false);
  });

  it("rejects non-object inputs", () => {
    for (const v of [null, undefined, "ok", ["ok"], [{ status: "ok" }], 42, true]) {
      expect(HealthResponse.safeParse(v).success).toBe(false);
    }
  });

  it("infers { status: 'ok' }", () => {
    expectTypeOf<HealthResponse>().toEqualTypeOf<{ status: "ok" }>();
  });
});
