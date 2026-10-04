import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HealthResponse } from "@boxoffice/contracts";

// Returns an un-readied instance so callers (tests) can register extra routes.
export function buildApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get("/health", { schema: { response: { 200: HealthResponse } } }, () => ({
    status: "ok" as const,
  }));

  return app;
}
