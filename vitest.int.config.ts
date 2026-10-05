import { defineConfig } from "vitest/config";

// Integration run (Testcontainers / Temporal). Only *.int.test.ts files.
export default defineConfig({
  test: {
    globalSetup: ["./packages/config/docker-preflight.ts"],
    include: ["**/*.int.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
