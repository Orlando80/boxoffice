import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo: trace dependencies from the repo root so standalone output works in Docker.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
};

export default nextConfig;
