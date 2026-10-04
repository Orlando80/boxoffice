import { defineConfig } from "vitest/config";

// Unit run across the workspace. Each project extends packages/config/vitest.base.ts,
// which excludes *.int.test.ts.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ["apps/*", "packages/*", "test/repo"],
  },
});
