import { describe, expect, expectTypeOf, it } from "vitest";
import { err, isOk, ok, type Result } from "../src/index.js";

describe("ok", () => {
  it("wraps a value", () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
  });

  it.each([undefined, null, 0, "", false, NaN, 0n])("accepts falsy value %s", (v) => {
    const r = ok(v);
    expect(r.ok).toBe(true);
    expect(r).toStrictEqual({ ok: true, value: v });
    expect(isOk(r)).toBe(true);
  });

  it("ok(undefined) has an own value key", () => {
    expect(Object.hasOwn(ok(undefined), "value")).toBe(true);
  });

  it("keeps object identity", () => {
    const o = { a: 1 };
    expect(ok(o)).toHaveProperty("value", o);
    expect((ok(o) as { value: unknown }).value).toBe(o);
  });

  it("has no error key", () => {
    expect("error" in ok(1)).toBe(false);
  });
});

describe("err", () => {
  it("wraps an error", () => {
    expect(err("boom")).toEqual({ ok: false, error: "boom" });
  });

  it.each([undefined, null, 0, "", false, 42, { code: "X" }, ["a"], Symbol.for("s")])(
    "accepts non-Error value %s",
    (e) => {
      const r = err(e);
      expect(r.ok).toBe(false);
      expect(r).toStrictEqual({ ok: false, error: e });
      expect(isOk(r)).toBe(false);
    },
  );

  it("keeps Error instances", () => {
    const e = new Error("x");
    expect(err(e)).toHaveProperty("error", e);
  });

  it("has no value key", () => {
    expect("value" in err("e")).toBe(false);
  });
});

describe("isOk", () => {
  it("narrows at runtime and type level", () => {
    const r = (Math.random() >= 0 ? ok(1) : err("e")) as Result<number, string>;
    if (isOk(r)) {
      expectTypeOf(r.value).toEqualTypeOf<number>();
      expect(r.value).toBe(1);
    } else {
      expectTypeOf(r.error).toEqualTypeOf<string>();
      expect.unreachable();
    }
  });

  it("narrows the else branch to the error variant", () => {
    const r = err("bad") as Result<number, string>;
    if (!isOk(r)) {
      expectTypeOf(r).toEqualTypeOf<{ readonly ok: false; readonly error: string }>();
      expect(r.error).toBe("bad");
    } else {
      expect.unreachable();
    }
  });

  it("is a type guard", () => {
    expectTypeOf(isOk<number, string>).guards.toEqualTypeOf<{
      readonly ok: true;
      readonly value: number;
    }>();
  });
});

describe("types", () => {
  it("ok/err return types", () => {
    expectTypeOf(ok(1)).toEqualTypeOf<Result<number, never>>();
    expectTypeOf(err("e")).toEqualTypeOf<Result<never, string>>();
    expectTypeOf(ok(1)).toMatchTypeOf<Result<number, string>>();
    expectTypeOf(err("e")).toMatchTypeOf<Result<number, string>>();
  });

  it("fields are readonly", () => {
    const r = ok(1);
    // @ts-expect-error readonly
    r.value = 2;
    // @ts-expect-error readonly
    r.ok = false;
  });
});
