import { defineConfig, mergeConfig } from "vitest/config";
import base from "@boxoffice/config/vitest.base";

// Next apps (web, admin, scanner): jsdom, and the automatic JSX runtime
// because tsconfig.next.json uses jsx: "preserve" (Vite 8 uses oxc, not esbuild).
export default mergeConfig(
  base,
  defineConfig({
    oxc: { jsx: { runtime: "automatic" } },
    test: { environment: "jsdom" },
  }),
);
