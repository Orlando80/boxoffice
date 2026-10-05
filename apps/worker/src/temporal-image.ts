// Single source of truth for the Temporal dev-server image (spec D3).
// Used by scripts/temporal-dev.mjs (`pnpm temporal:dev`) and by
// apps/worker/test/temporal-target.ts (Testcontainers fallback). Keep them in sync by
// changing the tag here only. Tag is the Temporal CLI version (1.9.1 = Server 1.32.0).
export const TEMPORAL_DEV_IMAGE = "temporalio/temporal:1.9.1";
