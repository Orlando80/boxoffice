import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mod = (await import(pathToFileURL(join(root, "scripts", "docker-build.mjs")).href)) as {
  APPS: string[];
  buildArgs: (app: string, nvmrc: string) => string[];
};
const { APPS, buildArgs } = mod;

describe("docker-build buildArgs", () => {
  it("APPS is exactly the five apps", () => {
    expect([...APPS].sort()).toEqual(["admin", "api", "scanner", "web", "worker"]);
  });

  it.each(["24\n", "v24\r\n", " v24 ", "24", "24.1.0\n", "v24.1\n"])("builds argv for %j", (rc) => {
    const v = rc.replace(/^\s*v/, "").trim();
    expect(buildArgs("api", rc)).toEqual([
      "build",
      "-f",
      "apps/api/Dockerfile",
      "--build-arg",
      `NODE_VERSION=${v}`,
      "-t",
      "boxoffice-api:local",
      ".",
    ]);
  });

  it.each(APPS)("uses app-specific file and tag for %s", (app) => {
    const a = buildArgs(app, "24\n");
    expect(a).toContain(`apps/${app}/Dockerfile`);
    expect(a).toContain(`boxoffice-${app}:local`);
    expect(a).toContain("NODE_VERSION=24");
  });

  it.each([
    "bogus",
    "../x",
    "..",
    "api/../web",
    "api; echo hi",
    "API",
    "",
    " api",
    "api\n",
    "__proto__",
    "constructor",
  ])("rejects app %j", (app) => {
    expect(() => buildArgs(app, "24\n")).toThrow();
  });

  it("rejects undefined app", () => {
    expect(() => buildArgs(undefined as unknown as string, "24\n")).toThrow();
  });

  it.each(["", "\n", "lts/*", "latest", "24 && calc", "v", "24.x", "abc", "24\n25", "--rm"])(
    "rejects nvmrc %j",
    (rc) => {
      expect(() => buildArgs("api", rc)).toThrow();
    },
  );
});

describe("docker-build CLI", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(root, "scripts", "docker-build.mjs"), ...args], {
      encoding: "utf8",
    });
  it.each([[["bogus"]], [[]], [["../x"]]])("exits 2 without invoking docker for %j", (args) => {
    const r = run(...args);
    expect(r.status).toBe(2);
    expect(r.stdout).not.toContain("> docker");
  });
});
