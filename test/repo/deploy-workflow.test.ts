import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const file = resolve(root, ".github/workflows/deploy.yml");
const raw = readFileSync(file, "utf8");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wf: any = parse(raw);

const PUSH_COND =
  "github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository";

function keysDeep(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => keysDeep(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const steps: any[] = wf.jobs.images.steps;
const find = (pred: (s: any) => boolean) => steps.find(pred); // eslint-disable-line @typescript-eslint/no-explicit-any
const login = find((s) => String(s.uses ?? "").startsWith("docker/login-action"));
const build = find((s) => String(s.uses ?? "").startsWith("docker/build-push-action"));

describe("deploy.yml (AC 18, F7)", () => {
  it("is promoted: deploy.yml exists and deploy.yml.proposed does not", () => {
    expect(existsSync(resolve(root, ".github/workflows/deploy.yml"))).toBe(true);
    expect(existsSync(resolve(root, ".github/workflows/deploy.yml.proposed"))).toBe(false);
  });

  it("top-level permissions are exactly contents: read, packages: write", () => {
    expect(wf.permissions).toEqual({ contents: "read", packages: "write" });
  });

  it("no job-level permission escalation", () => {
    for (const job of Object.values<any>(wf.jobs)) {
      // eslint-disable-line @typescript-eslint/no-explicit-any
      if (job.permissions !== undefined) {
        expect(job.permissions).toEqual({ contents: "read", packages: "write" });
      }
    }
    expect(raw).not.toMatch(/write-all|id-token|contents:\s*write/);
  });

  it("has no FLY_API_TOKEN, no 'fly' text, no environment key", () => {
    expect(raw).not.toContain("FLY_API_TOKEN");
    expect(raw.toLowerCase()).not.toContain("fly");
    expect(keysDeep(wf)).not.toContain("environment");
    expect(raw).not.toMatch(/^\s*environment\s*:/m);
  });

  it("only secret referenced is secrets.GITHUB_TOKEN", () => {
    const refs = raw.match(/secrets\.[A-Za-z0-9_]+/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    expect(new Set(refs)).toEqual(new Set(["secrets.GITHUB_TOKEN"]));
    expect(raw).not.toMatch(/secrets\[|toJSON\(secrets\)|secrets:\s*inherit/);
  });

  it("does not use pull_request_target; triggers are pull_request + push main", () => {
    expect(raw).not.toContain("pull_request_target");
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "push"]);
    expect(wf.on.push.branches).toEqual(["main"]);
  });

  it("push condition appears on login `if` and build-push `push`", () => {
    expect(login).toBeDefined();
    expect(build).toBeDefined();
    expect(login.if).toBe(PUSH_COND);
    expect(String(build.with.push)).toBe(`\${{ ${PUSH_COND} }}`);
  });

  it("login uses ghcr.io with GITHUB_TOKEN", () => {
    expect(login.with.registry).toBe("ghcr.io");
    expect(login.with.password).toBe("${{ secrets.GITHUB_TOKEN }}");
  });

  it("owner is lowercased and the tag uses the lowercased output", () => {
    const ownerStep = find((s) => s.id === "owner");
    expect(ownerStep.run).toMatch(/\$\{GITHUB_REPOSITORY_OWNER,,\}/);
    expect(ownerStep.run).toContain('>> "$GITHUB_OUTPUT"');
    const tags: string = build.with.tags;
    expect(tags).toContain("${{ steps.owner.outputs.owner }}");
    expect(raw).not.toMatch(/github\.repository_owner/);
    expect(tags).not.toMatch(/repository_owner|github\.repository\b/);
    expect(
      tags.startsWith("ghcr.io/${{ steps.owner.outputs.owner }}/boxoffice-${{ matrix.app }}:"),
    ).toBe(true);
  });

  it("tag uses pull_request head sha falling back to github.sha", () => {
    expect(
      build.with.tags.endsWith(":${{ github.event.pull_request.head.sha || github.sha }}"),
    ).toBe(true);
  });

  it("NODE_VERSION build-arg comes from .nvmrc", () => {
    const nodeStep = find((s) => s.id === "node");
    expect(nodeStep.run).toContain(".nvmrc");
    expect(build.with["build-args"].trim()).toBe("NODE_VERSION=${{ steps.node.outputs.version }}");
  });

  it("matrix covers exactly the five apps and does not fail fast", () => {
    expect([...wf.jobs.images.strategy.matrix.app].sort()).toEqual([
      "admin",
      "api",
      "scanner",
      "web",
      "worker",
    ]);
    expect(wf.jobs.images.strategy["fail-fast"]).toBe(false);
    expect(build.with.file).toBe("apps/${{ matrix.app }}/Dockerfile");
  });

  it(".nvmrc pipeline logic yields 24 (JS emulation of tr -d 'v\\r\\n')", () => {
    const nvmrc = readFileSync(resolve(root, ".nvmrc"), "utf8");
    expect(nvmrc.replace(/[v\r\n]/g, "")).toBe("24");
    // Also CRLF and v-prefixed variants.
    expect("v24\r\n".replace(/[v\r\n]/g, "")).toBe("24");
  });

  it(".nvmrc pipeline yields 24 via the real shell command from the workflow", () => {
    const nodeStep = find((s) => s.id === "node");
    const m = /\$\((.+)\)/.exec(nodeStep.run);
    expect(m).not.toBeNull();
    let out: string;
    try {
      out = execFileSync("bash", ["-c", `echo "version=$(${m![1]})"`], {
        cwd: root,
        encoding: "utf8",
      }).trim();
    } catch {
      return; // bash unavailable; JS emulation above covers the logic
    }
    expect(out).toBe("version=24");
  });
});
