import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

const SENTINEL = "p4ssw0rd-SENTINEL";
const PLACEHOLDER = "postgres://placeholder:placeholder@localhost:5432/placeholder";

const invalid = [
  `not a url ${SENTINEL}`,
  `postgres//user:${SENTINEL}@host/db`,
  `://${SENTINEL}`,
  SENTINEL,
  "",
  "   ",
];

function capture(value: string): unknown {
  try {
    parseEnv({ DATABASE_URL: value });
  } catch (e) {
    return e;
  }
  return undefined;
}

function dump(err: unknown): string {
  const e = err as Error & { cause?: unknown };
  return [
    String(err),
    e.message,
    e.stack ?? "",
    JSON.stringify(err, Object.getOwnPropertyNames(err)),
    JSON.stringify(e.cause ?? null),
    String(e.cause ?? ""),
  ].join("\n");
}

describe("parseEnv DATABASE_URL", () => {
  it.each(invalid)("rejects %j without leaking the value", (value) => {
    const err = capture(value);
    expect(err).toBeInstanceOf(Error);
    const text = dump(err);
    expect((err as Error).message).toContain("DATABASE_URL");
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain("not a url");
    if (value.trim() !== "") expect(text).not.toContain(value);
  });

  it("does not attach a cause or enumerable props carrying the value", () => {
    const err = capture(`not a url ${SENTINEL}`) as Error & { cause?: unknown };
    expect(JSON.stringify(err)).not.toContain(SENTINEL);
    expect(JSON.stringify(err.cause ?? null)).not.toContain(SENTINEL);
  });

  it.each([
    "postgres://user:pw@localhost:5432/db",
    "postgresql://u:p@db.internal:5432/boxoffice?sslmode=require",
  ])("accepts valid URL %s", (url) => {
    expect(parseEnv({ DATABASE_URL: url })).toEqual({ DATABASE_URL: url });
  });

  it("falls back to the placeholder when unset", () => {
    expect(parseEnv({})).toEqual({ DATABASE_URL: PLACEHOLDER });
    expect(parseEnv({ DATABASE_URL: undefined })).toEqual({ DATABASE_URL: PLACEHOLDER });
  });
});
