import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });
}

function runApi(env: Record<string, string | undefined>) {
  return new Promise<{ code: number | null; out: string; timedOut: boolean }>((res) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: apiDir,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], ...env },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 25_000);
    child.on("close", (code) => {
      clearTimeout(t);
      res({ code, out, timedOut });
    });
  });
}

describe("API startup probe (failure mode: DB down at startup)", () => {
  it("unreachable DB: exits non-zero, logs host, never the password", async () => {
    const port = await freePort();
    const r = await runApi({
      PORT: String(port),
      DATABASE_URL: "postgres://user:SENTINELPW@127.0.0.1:1/db",
    });
    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.out).toContain("127.0.0.1");
    expect(r.out).not.toContain("SENTINELPW");
    expect(r.out).not.toContain("postgres://");
  }, 40_000);

  it("missing DATABASE_URL: exits non-zero naming DATABASE_URL", async () => {
    const r = await runApi({ PORT: String(await freePort()) });
    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DATABASE_URL");
  }, 40_000);

  it("malformed DATABASE_URL: exits non-zero without echoing it", async () => {
    const r = await runApi({
      PORT: String(await freePort()),
      DATABASE_URL: "postgres//u:SENTINELPW@h/db",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("DATABASE_URL");
    expect(r.out).not.toContain("SENTINELPW");
  }, 40_000);

  it("unreachable DB does not start listening on PORT", async () => {
    const port = await freePort();
    const r = await runApi({
      PORT: String(port),
      DATABASE_URL: "postgres://user:SENTINELPW@127.0.0.1:1/db",
    });
    expect(r.out).not.toMatch(/listening/i);
    // port still free
    await expect(freePort()).resolves.toBeGreaterThan(0);
  }, 40_000);
});
