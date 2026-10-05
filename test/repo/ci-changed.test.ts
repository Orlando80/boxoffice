import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(root, "scripts/ci-changed.mjs");
const FILTER = "--filter=...[origin/main]";

// @ts-expect-error plain .mjs without types
const mod = await import(pathToFileURL(script).href);
const buildArgs: (env: Record<string, string | undefined>, task: string) => string[] = mod.buildArgs;

describe("buildArgs", () => {
  for (const task of ["typecheck", "lint", "test"]) {
    it(`PR ${task} is filtered`, () => {
      expect(buildArgs({ GITHUB_EVENT_NAME: "pull_request" }, task)).toEqual(["turbo", "run", task, FILTER]);
    });
    for (const ev of ["push", "", undefined, "workflow_dispatch", "pull_request_target", "PULL_REQUEST"]) {
      it(`${String(ev)} ${task} is unfiltered`, () => {
        expect(buildArgs({ GITHUB_EVENT_NAME: ev }, task)).toEqual(["turbo", "run", task]);
      });
    }
    it(`empty env ${task} is unfiltered`, () => {
      expect(buildArgs({}, task)).toEqual(["turbo", "run", task]);
    });
  }
  it("throws for unknown tasks", () => {
    for (const t of ["build", "bogus", "", "test:int", "lint; echo hi", undefined as unknown as string]) {
      expect(() => buildArgs({}, t)).toThrow();
    }
  });
  it("does not mutate env", () => {
    const env = { GITHUB_EVENT_NAME: "pull_request" };
    buildArgs(env, "lint");
    expect(env).toEqual({ GITHUB_EVENT_NAME: "pull_request" });
  });
});

describe("entrypoint", () => {
  it("importing the module spawns nothing and exits cleanly", () => {
    const url = JSON.stringify(pathToFileURL(script).href);
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `const m = await import(${url}); console.log(typeof m.buildArgs)`],
      { encoding: "utf8", timeout: 15000 },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("function");
    expect(r.stdout).not.toContain("pnpm exec");
  });
  it("bogus task exits non-zero without running turbo", () => {
    const r = spawnSync(process.execPath, [script, "bogus"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request" },
      timeout: 15000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("pnpm exec");
  });
  it("missing task exits non-zero", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15000 });
    expect(r.status).not.toBe(0);
  });
});
