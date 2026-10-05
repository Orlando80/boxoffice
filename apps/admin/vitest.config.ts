import { defineConfig, mergeConfig } from "vitest/config";
import base from "@boxoffice/config/vitest.next";

export default mergeConfig(base, defineConfig({}));
