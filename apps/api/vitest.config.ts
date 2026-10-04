import { defineConfig, mergeConfig } from "vitest/config";
import base from "@boxoffice/config/vitest.base";

export default mergeConfig(base, defineConfig({}));
