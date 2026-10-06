import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HealthResponse } from "@boxoffice/contracts";
import { venueRoutes, type VenueRepository } from "./routes/venues.js";

export type { VenueRepository } from "./routes/venues.js";

// Returns an un-readied instance so callers (tests) can register extra routes.
// `repo` is optional so health-only tests need no repository; without it the
// venue routes are simply not registered.
export function buildApp(repo?: VenueRepository) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get("/health", { schema: { response: { 200: HealthResponse } } }, () => ({
    status: "ok" as const,
  }));

  if (repo !== undefined) {
    void app.register(venueRoutes, { repo });
  }

  return app;
}
