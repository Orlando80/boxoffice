import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const APPS = ["api", "web", "admin", "scanner", "worker"];

/** Pure: docker argv for building an app image. `nvmrc` is the raw .nvmrc contents. */
export function buildArgs(app, nvmrc) {
  if (!APPS.includes(app)) {
    throw new Error(`unknown app "${app}" (expected one of ${APPS.join(", ")})`);
  }
  const version = String(nvmrc).replace(/^\s*v/, "").trim();
  if (!/^\d+(\.\d+){0,2}$/.test(version)) {
    throw new Error(`.nvmrc does not contain a Node version: "${version}"`);
  }
  return [
    "build",
    "-f",
    `apps/${app}/Dockerfile`,
    "--build-arg",
    `NODE_VERSION=${version}`,
    "-t",
    `boxoffice-${app}:local`,
    ".",
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let args;
  try {
    args = buildArgs(process.argv[2], readFileSync(new URL("../.nvmrc", import.meta.url), "utf8"));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  console.log(`> docker ${args.join(" ")}`);
  // Args are validated constants; shell only on Windows for .cmd shims.
  const r = spawnSync("docker", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.error) {
    console.error(r.error.message);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}
