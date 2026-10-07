import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../src");
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
  );
const files = walk(root).map((p) => relative(root, p).replaceAll("\\", "/"));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const read = (f: string) => strip(readFileSync(join(root, f), "utf8"));

describe("domain is pure", () => {
  it("has source files", () => expect(files.length).toBeGreaterThanOrEqual(4));
  it("covers venues, reservation and the top-level modules", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "index.ts",
        "result.ts",
        "venues/invariants.ts",
        "reservation/types.ts",
        "reservation/rules.ts",
        "reservation/state.ts",
      ]),
    );
  });
  it.each(files)("%s imports only relative modules", (f) => {
    const specs = [
      ...read(f).matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g),
    ].map((m) => m[1]!);
    for (const s of specs) {
      expect(s.startsWith("./") || s.startsWith("../"), `${f} imports ${s}`).toBe(true);
    }
  });
  it.each(files)("%s uses no I/O or nondeterministic globals", (f) => {
    expect(read(f)).not.toMatch(
      /\b(fetch|process\.env|XMLHttpRequest|WebSocket|console\.|Date\.now|Math\.random|new Date\(\))/,
    );
  });
  it.each(files)("%s has no money-like number fields", (f) => {
    expect(read(f)).not.toMatch(
      /\b(price|amount|cost|fee|pence|pounds|money|total)\w*\s*\??:\s*number/i,
    );
  });
});
