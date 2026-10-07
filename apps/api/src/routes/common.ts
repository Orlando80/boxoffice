import type { FastifyInstance, FastifyReply } from "fastify";
import { ErrorBody } from "@boxoffice/contracts";

export const NOT_FOUND = { error: "not_found" } as const;
export const BAD_REQUEST = { error: "bad_request" } as const;
export const UNAVAILABLE = { error: "unavailable" } as const;

export const errors = { 400: ErrorBody, 404: ErrorBody, 503: ErrorBody };

/** Replaces Fastify's default validation body with ErrorBody; anything else is a fixed 503. */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _req, reply) => {
    if ((error as { validation?: unknown }).validation !== undefined) {
      return reply.code(400).send(BAD_REQUEST);
    }
    // Client errors (bad JSON, empty body, unsupported media type, oversize): fixed 400, not an error log.
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && status >= 400 && status <= 499) {
      return reply.code(400).send(BAD_REQUEST);
    }
    // Anything else (mapping or serialization bug included): fixed body, no message text.
    app.log.error("request failed");
    return reply.code(503).send(UNAVAILABLE);
  });
}

/** Returns a runner: a repository call that throws becomes 503 with a short log line only. */
export function makeGuard(app: FastifyInstance) {
  return async function guard<T>(
    reply: FastifyReply,
    run: () => Promise<T>,
  ): Promise<T | typeof UNAVAILABLE> {
    try {
      return await run();
    } catch {
      app.log.error("repository call failed");
      void reply.code(503);
      return UNAVAILABLE;
    }
  };
}

export const failed = (r: unknown): r is typeof UNAVAILABLE => r === UNAVAILABLE;
