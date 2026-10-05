import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TASKS = ["typecheck", "lint", "test"];

/** Pure: turbo argv for a CI task. PRs run affected-only; everything else runs all. */
export function buildArgs(env, task) {
  if (!TASKS.includes(task)) {
    throw new Error(`unknown task "${task}" (expected one of ${TASKS.join(", ")})`);
  }
  const args = ["turbo", "run", task];
  if (env.GITHUB_EVENT_NAME === "pull_request") args.push("--filter=...[origin/main]");
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let args;
  try {
    args = buildArgs(process.env, process.argv[2]);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  console.log(`> pnpm exec ${args.join(" ")}`);
  // .cmd shims need a shell on Windows; args are validated constants.
  const r = spawnSync("pnpm", ["exec", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
