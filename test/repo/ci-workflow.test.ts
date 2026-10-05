import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const raw = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
/* eslint-disable @typescript-eslint/no-explicit-any */
const wf: any = parse(raw);
const jobs: Record<string, any> = wf.jobs;

const RUN: Record<string, string> = {
  typecheck: "pnpm ci:changed typecheck",
  lint: "pnpm ci:changed lint",
  unit: "pnpm ci:changed test",
  integration: "pnpm test:int",
  soak: "pnpm soak",
};
const INSTALL = "pnpm install --frozen-lockfile";

describe("ci.yml AC 13 triggers", () => {
  it("never uses pull_request_target", () => {
    expect(raw).not.toContain("pull_request_target");
  });
  it("never references secrets.", () => {
    expect(raw).not.toMatch(/secrets\./);
  });
  it("triggers are exactly pull_request and push on main", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "push"]);
    expect(wf.on.push.branches).toEqual(["main"]);
  });
  it("no paths filters under any trigger", () => {
    for (const t of Object.values(wf.on) as Array<Record<string, unknown> | null>) {
      expect(t?.paths).toBeUndefined();
      expect(t?.["paths-ignore"]).toBeUndefined();
    }
    expect(raw).not.toMatch(/paths(-ignore)?:/);
  });
  it("permissions contents: read only", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const j of Object.values(jobs)) {
      if (j.permissions !== undefined) expect(j.permissions).toEqual({ contents: "read" });
    }
  });
  it("has per-ref concurrency", () => {
    expect(wf.concurrency.group).toContain("github.ref");
  });
});

describe("ci.yml AC 14 jobs", () => {
  it("job ids are exactly the five", () => {
    expect(Object.keys(jobs).sort()).toEqual(Object.keys(RUN).sort());
  });
  for (const [id, cmd] of Object.entries(RUN)) {
    describe(id, () => {
      const job = jobs[id];
      const steps: any[] = job.steps;
      const runs = steps.filter((s) => s.run !== undefined).map((s) => String(s.run).trim());
      it("name equals id, no strategy/matrix", () => {
        expect(job.name).toBe(id);
        expect(job.strategy).toBeUndefined();
        expect(raw).not.toMatch(/matrix/);
      });
      it("has install then exactly one other run step, a single pnpm command", () => {
        expect(runs).toHaveLength(2);
        expect(runs[0]).toBe(INSTALL);
        expect(runs[1]).toBe(cmd);
        expect(runs[1]).toMatch(/^pnpm [^&;|\n]+$/);
      });
      it("sets up pnpm and node from .nvmrc", () => {
        const uses = steps.map((s) => String(s.uses ?? ""));
        expect(uses.some((u) => u.startsWith("pnpm/action-setup"))).toBe(true);
        const node = steps.find((s) => String(s.uses ?? "").startsWith("actions/setup-node"));
        expect(node.with["node-version-file"]).toBe(".nvmrc");
      });
      it("install precedes the task", () => {
        const idx = (c: string) => steps.findIndex((s) => String(s.run ?? "").trim() === c);
        expect(idx(INSTALL)).toBeLessThan(idx(cmd));
      });
      if (cmd.includes("ci:changed")) {
        it("checks out with fetch-depth 0", () => {
          const co = steps.find((s) => String(s.uses ?? "").startsWith("actions/checkout"));
          expect(co.with["fetch-depth"]).toBe(0);
        });
      }
    });
  }
});
