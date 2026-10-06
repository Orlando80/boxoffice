import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

const DB = "postgres://u:pw@localhost:5432/db";

describe("parseEnv PORT", () => {
  it("defaults to 4000 when unset", () => {
    expect(parseEnv({ DATABASE_URL: DB })).toEqual({ PORT: 4000, DATABASE_URL: DB });
    expect(parseEnv({ PORT: undefined, DATABASE_URL: DB })).toEqual({ PORT: 4000, DATABASE_URL: DB });
  });
  it("defaults to 4000 when empty", () => {
    expect(parseEnv({ PORT: "", DATABASE_URL: DB }).PORT).toBe(4000);
  });
  it("parses valid values including bounds", () => {
    expect(parseEnv({ PORT: "8080", DATABASE_URL: DB }).PORT).toBe(8080);
    expect(parseEnv({ PORT: "1", DATABASE_URL: DB }).PORT).toBe(1);
    expect(parseEnv({ PORT: "65535", DATABASE_URL: DB }).PORT).toBe(65535);
  });
  it.each(["abc", "0", "65536", "-1", "80.5", "4000abc", "SENTINEL_s3cr3t_value", " ", "1e3x", "NaN", "Infinity"])(
    "rejects %j naming PORT without echoing the value",
    (value) => {
      let err: unknown;
      try {
        parseEnv({ PORT: value, DATABASE_URL: DB });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("PORT");
      expect(String(err)).toContain("PORT");
      if (value.trim() !== "") {
        expect(msg).not.toContain(value);
        expect(String(err)).not.toContain(value);
      }
    },
  );
});

describe("parseEnv DATABASE_URL", () => {
  it("is returned verbatim when valid", () => {
    expect(parseEnv({ DATABASE_URL: DB }).DATABASE_URL).toBe(DB);
  });
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["no scheme", "S3NTINEL-not-a-url"],
    ["broken scheme", "postgres//u:S3NTINEL@h/db"],
    ["whitespace", "   "],
  ])("rejects %s naming DATABASE_URL without echoing the value", (_n, value) => {
    let err: unknown;
    try {
      parseEnv({ DATABASE_URL: value });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toContain("DATABASE_URL");
    expect(String(err)).not.toContain("S3NTINEL");
    if (value) expect(String(err)).not.toContain(value);
  });
  it("a bad PORT is still reported by name when DATABASE_URL is fine", () => {
    expect(() => parseEnv({ PORT: "x", DATABASE_URL: DB })).toThrow(/PORT/);
  });
});
