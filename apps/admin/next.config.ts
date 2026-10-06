import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Stop `next dev` writing AGENTS.md / CLAUDE.md into the app directory.
  agentRules: false,
  // Monorepo: trace dependencies from the repo root so standalone output works in Docker.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // Workspace packages export TypeScript source (with .js import specifiers).
  transpilePackages: ["@boxoffice/contracts", "@boxoffice/domain"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
