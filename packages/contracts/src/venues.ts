import { ACCESS_FEATURES, PERFORMANCE_ACCESS_TAGS } from "@boxoffice/domain";
import { z } from "zod";

const AccessFeature = z.enum(ACCESS_FEATURES);
const PerformanceAccessTag = z.enum(
  PERFORMANCE_ACCESS_TAGS as unknown as [string, ...string[]],
) as unknown as z.ZodEnum<{
  relaxed: "relaxed";
  captioned: "captioned";
  bsl_interpreted: "bsl_interpreted";
  audio_described: "audio_described";
}>;

export const VenueSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    timeZone: z.string(),
  })
  .strict();

export type VenueSummary = z.infer<typeof VenueSummary>;

export const LayoutSummary = z.object({ id: z.uuid(), name: z.string() }).strict();

export type LayoutSummary = z.infer<typeof LayoutSummary>;

/** No performance count: listEvents does not return one. Detail has the performances. */
export const EventSummary = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    runningTimeMinutes: z.number().int().nullable(),
    ageGuidance: z.string().nullable(),
  })
  .strict();

export type EventSummary = z.infer<typeof EventSummary>;

export const VenueDetail = z
  .object({
    venue: VenueSummary,
    layouts: z.array(LayoutSummary),
    events: z.array(EventSummary),
  })
  .strict();

export type VenueDetail = z.infer<typeof VenueDetail>;

export const PerformanceSummary = z
  .object({
    id: z.uuid(),
    /** ISO 8601 UTC instant, e.g. 2030-01-01T19:30:00.000Z. */
    startsAt: z.iso.datetime(),
    layoutId: z.uuid(),
    accessTags: z.array(PerformanceAccessTag),
  })
  .strict();

export type PerformanceSummary = z.infer<typeof PerformanceSummary>;

export const EventDetail = EventSummary.extend({
  description: z.string().nullable(),
  performances: z.array(PerformanceSummary),
}).strict();

export type EventDetail = z.infer<typeof EventDetail>;

export const SeatView = z
  .object({
    id: z.uuid(),
    rowLabel: z.string(),
    seatLabel: z.string(),
    x: z.number().int(),
    y: z.number().int(),
    accessFeatures: z.array(AccessFeature),
    companionOf: z.uuid().nullable(),
  })
  .strict();

export type SeatView = z.infer<typeof SeatView>;

export const RowView = z.object({ label: z.string(), seats: z.array(SeatView) }).strict();

export type RowView = z.infer<typeof RowView>;

export const SectionView = z
  .object({
    id: z.uuid(),
    name: z.string(),
    kind: z.enum(["reserved", "ga"]),
    gaCapacity: z.number().int().min(1).nullable(),
    rows: z.array(RowView),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.kind === "ga" && s.gaCapacity === null) {
      ctx.addIssue({ code: "custom", path: ["gaCapacity"], message: "ga section needs gaCapacity" });
    }
    if (s.kind === "reserved" && s.gaCapacity !== null) {
      ctx.addIssue({ code: "custom", path: ["gaCapacity"], message: "reserved section must have null gaCapacity" });
    }
  });

export type SectionView = z.infer<typeof SectionView>;

export const LayoutView = z
  .object({
    id: z.uuid(),
    venueId: z.uuid(),
    name: z.string(),
    sections: z.array(SectionView),
  })
  .strict()
  .superRefine((view, ctx) => {
    const ids = new Set<string>();
    for (const sec of view.sections)
      for (const row of sec.rows) for (const seat of row.seats) ids.add(seat.id);
    view.sections.forEach((sec, si) =>
      sec.rows.forEach((row, ri) =>
        row.seats.forEach((seat, ki) => {
          if (seat.companionOf !== null && !ids.has(seat.companionOf)) {
            ctx.addIssue({
              code: "custom",
              path: ["sections", si, "rows", ri, "seats", ki, "companionOf"],
              message: "companionOf must refer to a seat in the same layout",
            });
          }
        }),
      ),
    );
  });

export type LayoutView = z.infer<typeof LayoutView>;

export const ErrorBody = z
  .object({ error: z.enum(["not_found", "bad_request", "unavailable", "extension_limit", "hold_ended"]) })
  .strict();

export type ErrorBody = z.infer<typeof ErrorBody>;
