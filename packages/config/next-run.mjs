// Cross-platform launcher: `node next-run.mjs <defaultPort> <dev|start>`.
// PORT from the environment wins; otherwise the app's default is used.
// Avoids `${PORT:-n}` shell expansion, which cmd.exe does not support.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const [defaultPort, command] = process.argv.slice(2);
const nextBin = createRequire(`${process.cwd()}/`).resolve("next/dist/bin/next");
const port = process.env.PORT || defaultPort;

const child = spawn(process.execPath, [nextBin, command, "-p", port], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
