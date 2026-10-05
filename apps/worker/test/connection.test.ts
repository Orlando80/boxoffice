import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConnectionOptions } from "../src/connection.js";
import { parseEnv } from "../src/env.js";
import { noopWorkflow } from "../src/workflows.js";

describe("buildConnectionOptions", () => {
  it("with key: tls true and key", () => {
    const o = buildConnectionOptions(parseEnv({ TEMPORAL_ADDRESS: "h:7233", TEMPORAL_API_KEY: "k" }));
    expect(o).toEqual({ address: "h:7233", tls: true, apiKey: "k" });
  });
  it("without key: no tls and no apiKey properties", () => {
    const o = buildConnectionOptions(parseEnv({}));
    expect(o).toEqual({ address: "localhost:7233" });
    expect("tls" in o).toBe(false);
    expect("apiKey" in o).toBe(false);
    expect(Object.keys(o)).toEqual(["address"]);
  });
  it("empty key behaves as no key", () => {
    const o = buildConnectionOptions(parseEnv({ TEMPORAL_API_KEY: "" }));
    expect("tls" in o).toBe(false);
    expect("apiKey" in o).toBe(false);
  });
});

describe("workflows", () => {
  it("noopWorkflow resolves ok", async () => {
    await expect(noopWorkflow()).resolves.toBe("ok");
  });
  it("workflows.ts imports nothing but @temporalio/workflow", () => {
    const src = readFileSync(new URL("../src/workflows.ts", import.meta.url), "utf8");
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    for (const s of specs) expect(s).toBe("@temporalio/workflow");
  });
});

describe("index.ts secrecy (static)", () => {
  it("never references TEMPORAL_API_KEY or logs env wholesale", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/TEMPORAL_API_KEY/);
    expect(src).not.toMatch(/console\.\w+\([^)]*(\benv\b(?!\.TEMPORAL_ADDRESS)|apiKey|process\.env)/);
  });
});
