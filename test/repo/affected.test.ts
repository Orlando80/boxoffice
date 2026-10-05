import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const json = (p: string) => JSON.parse(readFileSync(resolve(root, p), "utf8"));

function workspaceNames(): string[] {
  const names: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const d of readdirSync(resolve(root, group), { withFileTypes: true })) {
      const pkg = resolve(root, group, d.name, "package.json");
      if (d.isDirectory() && existsSync(pkg)) names.push(json(`${group}/${d.name}/package.json`).name);
    }
  }
  return names;
}

describe("affected-only runs still select repo checks (AC 15-17, AC 20)", () => {
  it("repo-tests depends on every workspace package", () => {
    const names = workspaceNames();
    expect(names.length).toBeGreaterThanOrEqual(9);
    const deps = json("test/repo/package.json").devDependencies as Record<string, string>;
    for (const n of names) {
      expect(deps[n], `${n} missing from test/repo devDependencies`).toBe("workspace:*");
    }
  });

  it("turbo.json globalDependencies cover every root-level file the repo tests read", () => {
    const g: string[] = json("turbo.json").globalDependencies;
    for (const f of [
      ".env.example",
      "SECURITY.md",
      "README.md",
      ".github/pull_request_template.md",
      ".github/workflows/deploy.yml",
      ".github/workflows/ci.yml",
      ".nvmrc",
      "package.json",
      "turbo.json",
      "pnpm-lock.yaml",
    ]) {
      expect(g, `${f} missing from globalDependencies`).toContain(f);
    }
  });

  it("test/repo/turbo.json extends root and adds Dockerfile and src inputs to test", () => {
    const t = json("test/repo/turbo.json");
    expect(t.extends).toEqual(["//"]);
    const inputs: string[] = t.tasks.test.inputs;
    expect(inputs).toContain("$TURBO_DEFAULT$");
    expect(inputs).toContain("$TURBO_ROOT$/apps/*/Dockerfile");
    expect(inputs).toContain("$TURBO_ROOT$/apps/*/src/**");
    expect(inputs).toContain("$TURBO_ROOT$/packages/*/src/**");
    expect(inputs).toContain("$TURBO_ROOT$/.dockerignore");
  });

  it("test:int runs the docker preflight before turbo build", () => {
    const s: string = json("package.json").scripts["test:int"];
    const pre = s.indexOf("docker-preflight");
    const build = s.indexOf("turbo build");
    expect(pre).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(pre);
    expect(s.slice(0, build)).toMatch(/&&\s*$/);
  });
});
