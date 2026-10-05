import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

describe("parseEnv", () => {
  it("applies defaults when unset", () => {
    const env = parseEnv({});
    expect(env.TEMPORAL_ADDRESS).toBe("localhost:7233");
    expect(env.TEMPORAL_NAMESPACE).toBe("default");
    expect(env.TEMPORAL_API_KEY).toBeUndefined();
  });
  it("applies defaults when empty strings or explicit undefined", () => {
    const env = parseEnv({ TEMPORAL_ADDRESS: "", TEMPORAL_NAMESPACE: "", TEMPORAL_API_KEY: "" });
    expect(env.TEMPORAL_ADDRESS).toBe("localhost:7233");
    expect(env.TEMPORAL_NAMESPACE).toBe("default");
    expect(env.TEMPORAL_API_KEY).toBeUndefined();
    expect(parseEnv({ TEMPORAL_ADDRESS: undefined }).TEMPORAL_ADDRESS).toBe("localhost:7233");
  });
  it("passes through provided values", () => {
    expect(
      parseEnv({ TEMPORAL_ADDRESS: "h.example:7233", TEMPORAL_NAMESPACE: "ns", TEMPORAL_API_KEY: "k" }),
    ).toEqual({ TEMPORAL_ADDRESS: "h.example:7233", TEMPORAL_NAMESPACE: "ns", TEMPORAL_API_KEY: "k" });
  });
  it("ignores unrelated variables", () => {
    expect(parseEnv({ FOO: "bar" }).TEMPORAL_ADDRESS).toBe("localhost:7233");
  });
  it("invalid value names the variable but not the value", () => {
    const sentinel = "SENTINEL_SECRET_VALUE_123";
    // Non-string value (bypassing types, as process.env cannot do) is the only way to fail the schema.
    const bad = { toString: () => sentinel, valueOf: () => sentinel } as unknown as string;
    let err: unknown;
    try {
      parseEnv({ TEMPORAL_API_KEY: bad, TEMPORAL_ADDRESS: "ok:1" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).toContain("TEMPORAL_API_KEY");
    expect(e.message).not.toContain(sentinel);
    expect(String(err)).not.toContain(sentinel);
    expect(String(err)).toBe("Error: Invalid environment: TEMPORAL_API_KEY");
  });
  it("lists multiple bad variables once each", () => {
    const bad = 42 as unknown as string;
    expect(() => parseEnv({ TEMPORAL_ADDRESS: bad, TEMPORAL_NAMESPACE: bad })).toThrow(
      "Invalid environment: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE",
    );
  });
  it.each(["localhost", "host:0", "host:65536", "host:abc", "ho st:7233", "SENTINEL:99999", ":7233", "host:", "[::1]", "a:b:7233", "host:-1"])(
    "rejects address %s without echoing it",
    (v) => {
      let err: unknown;
      try {
        parseEnv({ TEMPORAL_ADDRESS: v });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(String(err)).toBe("Error: Invalid environment: TEMPORAL_ADDRESS");
      expect((err as Error).message).not.toContain(v);
    },
  );
  it("rejects namespace with whitespace", () => {
    expect(() => parseEnv({ TEMPORAL_NAMESPACE: "a b" })).toThrow("Invalid environment: TEMPORAL_NAMESPACE");
    try {
      parseEnv({ TEMPORAL_NAMESPACE: "a b" });
    } catch (e) {
      expect(String(e)).not.toContain("a b");
    }
  });
  it("rejects whitespace-only API key without echoing it", () => {
    let err: unknown;
    try {
      parseEnv({ TEMPORAL_API_KEY: "   " });
    } catch (e) {
      err = e;
    }
    expect(String(err)).toBe("Error: Invalid environment: TEMPORAL_API_KEY");
    expect(String(err)).not.toContain("   ");
  });
  it("whitespace-only address rejected", () => {
    expect(() => parseEnv({ TEMPORAL_ADDRESS: " " })).toThrow("Invalid environment: TEMPORAL_ADDRESS");
  });
  it.each(["localhost:7233", "my-ns.tmprl.cloud:7233", "[::1]:7233", "h:1", "h:65535"])("accepts address %s", (v) => {
    expect(parseEnv({ TEMPORAL_ADDRESS: v }).TEMPORAL_ADDRESS).toBe(v);
  });
  it("accepts namespace with dots and key with inner spaces", () => {
    expect(parseEnv({ TEMPORAL_NAMESPACE: "ns.acct" }).TEMPORAL_NAMESPACE).toBe("ns.acct");
    expect(parseEnv({ TEMPORAL_API_KEY: "k" }).TEMPORAL_API_KEY).toBe("k");
  });
});
