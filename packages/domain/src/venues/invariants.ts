import { err, ok, type Result } from "../result.js";
import { isAccessFeature } from "./access-features.js";
import type { Layout, Seat, VenueGraph } from "./types.js";

export type ViolationRule =
  | "duplicate_seat_id"
  | "duplicate_seat_label"
  | "seat_position_not_integer"
  | "ga_capacity_invalid"
  | "ga_capacity_on_reserved_section"
  | "seats_on_ga_section"
  | "access_feature_unknown"
  | "companion_unknown_seat"
  | "companion_cross_section"
  | "companion_cross_layout"
  | "companion_is_access_seat"
  | "companion_duplicate_for_access_seat"
  | "access_seat_without_feature"
  | "venue_time_zone_invalid"
  | "performance_layout_unknown"
  | "performance_layout_other_venue";

export interface Violation {
  readonly rule: ViolationRule;
  /** The offending item, as "kind:id" (e.g. "seat:<id>", "section:<id>", "performance:<id>"). */
  readonly item: string;
  readonly message: string;
}

const v = (rule: ViolationRule, item: string, message: string): Violation => ({
  rule,
  item,
  message,
});

const checkLayout = (
  layout: Layout,
  otherLayoutSeatIds: ReadonlyMap<string, string>,
): Violation[] => {
  const out: Violation[] = [];
  const seatSection = new Map<string, string>();
  const seatById = new Map<string, Seat>();

  for (const section of layout.sections) {
    const labels = new Set<string>();
    if (section.kind === "ga") {
      const c = section.gaCapacity;
      if (c === null || !Number.isInteger(c) || c < 1) {
        out.push(
          v(
            "ga_capacity_invalid",
            `section:${section.id}`,
            "GA capacity must be an integer of at least 1",
          ),
        );
      }
      if (section.seats.length > 0) {
        out.push(
          v("seats_on_ga_section", `section:${section.id}`, "GA sections cannot have seats"),
        );
      }
    } else if (section.gaCapacity !== null) {
      out.push(
        v(
          "ga_capacity_on_reserved_section",
          `section:${section.id}`,
          "Only GA sections have a capacity",
        ),
      );
    }

    for (const seat of section.seats) {
      if (seatById.has(seat.id)) {
        out.push(
          v("duplicate_seat_id", `seat:${seat.id}`, "Seat id appears more than once in the layout"),
        );
      }
      seatById.set(seat.id, seat);
      seatSection.set(seat.id, section.id);

      const label = JSON.stringify([seat.rowLabel, seat.seatLabel]);
      if (labels.has(label)) {
        out.push(
          v(
            "duplicate_seat_label",
            `seat:${seat.id}`,
            `Row ${seat.rowLabel} seat ${seat.seatLabel} is duplicated in section ${section.name}`,
          ),
        );
      }
      labels.add(label);

      if (!Number.isInteger(seat.x) || !Number.isInteger(seat.y)) {
        out.push(
          v("seat_position_not_integer", `seat:${seat.id}`, "Seat x and y must be integers"),
        );
      }
      for (const f of seat.accessFeatures) {
        if (!isAccessFeature(f)) {
          out.push(
            v(
              "access_feature_unknown",
              `seat:${seat.id}`,
              `Access feature "${f}" is not in the fixed list`,
            ),
          );
        }
      }
    }
  }

  const companionsByAccessSeat = new Map<string, string[]>();
  for (const section of layout.sections) {
    for (const seat of section.seats) {
      const target = seat.companionOf;
      if (target === null) continue;
      const item = `seat:${seat.id}`;
      if (target === seat.id) {
        out.push(v("companion_is_access_seat", item, "A seat cannot be its own companion"));
        continue;
      }
      const targetSection = seatSection.get(target);
      if (targetSection === undefined) {
        if (otherLayoutSeatIds.has(target)) {
          out.push(
            v("companion_cross_layout", item, "Companion link points to a seat in another layout"),
          );
        } else {
          out.push(
            v(
              "companion_unknown_seat",
              item,
              "Companion link points to a seat that does not exist",
            ),
          );
        }
        continue;
      }
      if (targetSection !== section.id) {
        out.push(
          v("companion_cross_section", item, "Companion link points to a seat in another section"),
        );
        continue;
      }
      const list = companionsByAccessSeat.get(target) ?? [];
      list.push(seat.id);
      companionsByAccessSeat.set(target, list);

      const accessSeat = seatById.get(target);
      if (accessSeat !== undefined) {
        if (accessSeat.companionOf !== null) {
          out.push(
            v(
              "companion_is_access_seat",
              item,
              "Companion link points to a seat that is itself a companion",
            ),
          );
        }
        if (accessSeat.accessFeatures.length === 0) {
          out.push(
            v(
              "access_seat_without_feature",
              `seat:${target}`,
              "A seat with a companion must have an access feature",
            ),
          );
        }
      }
    }
  }
  for (const [accessSeatId, companions] of companionsByAccessSeat) {
    if (companions.length > 1) {
      out.push(
        v(
          "companion_duplicate_for_access_seat",
          `seat:${accessSeatId}`,
          `Access seat has ${companions.length} companions; only one is allowed`,
        ),
      );
    }
  }
  return out;
};

const finish = (violations: Violation[]): Result<void, Violation[]> =>
  violations.length === 0 ? ok(undefined) : err(violations);

export const validateLayout = (layout: Layout): Result<void, Violation[]> =>
  finish(checkLayout(layout, new Map()));

const IANA_ZONES: ReadonlySet<string> = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);

const isValidZone = (zone: string): boolean => IANA_ZONES.has(zone);

export const validateVenueGraph = (graph: VenueGraph): Result<void, Violation[]> => {
  const out: Violation[] = [];

  for (const venue of graph.venues) {
    if (!isValidZone(venue.timeZone)) {
      out.push(
        v(
          "venue_time_zone_invalid",
          `venue:${venue.id}`,
          `"${venue.timeZone}" is not an IANA time zone`,
        ),
      );
    }
  }

  for (const layout of graph.layouts) {
    const others = new Map<string, string>();
    for (const l of graph.layouts) {
      if (l.id === layout.id) continue;
      for (const s of l.sections) for (const seat of s.seats) others.set(seat.id, l.id);
    }
    out.push(...checkLayout(layout, others));
  }

  const layoutById = new Map(graph.layouts.map((l) => [l.id, l] as const));
  for (const event of graph.events) {
    for (const p of event.performances) {
      const layout = layoutById.get(p.layoutId);
      if (layout === undefined) {
        out.push(
          v(
            "performance_layout_unknown",
            `performance:${p.id}`,
            "Performance references an unknown layout",
          ),
        );
      } else if (layout.venueId !== event.venueId) {
        out.push(
          v(
            "performance_layout_other_venue",
            `performance:${p.id}`,
            "Performance references a layout of another venue",
          ),
        );
      }
    }
  }
  return finish(out);
};
