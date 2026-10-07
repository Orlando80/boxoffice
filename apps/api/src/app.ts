import Fastify, { type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HealthResponse } from "@boxoffice/contracts";
import { holdRoutes, type HoldRepository } from "./routes/holds.js";
import { venueRoutes, type VenueRepository } from "./routes/venues.js";

export type { VenueRepository } from "./routes/venues.js";
export type { HoldRepository } from "./routes/holds.js";

/** Venue reads, plus the hold routes when `holds` is present. */
export type Repositories = VenueRepository & { holds?: HoldRepository };

export interface BuildAppOptions {
  /** Passed to Fastify as-is: `true`, pino options (with a `stream`) or a pino instance. */
  logger?: FastifyServerOptions["logger"];
}

// Returns an un-readied instance so callers (tests) can register extra routes.
// `repos` is optional so health-only tests need no repository; without it the
// venue routes are simply not registered.
export function buildApp(repos?: Repositories, opts: BuildAppOptions = {}) {
  const app = Fastify({ logger: opts.logger ?? false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get("/health", { schema: { response: { 200: HealthResponse } } }, () => ({
    status: "ok" as const,
  }));

  if (repos !== undefined) {
    const { holds, ...repo } = repos;
    void app.register(venueRoutes, { repo });
    if (holds !== undefined) void app.register(holdRoutes, { repo: holds });
  }

  return app;
}
