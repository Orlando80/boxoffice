import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTemporalTarget, type TemporalTarget } from "./temporal-target.js";

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URL_ = "postgres://user:s3cret-pass@127.0.0.1:1/db";

describe("worker startup with unreachable database (failure mode: worker can't reach the DB)", () => {
  let target: TemporalTarget;
  beforeAll(async () => {
    target = await getTemporalTarget();
  }, 150_000);
  afterAll(async () => {
    await target?.stop();
  });

  it("logs the host once, stays alive, relay logs host-only failures, no secrets", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: workerDir,
      env: {
        // Full parent env: the native swc binding (workflow bundling) fails to load on Windows
        // with a minimal env. Secrets that could alter behaviour are blanked below.
        ...process.env,
        TEMPORAL_API_KEY: "",
        TEMPORAL_NAMESPACE: "default",
        DATABASE_URL: URL_,
        TEMPORAL_ADDRESS: target.address,
      },
    });
    let out = "";
    let exited = false;
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", () => (exited = true));
    try {
      const start = Date.now();
      while (Date.now() - start < 8000 || !/relay tick failed/.test(out)) {
        if (Date.now() - start > 30_000) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (exited) console.log("WORKER OUT>>" + out.replaceAll("s3cret-pass", "<pw>") + "<<");
      expect(exited).toBe(false);
      const unreachable = out.split("\n").filter((l) => l.includes("Database unreachable"));
      expect(unreachable).toHaveLength(1);
      expect(unreachable[0]).toContain("Database unreachable at host 127.0.0.1; retrying");
      expect(out).toContain("relay tick failed (db host 127.0.0.1); will retry");
      expect(out).not.toContain("s3cret-pass");
      expect(out).not.toContain(URL_);
      expect(out).not.toContain("postgres://");
      expect(out).not.toContain("Failed to connect to Temporal");
    } finally {
      child.kill();
    }
  }, 60_000);
});
