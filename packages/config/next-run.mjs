// Cross-platform launcher: `node next-run.mjs <defaultPort> <dev|serve>` (cwd = app dir).
// PORT from the environment wins; otherwise the app's default is used.
// Avoids `${PORT:-n}` shell expansion, which cmd.exe does not support.
//
// `serve` runs the standalone server (the artefact Docker ships), not `next start`,
// which does not support `output: "standalone"`. It copies .next/static and public
// next to server.js when missing, as the Docker image does.
import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const [defaultPort, command] = process.argv.slice(2);
const port = process.env.PORT || defaultPort;
const appDir = process.cwd();

let args;
const env = { ...process.env };
if (command === "serve") {
  const root = path.resolve(appDir, "../..");
  const standaloneApp = path.join(
    appDir,
    ".next/standalone",
    path.relative(root, appDir),
  );
  const server = path.join(standaloneApp, "server.js");
  if (!existsSync(server)) {
    console.error(`No standalone build at ${server}. Run \`pnpm build\` first.`);
    process.exit(1);
  }
  for (const [from, to] of [
    [path.join(appDir, ".next/static"), path.join(standaloneApp, ".next/static")],
    [path.join(appDir, "public"), path.join(standaloneApp, "public")],
  ]) {
    if (existsSync(from) && !existsSync(to)) cpSync(from, to, { recursive: true });
  }
  env.PORT = port;
  // HOSTNAME defaults to the machine name on Windows; bind explicitly (Docker runs server.js directly with HOSTNAME=0.0.0.0).
  env.HOSTNAME = "127.0.0.1";
  args = [server];
} else {
  const nextBin = createRequire(`${appDir}/`).resolve("next/dist/bin/next");
  args = [nextBin, command, "-p", port, ...process.argv.slice(4)];
}

const child = spawn(process.execPath, args, { stdio: "inherit", env });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
