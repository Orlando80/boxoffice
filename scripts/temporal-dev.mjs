// `pnpm temporal:dev`: Temporal dev server in Docker (localhost:7233, UI :8233).
// The image tag lives in apps/worker/src/temporal-image.ts, shared with the int test.
import { spawn } from "node:child_process";
import { TEMPORAL_DEV_IMAGE } from "../apps/worker/src/temporal-image.ts";

const child = spawn(
  "docker",
  ["run", "--rm", "-p", "7233:7233", "-p", "8233:8233", TEMPORAL_DEV_IMAGE, "server", "start-dev", "--ip", "0.0.0.0"],
  { stdio: "inherit" },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => {
  console.error(`temporal:dev: could not run docker (${e.message})`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
