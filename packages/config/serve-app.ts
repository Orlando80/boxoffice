import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

export interface RunningApp {
  url: string;
  stop: () => Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a built Next app (`pnpm build` first) via its `start` mechanism
 * (standalone server through next-run.mjs) on a free port and waits until it
 * answers HTTP. `appDir` is the absolute app directory, e.g. the test's `process.cwd()`
 * or `path.resolve(import.meta.dirname, "..")`.
 */
export async function startApp(
  appDir: string,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<RunningApp> {
  const port = await freePort();
  const launcher = path.resolve(import.meta.dirname, "next-run.mjs");
  const child = spawn(process.execPath, [launcher, String(port), "serve"], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
  let exited = false;
  child.on("exit", () => (exited = true));

  const stop = async (): Promise<void> => {
    if (exited || child.pid === undefined) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (!exited) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  };

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) throw new Error(`App at ${appDir} exited before becoming ready:\n${output}`);
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return { url, stop };
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`App at ${appDir} not ready after ${timeoutMs}ms:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
