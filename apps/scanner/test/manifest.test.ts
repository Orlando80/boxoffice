import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "../app/manifest";

const pub = join(__dirname, "..", "public");
const m = manifest();

describe("manifest", () => {
  it("has required non-empty fields", () => {
    for (const k of ["name", "start_url", "display"] as const) {
      expect(typeof m[k]).toBe("string");
      expect((m[k] as string).trim().length).toBeGreaterThan(0);
    }
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.icons?.length ?? 0).toBeGreaterThan(0);
  });

  it("every icon file exists under public/", () => {
    for (const icon of m.icons ?? []) {
      expect(icon.src.startsWith("/")).toBe(true);
      expect(existsSync(join(pub, icon.src))).toBe(true);
    }
  });

  it("icon.svg is an SVG", () => {
    const svg = readFileSync(join(pub, "icon.svg"), "utf8").trim();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("xmlns");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.localName).toBe("svg");
  });
});
