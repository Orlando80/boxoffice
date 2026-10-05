import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

describe("parseEnv PORT", () => {
  it("defaults to 4000 when unset", () => {
    expect(parseEnv({})).toEqual({ PORT: 4000 });
    expect(parseEnv({ PORT: undefined })).toEqual({ PORT: 4000 });
  });
  it("defaults to 4000 when empty", () => {
    expect(parseEnv({ PORT: "" }).PORT).toBe(4000);
  });
  it("parses valid values including bounds", () => {
    expect(parseEnv({ PORT: "8080" }).PORT).toBe(8080);
    expect(parseEnv({ PORT: "1" }).PORT).toBe(1);
    expect(parseEnv({ PORT: "65535" }).PORT).toBe(65535);
  });
  it.each(["abc", "0", "65536", "-1", "80.5", "4000abc", "SENTINEL_s3cr3t_value", " ", "1e3x", "NaN", "Infinity"])(
    "rejects %j naming PORT without echoing the value",
    (value) => {
      let err: unknown;
      try {
        parseEnv({ PORT: value });
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
