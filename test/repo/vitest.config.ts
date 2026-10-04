import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../packages/config/vitest.base.ts";

export default mergeConfig(base, defineConfig({}));
