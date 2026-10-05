import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const APPS = ["api", "web", "admin", "scanner", "worker"] as const;
const NEXT = ["web", "admin", "scanner"] as const;

const read = (p: string) => readFileSync(join(root, p), "utf8");
// Join line continuations, drop comments and blanks.
const lines = (app: string) =>
  read(`apps/${app}/Dockerfile`)
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

describe.each(APPS)("apps/%s/Dockerfile (AC 19)", (app) => {
  it("exists", () => {
    expect(existsSync(join(root, "apps", app, "Dockerfile"))).toBe(true);
  });

  it("declares ARG NODE_VERSION with no default before the first FROM", () => {
    const ls = lines(app);
    const firstFrom = ls.findIndex((l) => /^FROM\s/i.test(l));
    expect(firstFrom).toBeGreaterThan(0);
    const before = ls.slice(0, firstFrom);
    expect(before.filter((l) => /^ARG\s+NODE_VERSION$/.test(l))).toHaveLength(1);
    expect(ls.some((l) => /^ARG\s+NODE_VERSION\s*=/.test(l))).toBe(false);
  });

  it("every FROM uses ${NODE_VERSION} or an earlier stage; no literal node version", () => {
    const froms = lines(app).filter((l) => /^FROM\s/i.test(l));
    expect(froms.length).toBeGreaterThanOrEqual(3);
    const stages = new Set<string>();
    for (const f of froms) {
      const m = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(f);
      expect(m, f).not.toBeNull();
      const image = m![1] as string;
      if (!stages.has(image)) {
        expect(image).toMatch(/^node:\$\{NODE_VERSION\}-bookworm-slim$/);
      }
      if (m![2]) stages.add(m![2]);
    }
    expect(read(`apps/${app}/Dockerfile`)).not.toMatch(/node:\d/);
  });

  it("final stage runs as non-root `node`, set before CMD", () => {
    const ls = lines(app);
    const lastFrom = ls.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
    const final = ls.slice(lastFrom);
    const users = final.filter((l) => /^USER\s/i.test(l));
    expect(users.length).toBeGreaterThan(0);
    expect(users[users.length - 1]).toBe("USER node");
    const iUser = final.lastIndexOf(users[users.length - 1] as string);
    const iCmd = final.findIndex((l) => /^CMD\s/i.test(l));
    expect(iCmd).toBeGreaterThan(iUser);
  });

  it("does not use --force", () => {
    expect(read(`apps/${app}/Dockerfile`)).not.toMatch(/--force\b/);
  });

  it("installs with a frozen lockfile", () => {
    expect(read(`apps/${app}/Dockerfile`)).toMatch(/--frozen-lockfile/);
  });
});

describe.each(NEXT)("Next app %s", (app) => {
  it("CMD runs its server.js and sets HOSTNAME=0.0.0.0", () => {
    const text = lines(app).join("\n");
    expect(text).toContain(`CMD ["node", "apps/${app}/server.js"]`);
    expect(text).toMatch(/HOSTNAME=0\.0\.0\.0/);
  });
});

describe("ports", () => {
  it("api EXPOSEs 4000", () => {
    expect(lines("api").some((l) => /^EXPOSE\s+4000$/.test(l))).toBe(true);
  });
  it("next apps expose 3000/3001/3002", () => {
    expect(lines("web").some((l) => /^EXPOSE\s+3000$/.test(l))).toBe(true);
    expect(lines("admin").some((l) => /^EXPOSE\s+3001$/.test(l))).toBe(true);
    expect(lines("scanner").some((l) => /^EXPOSE\s+3002$/.test(l))).toBe(true);
  });
});

describe(".dockerignore", () => {
  const rules = read(".dockerignore")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const positive = rules.filter((r) => !r.startsWith("!"));

  it("excludes node_modules, .git and .env*", () => {
    expect(positive).toContain("**/node_modules");
    expect(positive).toContain(".git");
    expect(positive).toContain(".env*");
  });

  it("only re-includes .env.example, never real env files", () => {
    const neg = rules.filter((r) => r.startsWith("!"));
    expect(neg.filter((r) => /\.env/.test(r))).toEqual(["!.env.example"]);
  });

  it.each([
    "pnpm-lock.yaml",
    "package.json",
    "apps",
    "packages",
    ".nvmrc",
    "pnpm-workspace.yaml",
    "turbo.json",
    "tsconfig.json",
  ])("does not exclude %s", (name) => {
    for (const variant of [name, `${name}/`, `/${name}`, `**/${name}`]) {
      expect(positive).not.toContain(variant);
    }
  });

  it("*.md rule is root-only and the build copies no markdown", () => {
    // Docker's non-recursive `*.md` matches only root-level files.
    expect(rules).toContain("*.md");
    expect(rules).not.toContain("**/*.md");
    for (const app of APPS) {
      for (const l of lines(app).filter((x) => /^(COPY|ADD)\s/i.test(x))) {
        expect(l, `${app}: ${l}`).not.toMatch(/\.md\b/);
      }
    }
  });
});
