import { spawnSync } from "node:child_process";

export const DOCKER_DOWN_MESSAGE = "Docker is not running (required by pnpm test:int)";

/** Throws DOCKER_DOWN_MESSAGE if the Docker daemon is unreachable within ~8 s. */
export function assertDockerRunning(timeoutMs = 8_000): void {
  const res = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeout: timeoutMs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  if (res.error || res.status !== 0 || !res.stdout.trim()) {
    throw new Error(DOCKER_DOWN_MESSAGE);
  }
}

// Vitest globalSetup entry: fails the whole int run once, fast.
export default function setup(): void {
  assertDockerRunning();
}
