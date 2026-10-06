import { err, ok, type Result } from "../result.js";
import { MAX_EXTENSIONS } from "./rules.js";
import type { HoldStatus } from "./types.js";

export type HoldAction = "release" | "expire";

/** Only active -> released and active -> expired are allowed. */
export const canTransition = (status: HoldStatus, action: HoldAction): boolean =>
  status === "active" && (action === "release" || action === "expire");

export const checkExtension = (
  extensionsUsed: number,
): Result<{ readonly extensionsRemaining: number }, "extension_limit"> =>
  extensionsUsed >= MAX_EXTENSIONS
    ? err("extension_limit")
    : ok({ extensionsRemaining: MAX_EXTENSIONS - extensionsUsed - 1 });
