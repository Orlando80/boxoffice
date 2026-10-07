import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ErrorBody,
  EventDetail,
  EventSummary,
  LayoutView,
  VenueDetail,
  VenueSummary,
} from "@boxoffice/contracts";
import type * as queries from "@boxoffice/db";
import { errors, failed, installErrorHandler, makeGuard, NOT_FOUND } from "./common.js";

type Q = typeof queries;
type Rest<F> = F extends (db: never, ...args: infer A) => infer R ? (...args: A) => R : never;

/** The db query functions with the db already bound. */
export interface VenueRepository {
  listVenues: Rest<Q["listVenues"]>;
  getVenue: Rest<Q["getVenue"]>;
  listLayouts: Rest<Q["listLayouts"]>;
  listEvents: Rest<Q["listEvents"]>;
  getEvent: Rest<Q["getEvent"]>;
  getLayoutView: Rest<Q["getLayoutView"]>;
}

const VenueParams = z.object({ venueId: z.uuid() });
const EventParams = VenueParams.extend({ eventId: z.uuid() });
const LayoutParams = VenueParams.extend({ layoutId: z.uuid() });

const toEventSummary = (e: {
  id: string;
  slug: string;
  name: string;
  runningTimeMinutes: number | null;
  ageGuidance: string | null;
}) => ({
  id: e.id,
  slug: e.slug,
  name: e.name,
  runningTimeMinutes: e.runningTimeMinutes,
  ageGuidance: e.ageGuidance,
});

export const venueRoutes: FastifyPluginAsync<{ repo: VenueRepository }> = async (
  instance,
  opts,
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const { repo } = opts;

  installErrorHandler(app);
  const guard = makeGuard(app);

  app.get(
    "/venues",
    { schema: { response: { 200: z.array(VenueSummary), 503: ErrorBody } } },
    async (_req, reply) => {
      const rows = await guard(reply, async () =>
        (await repo.listVenues()).map((v) => ({ id: v.id, name: v.name, slug: v.slug, timeZone: v.timeZone })),
      );
      return rows;
    },
  );

  app.get(
    "/venues/:venueId",
    { schema: { params: VenueParams, response: { 200: VenueDetail, ...errors } } },
    async (req, reply) => {
      const { venueId } = req.params;
      const res = await guard(reply, async () => {
        const v = await repo.getVenue(venueId);
        if (v === null) return null;
        const [layouts, events] = await Promise.all([
          repo.listLayouts(venueId),
          repo.listEvents(venueId),
        ]);
        return {
          venue: { id: v.id, name: v.name, slug: v.slug, timeZone: v.timeZone },
          layouts: layouts.map((l) => ({ id: l.id, name: l.name })),
          events: events.map(toEventSummary),
        };
      });
      if (failed(res)) return res;
      if (res === null) return reply.code(404).send(NOT_FOUND);
      return res;
    },
  );

  app.get(
    "/venues/:venueId/events",
    { schema: { params: VenueParams, response: { 200: z.array(EventSummary), ...errors } } },
    async (req, reply) => {
      const { venueId } = req.params;
      const res = await guard(reply, async () => {
        if ((await repo.getVenue(venueId)) === null) return null;
        return (await repo.listEvents(venueId)).map(toEventSummary);
      });
      if (failed(res)) return res;
      if (res === null) return reply.code(404).send(NOT_FOUND);
      return res;
    },
  );

  app.get(
    "/venues/:venueId/events/:eventId",
    { schema: { params: EventParams, response: { 200: EventDetail, ...errors } } },
    async (req, reply) => {
      const { venueId, eventId } = req.params;
      const res = await guard(reply, async () => {
        const e = await repo.getEvent(venueId, eventId);
        if (e === null) return null;
        return {
          ...toEventSummary(e),
          description: e.description,
          performances: e.performances.map((p) => ({
            id: p.id,
            startsAt: p.startsAt.toISOString(),
            layoutId: p.layoutId,
            accessTags: p.accessTags,
          })),
        };
      });
      if (failed(res)) return res;
      if (res === null) return reply.code(404).send(NOT_FOUND);
      return res;
    },
  );

  app.get(
    "/venues/:venueId/layouts/:layoutId",
    { schema: { params: LayoutParams, response: { 200: LayoutView, ...errors } } },
    async (req, reply) => {
      const { venueId, layoutId } = req.params;
      const res = await guard(reply, () => repo.getLayoutView(venueId, layoutId));
      if (failed(res)) return res;
      if (res === null) return reply.code(404).send(NOT_FOUND);
      return res;
    },
  );
};
