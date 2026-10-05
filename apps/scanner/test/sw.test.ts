import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("public/sw.js is a no-op worker (Q5)", () => {
  it("has no fetch, caches. or sync", () => {
    expect(code).not.toMatch(/fetch/i);
    expect(code).not.toMatch(/caches\s*\./);
    expect(code).not.toMatch(/sync/i);
  });

  it("registers only install/activate listeners", () => {
    const names = [...code.matchAll(/addEventListener\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(["install", "activate"]).toContain(n);
    expect(new Set(names)).toEqual(new Set(["install", "activate"]));
    expect((code.match(/addEventListener/g) ?? []).length).toBe(names.length);
  });

  it("has no onfetch/onmessage handler assignments", () => {
    expect(code).not.toMatch(/\bon(fetch|message|push|sync)\b/);
  });
});
