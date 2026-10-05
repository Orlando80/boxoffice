import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "../../src/venues");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const read = (f: string) => strip(readFileSync(join(dir, f), "utf8"));

describe("venues domain is pure", () => {
  it("has source files", () => expect(files.length).toBeGreaterThanOrEqual(4));
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
