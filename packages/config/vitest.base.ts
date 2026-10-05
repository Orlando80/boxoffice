import { configDefaults, defineConfig } from "vitest/config";

// Shared by every project. Unit runs never pick up *.int.test.ts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.int.test.ts"],
    passWithNoTests: true,
  },
});
