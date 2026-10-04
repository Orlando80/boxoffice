import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = "test/repo/versions.test.ts";
const EXEMPT = new Set(["package.json", ".nvmrc", "pnpm-lock.yaml", SELF]);
const FORBIDDEN = [/pnpm@12/, /node:24/, /node-version:\s*24/];

export function findLiterals(text: string): string[] {
  return FORBIDDEN.filter((re) => re.test(text)).map((re) => re.source);
}

function git(args: string[]): string[] {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function candidateFiles(): string[] {
  const all = [
    ...git(["ls-files"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ];
  return [...new Set(all)].filter(
    (f) => !EXEMPT.has(f) && !f.startsWith("intent/"),
  );
}

describe("pinned versions (AC 5)", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

  it("packageManager is pnpm 12.9.x", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@12\.9\./);
  });
  it("engines.node is 24.x", () => {
    expect(pkg.engines.node).toBe("24.x");
  });
  it(".nvmrc is 24", () => {
    expect(readFileSync(resolve(root, ".nvmrc"), "utf8").trim()).toBe("24");
  });

  it("scanner detects planted literals (non-vacuous)", () => {
    expect(findLiterals("FROM node:24-slim")).toHaveLength(1);
    expect(findLiterals("corepack use pnpm@12.9.1")).toHaveLength(1);
    expect(findLiterals("with:\n  node-version: 24")).toHaveLength(1);
    expect(findLiterals("nothing to see, node:2")).toHaveLength(0);
  });

  it("candidate list is non-empty and includes untracked files", () => {
    const files = candidateFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("turbo.json");
    expect(files).not.toContain(SELF);
    expect(files.some((f) => f.startsWith("intent/"))).toBe(false);
  });

  it("no other file hard-codes the versions", () => {
    const offenders: string[] = [];
    for (const f of candidateFiles()) {
      let text: string;
      try {
        text = readFileSync(resolve(root, f), "utf8");
      } catch {
        continue;
      }
      const hits = findLiterals(text);
      if (hits.length) offenders.push(`${f}: ${hits.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("workspace packages (P1)", () => {
  it("are @boxoffice/<dir> and private", () => {
    const dirs = [...git(["ls-files", "-co", "--exclude-standard"])]
      .filter((f) => /^(apps|packages)\/[^/]+\/package\.json$/.test(f));
    expect(dirs.length).toBeGreaterThan(0);
    for (const f of dirs) {
      const p = JSON.parse(readFileSync(resolve(root, f), "utf8"));
      expect(p.name).toBe(`@boxoffice/${f.split("/")[1]}`);
      expect(p.private).toBe(true);
    }
  });
});

describe("turbo.json (AC 4, F3)", () => {
  const t = JSON.parse(readFileSync(resolve(root, "turbo.json"), "utf8"));
  it("test has no dependsOn test:int and nothing docker", () => {
    expect(JSON.stringify(t.tasks.test)).not.toMatch(/test:int|docker/i);
    expect(JSON.stringify(t).toLowerCase()).not.toContain("docker");
  });
  it("globalDependencies cover root configs", () => {
    for (const d of ["turbo.json", "package.json", "pnpm-lock.yaml", ".nvmrc"])
      expect(t.globalDependencies).toContain(d);
    const g = t.globalDependencies.join(" ");
    expect(g).toMatch(/tsconfig/);
    expect(g).toMatch(/eslint/);
    expect(g).toMatch(/vitest/);
  });
});
