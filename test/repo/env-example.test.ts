import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage", "test"]);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const KEY = "[A-Z][A-Z0-9_]*";
const DOT = new RegExp(`process\\.env\\.(${KEY})`, "g");
const BRACKET = new RegExp(`process\\.env\\[\\s*["'](${KEY})["']\\s*\\]`, "g");
// source["X"] style reads inside parseEnv-like functions.
const SOURCE = new RegExp(`\\bsource\\[\\s*["'](${KEY})["']\\s*\\]`, "g");
const PICK = new RegExp(`\\bpick\\(\\s*["'](${KEY})["']\\s*\\)`, "g");
// Keys of z.object({ ... }) in env.ts: `  KEY: z...` or `  KEY: ident...` at indent 2.
const SCHEMA_KEY = new RegExp(`^\\s{2}(${KEY}):`, "gm");

export function collectKeys(text: string, isEnvFile: boolean): Set<string> {
  const found = new Set<string>();
  const regs = [DOT, BRACKET, SOURCE, PICK];
  for (const re of regs) for (const m of text.matchAll(re)) found.add(m[1] as string);
  if (isEnvFile) {
    for (const block of text.matchAll(/z\.object\(\{([\s\S]*?)\n\}\)/g)) {
      for (const m of (block[1] as string)
        .replace(/^/, "\n")
        .matchAll(/\n\s{2}([A-Z][A-Z0-9_]*):/g)) {
        found.add(m[1] as string);
      }
    }
  }
  void SCHEMA_KEY;
  return found;
}

function collectFromRepo(): Set<string> {
  const files = [
    ...walk(join(root, "apps")).filter((f) => /[\\/]src[\\/]/.test(f)),
    ...walk(join(root, "packages")).filter((f) => /[\\/]src[\\/]/.test(f)),
    join(root, "packages", "config", "next-run.mjs"),
  ].filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && existsSync(f));
  const all = new Set<string>();
  for (const f of files) {
    const isEnv = /[\\/]env\.ts$/.test(f);
    for (const k of collectKeys(readFileSync(f, "utf8"), isEnv)) all.add(k);
  }
  return all;
}

function parseExample(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m && !line.trimStart().startsWith("# ")) keys.add(m[1] as string);
  }
  return keys;
}

function exampleValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out.set(m[1] as string, m[2] as string);
  }
  return out;
}

function git(args: string[]): { status: number } {
  try {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
    return { status: 0 };
  } catch (e) {
    return { status: (e as { status?: number }).status ?? -1 };
  }
}

describe("collector is not vacuous", () => {
  it("finds at least 5 keys in the repo", () => {
    expect(collectFromRepo().size).toBeGreaterThanOrEqual(5);
  });
  it("includes known keys", () => {
    const keys = collectFromRepo();
    for (const k of [
      "PORT",
      "TEMPORAL_ADDRESS",
      "TEMPORAL_NAMESPACE",
      "TEMPORAL_API_KEY",
      "DATABASE_URL",
    ]) {
      expect(keys.has(k)).toBe(true);
    }
  });
  it("detects planted process.env references and schema keys", () => {
    expect(collectKeys("const a = process.env.FAKE_ONE;", false)).toEqual(new Set(["FAKE_ONE"]));
    expect(collectKeys('const a = process.env["FAKE_TWO"];', false)).toEqual(new Set(["FAKE_TWO"]));
    expect(collectKeys("const s = z.object({\n  FAKE_THREE: z.string(),\n});", true)).toEqual(
      new Set(["FAKE_THREE"]),
    );
  });
});

describe(".env.example (AC 20)", () => {
  const load = () => readFileSync(join(root, ".env.example"), "utf8");

  it("lists exactly the variables the skeleton reads", () => {
    const text = load();
    expect([...parseExample(text)].sort()).toEqual([...collectFromRepo()].sort());
  });

  it("has no real-looking secrets", () => {
    const text = load();
    const values = exampleValues(text);
    const apiKey = values.get("TEMPORAL_API_KEY");
    expect(apiKey === "" || /^(changeme|placeholder|<.*>|your-.*)$/i.test(apiKey ?? "x")).toBe(
      true,
    );
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(text).not.toMatch(/sk_(live|test)_|AKIA[0-9A-Z]{12}|ghp_|eyJ[\w-]{10,}/);
    const db = values.get("DATABASE_URL") ?? "";
    expect(db).toMatch(/placeholder|localhost|example/i);
  });
});

describe("repo hygiene", () => {
  it("SECURITY.md is unchanged vs main (AC)", () => {
    expect(git(["diff", "--quiet", "main", "--", "SECURITY.md"]).status).toBe(0);
  });
  it(".env is ignored and .env.example is not", () => {
    expect(git(["check-ignore", "-q", ".env"]).status).toBe(0);
    expect(git(["check-ignore", "-q", ".env.local"]).status).toBe(0);
    expect(git(["check-ignore", "-q", ".env.example"]).status).toBe(1);
  });
});

describe("README and PR template (AC 21-23)", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const tpl = readFileSync(join(root, ".github", "pull_request_template.md"), "utf8");

  it("README has Local setup with prerequisites and commands", () => {
    expect(readme).toMatch(/^## Local setup/m);
    expect(readme).toMatch(/\.nvmrc/);
    expect(readme).toMatch(/corepack/);
    expect(readme).toMatch(/Docker/);
    expect(readme).toMatch(/pnpm install/);
    expect(readme).toMatch(/pnpm temporal:dev/);
    expect(readme).toMatch(/\| Command \|/);
  });
  it("README Intents link target exists", () => {
    const m = /\[monorepo-skeleton\]\(([^)]+)\)/.exec(readme);
    expect(m).not.toBeNull();
    expect(existsSync(join(root, m![1] as string))).toBe(true);
  });
  const PENDING_SCRIPTS: string[] = []; // scripts documented but not yet added
  it("every pnpm script in the README commands table exists in root package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const names = [...readme.matchAll(/^\| `pnpm ([\w:-]+)/gm)].map((m) => m[1] as string);
    expect(names.length).toBeGreaterThan(3);
    for (const n of names.filter((x) => !PENDING_SCRIPTS.includes(x))) expect(Object.keys(pkg.scripts), `script ${n}`).toContain(n);
  });
  it("PR template links intent, spec, plan", () => {
    expect(tpl).toMatch(/intent\/<slug>\/intent\.md/);
    expect(tpl).toMatch(/intent\/<slug>\/spec\.md/);
    expect(tpl).toMatch(/intent\/<slug>\/plan\.md/);
  });
  it("no emails or phone numbers in README or template", () => {
    for (const t of [readme, tpl]) {
      expect(t).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(t).not.toMatch(/\+?\d[\d ()-]{9,}\d/);
    }
  });
});
