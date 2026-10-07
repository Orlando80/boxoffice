import {
  ACCESS_NEED_CATEGORIES,
  HOLD_STATUSES,
  HOLD_VIOLATION_RULES,
  MAX_EXTENSIONS,
  PERFORMANCE_ACCESS_TAGS,
  SEAT_ROLES,
} from "@boxoffice/domain";
import { z } from "zod";

const SeatRole = z.enum(SEAT_ROLES);
const AccessNeed = z.enum(ACCESS_NEED_CATEGORIES);
const HoldStatus = z.enum(HOLD_STATUSES);
const HoldViolationRule = z.enum(HOLD_VIOLATION_RULES);
const PerformanceAccessTag = z.enum(
  PERFORMANCE_ACCESS_TAGS as unknown as [string, ...string[]],
) as unknown as z.ZodEnum<{
  relaxed: "relaxed";
  captioned: "captioned";
  bsl_interpreted: "bsl_interpreted";
  audio_described: "audio_described";
}>;

const Extensions = z.number().int().min(0).max(MAX_EXTENSIONS);

export const CreateHoldRequest = z
  .object({
    seats: z
      .array(
        z
          .object({ seatId: z.uuid(), role: SeatRole, accessNeed: AccessNeed.optional() })
          .strict(),
      )
      .default([]),
    ga: z
      .array(z.object({ sectionId: z.uuid(), quantity: z.number().int().min(1) }).strict())
      .default([]),
  })
  .strict();

export type CreateHoldRequest = z.input<typeof CreateHoldRequest>;

export const HoldCreated = z
  .object({
    holdId: z.uuid(),
    token: z.string(),
    expiresAt: z.iso.datetime(),
    extensionsRemaining: Extensions,
  })
  .strict();

export type HoldCreated = z.infer<typeof HoldCreated>;

export const HoldView = z
  .object({
    holdId: z.uuid(),
    performanceId: z.uuid(),
    status: HoldStatus,
    expiresAt: z.iso.datetime(),
    extensionsRemaining: Extensions,
    seats: z.array(z.object({ seatId: z.uuid(), role: SeatRole }).strict()),
    ga: z.array(z.object({ sectionId: z.uuid(), quantity: z.number().int().min(1) }).strict()),
  })
  .strict();

export type HoldView = z.infer<typeof HoldView>;

export const PerformanceDetail = z
  .object({
    id: z.uuid(),
    venueId: z.uuid(),
    eventId: z.uuid(),
    eventName: z.string(),
    startsAt: z.iso.datetime(),
    layoutId: z.uuid(),
    accessTags: z.array(PerformanceAccessTag),
  })
  .strict();

export type PerformanceDetail = z.infer<typeof PerformanceDetail>;

export const PerformanceAvailability = z
  .object({
    performanceId: z.uuid(),
    asOf: z.iso.datetime(),
    heldSeatIds: z.array(z.uuid()),
    ga: z.array(
      z
        .object({
          sectionId: z.uuid(),
          held: z.number().int().min(0),
          capacity: z.number().int().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type PerformanceAvailability = z.infer<typeof PerformanceAvailability>;

export const SeatsUnavailableBody = z
  .object({
    error: z.literal("seats_unavailable"),
    seatIds: z.array(z.uuid()),
    sectionIds: z.array(z.uuid()),
  })
  .strict();

export type SeatsUnavailableBody = z.infer<typeof SeatsUnavailableBody>;

export const InvalidHoldBody = z
  .object({ error: z.literal("invalid_hold"), rule: HoldViolationRule })
  .strict();

export type InvalidHoldBody = z.infer<typeof InvalidHoldBody>;
