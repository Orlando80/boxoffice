import { err, ok, type Result } from "../result.js";
import { ACCESS_FEATURES } from "../venues/access-features.js";
import type { HoldFacts, HoldRequest, ValidatedHold } from "./types.js";

export const HOLD_LENGTH_SECONDS = 600;
export const MAX_EXTENSIONS = 10;
export const MAX_PLACES = 10;

/** H-5: need categories reuse the access-feature list. */
export const ACCESS_NEED_CATEGORIES = ACCESS_FEATURES;

export const HOLD_VIOLATION_RULES = [
  "seat_outside_layout",
  "ga_section_outside_layout",
  "ga_line_on_reserved_section",
  "seat_in_ga_section",
  "duplicate_seat",
  "duplicate_ga_section",
  "access_role_on_standard_seat",
  "ga_quantity_invalid",
  "place_count_out_of_range",
  "performance_started",
  "access_seat_wrong_role",
  "access_need_missing",
  "access_need_invalid",
  "companion_wrong_role",
  "companion_not_linked",
  "companion_without_access_seat",
  "companion_duplicate_for_access_seat",
] as const;

export type HoldViolationRule = (typeof HOLD_VIOLATION_RULES)[number];

export interface HoldViolation {
  readonly rule: HoldViolationRule;
  /** "seat:<id>", "section:<id>", "performance" or "hold". */
  readonly item: string;
  readonly message: string;
}

const v = (rule: HoldViolationRule, item: string, message: string): HoldViolation => ({
  rule,
  item,
  message,
});

const isNeed = (value: string): boolean =>
  (ACCESS_NEED_CATEGORIES as readonly string[]).includes(value);

export const validateHoldRequest = (
  request: HoldRequest,
  facts: HoldFacts,
  now: Date,
): Result<ValidatedHold, HoldViolation[]> => {
  const out: HoldViolation[] = [];

  if (facts.performanceStartsAt.getTime() <= now.getTime()) {
    out.push(v("performance_started", "performance", "The performance has already started"));
  }

  const seenSeats = new Set<string>();
  const holdRoles = new Map<string, string>();
  for (const line of request.seats) holdRoles.set(line.seatId, line.role);
  const companionsFor = new Map<string, number>();

  for (const line of request.seats) {
    const item = `seat:${line.seatId}`;
    if (seenSeats.has(line.seatId)) {
      out.push(v("duplicate_seat", item, "Seat appears more than once"));
      continue;
    }
    seenSeats.add(line.seatId);

    const fact = facts.seats.get(line.seatId);
    if (!fact || fact.layoutId !== facts.performanceLayoutId) {
      out.push(v("seat_outside_layout", item, "Seat is not in the performance layout"));
      continue;
    }
    if (fact.sectionKind === "ga") {
      out.push(v("seat_in_ga_section", item, "Seat is in a general-admission section"));
      continue;
    }

    if (
      fact.companionOf === null &&
      fact.accessFeatures.length === 0 &&
      (line.role === "access" || line.role === "companion")
    ) {
      out.push(v("access_role_on_standard_seat", item, "Seat is not an access or companion seat"));
      continue;
    }

    if (fact.companionOf !== null) {
      if (line.role !== "companion") {
        out.push(v("companion_wrong_role", item, "A companion seat can only be held as companion"));
      }
    } else if (fact.accessFeatures.length > 0 && line.role !== "access") {
      out.push(v("access_seat_wrong_role", item, "An access seat can only be held as access"));
    }

    if (line.role === "access") {
      if (line.accessNeed === undefined || line.accessNeed === "") {
        out.push(v("access_need_missing", item, "An access-need category is required"));
      } else if (!isNeed(line.accessNeed)) {
        out.push(v("access_need_invalid", item, "Access-need category is not in the list"));
      }
    }

    if (line.role === "companion") {
      if (fact.companionOf === null) {
        out.push(v("companion_not_linked", item, "Seat is not a companion for any access seat"));
      } else {
        if (holdRoles.get(fact.companionOf) !== "access") {
          out.push(
            v("companion_without_access_seat", item, "Linked access seat is not in the same hold"),
          );
        }
        const n = (companionsFor.get(fact.companionOf) ?? 0) + 1;
        companionsFor.set(fact.companionOf, n);
        if (n === 2) {
          out.push(
            v("companion_duplicate_for_access_seat", item, "Only one companion per access seat"),
          );
        }
      }
    }
  }

  let gaPlaces = 0;
  const seenSections = new Set<string>();
  for (const line of request.ga) {
    const item = `section:${line.sectionId}`;
    if (seenSections.has(line.sectionId)) {
      out.push(v("duplicate_ga_section", item, "Section appears more than once"));
      continue;
    }
    seenSections.add(line.sectionId);
    const fact = facts.sections.get(line.sectionId);
    if (!fact || fact.layoutId !== facts.performanceLayoutId) {
      out.push(v("ga_section_outside_layout", item, "Section is not in the performance layout"));
      continue;
    }
    if (fact.sectionKind !== "ga") {
      out.push(v("ga_line_on_reserved_section", item, "Section is not general admission"));
      continue;
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      out.push(v("ga_quantity_invalid", item, "Quantity must be an integer of at least 1"));
      continue;
    }
    gaPlaces += line.quantity;
  }

  const placeCount = request.seats.filter((s) => s.role !== "companion").length + gaPlaces;
  if (placeCount < 1 || placeCount > MAX_PLACES) {
    out.push(v("place_count_out_of_range", "hold", `A hold must have 1 to ${MAX_PLACES} places`));
  }

  if (out.length > 0) return err(out);
  return ok({ placeCount, seats: request.seats, ga: request.ga });
};
