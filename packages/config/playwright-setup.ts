import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Vitest globalSetup: ensures Playwright's Chromium is installed. The install
 * is a no-op (about a second) when the browser is already cached; the first
 * run downloads it. No --with-deps (system packages are the runner's job).
 */
export default function setup(): void {
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
  const res = spawnSync(process.execPath, [cli, "install", "chromium"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60_000,
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    const detail = (res.error?.message ?? `${res.stdout}\n${res.stderr}`).trim().slice(-2000);
    throw new Error(
      `Could not install Playwright Chromium (required by pnpm test:int browser tests). ` +
        `Check network access, or run "pnpm exec playwright install chromium" manually.\n${detail}`,
    );
  }
}
