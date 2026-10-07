import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CreateHoldRequest,
  ErrorBody,
  HoldCreated,
  HoldView,
  InvalidHoldBody,
  PerformanceAvailability,
  PerformanceDetail,
  SeatsUnavailableBody,
} from "@boxoffice/contracts";
import type * as queries from "@boxoffice/db";
import { errors, failed, installErrorHandler, makeGuard, NOT_FOUND } from "./common.js";

type Q = typeof queries;
type Rest<F> = F extends (db: never, ...args: infer A) => infer R ? (...args: A) => R : never;

/** Hold and performance queries with the db (and the hold length) already bound. */
export interface HoldRepository {
  getPerformance: Rest<Q["getPerformance"]>;
  getAvailability: Rest<Q["getAvailability"]>;
  /** Hold length is bound by the repository, not passed per call. */
  createHold: (
    venueId: string,
    performanceId: string,
    request: Parameters<Q["createHold"]>[3],
  ) => ReturnType<Q["createHold"]>;
  getHold: Rest<Q["getHold"]>;
  /** Extends by the same length createHold uses. */
  extendHold: (venueId: string, holdId: string, token: string) => ReturnType<Q["extendHold"]>;
  releaseHold: Rest<Q["releaseHold"]>;
}

const VenueParams = z.object({ venueId: z.uuid() });
const PerformanceParams = VenueParams.extend({ performanceId: z.uuid() });
const HoldParams = VenueParams.extend({ holdId: z.uuid() });

// 32 random bytes as base64url, no padding.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

type DbHoldView = NonNullable<Awaited<ReturnType<HoldRepository["getHold"]>>>;
const toHoldView = (h: DbHoldView) => ({ ...h, expiresAt: h.expiresAt.toISOString() });

export const holdRoutes: FastifyPluginAsync<{ repo: HoldRepository }> = async (instance, opts) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { repo } = opts;
  installErrorHandler(app);
  const guard = makeGuard(app);

  // Missing, malformed and wrong tokens all look like an unknown hold (never 400).
  const tokenOf = (header: unknown): string | null =>
    typeof header === "string" && TOKEN_FORMAT.test(header) ? header : null;
  const notFound = (reply: FastifyReply) => reply.code(404).send(NOT_FOUND);

  app.get(
    "/venues/:venueId/performances/:performanceId",
    { schema: { params: PerformanceParams, response: { 200: PerformanceDetail, ...errors } } },
    async (req, reply) => {
      const { venueId, performanceId } = req.params;
      const res = await guard(reply, async () => {
        const p = await repo.getPerformance(venueId, performanceId);
        return p === null ? null : { ...p, startsAt: p.startsAt.toISOString() };
      });
      if (failed(res)) return res;
      if (res === null) return notFound(reply);
      return res;
    },
  );

  app.get(
    "/venues/:venueId/performances/:performanceId/availability",
    {
      schema: { params: PerformanceParams, response: { 200: PerformanceAvailability, ...errors } },
    },
    async (req, reply) => {
      const { venueId, performanceId } = req.params;
      const res = await guard(reply, async () => {
        const a = await repo.getAvailability(venueId, performanceId);
        return a === null ? null : { ...a, asOf: a.asOf.toISOString() };
      });
      if (failed(res)) return res;
      if (res === null) return notFound(reply);
      return res;
    },
  );

  app.post(
    "/venues/:venueId/performances/:performanceId/holds",
    {
      schema: {
        params: PerformanceParams,
        body: CreateHoldRequest,
        response: {
          201: HoldCreated,
          ...errors,
          409: SeatsUnavailableBody,
          422: InvalidHoldBody,
        },
      },
    },
    async (req, reply) => {
      const { venueId, performanceId } = req.params;
      const res = await guard(reply, () => repo.createHold(venueId, performanceId, req.body));
      if (failed(res)) return res;
      if (res.ok) {
        const h = res.value;
        return reply.code(201).send({ ...h, expiresAt: h.expiresAt.toISOString() });
      }
      const f = res.error;
      if (f.code === "performance_not_found") return notFound(reply);
      if (f.code === "invalid_hold") {
        return reply.code(422).send({ error: "invalid_hold" as const, rule: f.rule });
      }
      return reply.code(409).send({
        error: "seats_unavailable" as const,
        seatIds: f.seatIds,
        sectionIds: f.sectionIds,
      });
    },
  );

  app.get(
    "/venues/:venueId/holds/:holdId",
    { schema: { params: HoldParams, response: { 200: HoldView, ...errors } } },
    async (req, reply) => {
      const token = tokenOf(req.headers["hold-token"]);
      if (token === null) return notFound(reply);
      const { venueId, holdId } = req.params;
      const res = await guard(reply, () => repo.getHold(venueId, holdId, token));
      if (failed(res)) return res;
      if (res === null) return notFound(reply);
      return toHoldView(res);
    },
  );

  app.post(
    "/venues/:venueId/holds/:holdId/extend",
    { schema: { params: HoldParams, response: { 200: HoldView, ...errors, 409: ErrorBody } } },
    async (req, reply) => {
      const token = tokenOf(req.headers["hold-token"]);
      if (token === null) return notFound(reply);
      const { venueId, holdId } = req.params;
      const res = await guard(reply, () => repo.extendHold(venueId, holdId, token));
      if (failed(res)) return res;
      if (res === null) return notFound(reply);
      if (!res.ok) return reply.code(409).send({ error: res.error });
      return toHoldView(res.value);
    },
  );

  app.delete(
    "/venues/:venueId/holds/:holdId",
    { schema: { params: HoldParams, response: { 200: HoldView, ...errors } } },
    async (req, reply) => {
      const token = tokenOf(req.headers["hold-token"]);
      if (token === null) return notFound(reply);
      const { venueId, holdId } = req.params;
      const res = await guard(reply, () => repo.releaseHold(venueId, holdId, token));
      if (failed(res)) return res;
      if (res === null) return notFound(reply);
      return toHoldView(res);
    },
  );
};
