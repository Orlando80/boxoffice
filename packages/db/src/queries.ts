import type { AccessFeature, PerformanceAccessTag, SectionKind } from "@boxoffice/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  companionLink,
  event,
  layout,
  performance,
  seat,
  seatAccessFeature,
  section,
  venue,
} from "./schema.js";

/*
 * Convention: `db` is the first parameter and `venueId` the second, required
 * parameter of every query except `listVenues`. Venue scoping is applied in
 * SQL (WHERE venue_id = ...), never by filtering results afterwards. A row
 * that belongs to another venue returns null, same as a missing row.
 */

export interface VenueRow {
  id: string;
  name: string;
  slug: string;
  timeZone: string;
}

export interface EventRow {
  id: string;
  venueId: string;
  name: string;
  slug: string;
  description: string | null;
  runningTimeMinutes: number | null;
  ageGuidance: string | null;
}

export interface PerformanceRow {
  id: string;
  startsAt: Date;
  layoutId: string;
  accessTags: PerformanceAccessTag[];
}

export interface EventDetailRow extends EventRow {
  performances: PerformanceRow[];
}

export interface SeatView {
  id: string;
  rowLabel: string;
  seatLabel: string;
  x: number;
  y: number;
  accessFeatures: AccessFeature[];
  /** Id of the access seat this seat is the companion for, else null. */
  companionOf: string | null;
}

export interface RowView {
  label: string;
  seats: SeatView[];
}

export interface SectionView {
  id: string;
  name: string;
  kind: SectionKind;
  gaCapacity: number | null;
  rows: RowView[];
}

export interface LayoutView {
  id: string;
  venueId: string;
  name: string;
  sections: SectionView[];
}

const venueColumns = {
  id: venue.id,
  name: venue.name,
  slug: venue.slug,
  timeZone: venue.timeZone,
};

/**
 * DEV-ONLY venue picker until sign-in exists (spec F-5, plan P6). This is the
 * only unscoped read; the auth intent must remove or gate it.
 */
export async function listVenues(db: Db): Promise<VenueRow[]> {
  return db.select(venueColumns).from(venue).orderBy(asc(venue.name));
}

export async function getVenue(db: Db, venueId: string): Promise<VenueRow | null> {
  const rows = await db.select(venueColumns).from(venue).where(eq(venue.id, venueId));
  return rows[0] ?? null;
}

const eventColumns = {
  id: event.id,
  venueId: event.venueId,
  name: event.name,
  slug: event.slug,
  description: event.description,
  runningTimeMinutes: event.runningTimeMinutes,
  ageGuidance: event.ageGuidance,
};

export async function listEvents(db: Db, venueId: string): Promise<EventRow[]> {
  return db
    .select(eventColumns)
    .from(event)
    .where(eq(event.venueId, venueId))
    .orderBy(asc(event.name));
}

export async function getEvent(
  db: Db,
  venueId: string,
  eventId: string,
): Promise<EventDetailRow | null> {
  const events = await db
    .select(eventColumns)
    .from(event)
    .where(and(eq(event.venueId, venueId), eq(event.id, eventId)));
  const found = events[0];
  if (found === undefined) return null;
  const performances = await db
    .select({
      id: performance.id,
      startsAt: performance.startsAt,
      layoutId: performance.layoutId,
      accessTags: performance.accessTags,
    })
    .from(performance)
    .where(and(eq(performance.venueId, venueId), eq(performance.eventId, eventId)))
    .orderBy(asc(performance.startsAt));
  return { ...found, performances: performances as PerformanceRow[] };
}

/** At most five queries regardless of seat count. */
export async function getLayoutView(
  db: Db,
  venueId: string,
  layoutId: string,
): Promise<LayoutView | null> {
  const layouts = await db
    .select({ id: layout.id, venueId: layout.venueId, name: layout.name })
    .from(layout)
    .where(and(eq(layout.venueId, venueId), eq(layout.id, layoutId)));
  const found = layouts[0];
  if (found === undefined) return null;

  const sections = await db
    .select({
      id: section.id,
      name: section.name,
      kind: section.kind,
      gaCapacity: section.gaCapacity,
    })
    .from(section)
    .where(and(eq(section.venueId, venueId), eq(section.layoutId, layoutId)))
    .orderBy(asc(section.name));

  const sectionIds = sections.map((s) => s.id);
  const seats =
    sectionIds.length === 0
      ? []
      : await db
          .select({
            id: seat.id,
            sectionId: seat.sectionId,
            rowLabel: seat.rowLabel,
            seatLabel: seat.seatLabel,
            x: seat.x,
            y: seat.y,
          })
          .from(seat)
          .where(and(eq(seat.venueId, venueId), inArray(seat.sectionId, sectionIds)))
          .orderBy(asc(seat.y), asc(seat.x));

  const features = new Map<string, AccessFeature[]>();
  const companionOf = new Map<string, string>();
  if (seats.length > 0) {
    const featureRows = await db
      .select({ seatId: seatAccessFeature.seatId, feature: seatAccessFeature.feature })
      .from(seatAccessFeature)
      .innerJoin(
        seat,
        and(eq(seat.venueId, seatAccessFeature.venueId), eq(seat.id, seatAccessFeature.seatId)),
      )
      .innerJoin(section, and(eq(section.venueId, seat.venueId), eq(section.id, seat.sectionId)))
      .where(and(eq(seatAccessFeature.venueId, venueId), eq(section.layoutId, layoutId)))
      .orderBy(asc(seatAccessFeature.feature));
    for (const f of featureRows) {
      const list = features.get(f.seatId) ?? [];
      list.push(f.feature);
      features.set(f.seatId, list);
    }
    const linkRows = await db
      .select({
        accessSeatId: companionLink.accessSeatId,
        companionSeatId: companionLink.companionSeatId,
      })
      .from(companionLink)
      .innerJoin(
        seat,
        and(eq(seat.venueId, companionLink.venueId), eq(seat.id, companionLink.accessSeatId)),
      )
      .innerJoin(section, and(eq(section.venueId, seat.venueId), eq(section.id, seat.sectionId)))
      .where(and(eq(companionLink.venueId, venueId), eq(section.layoutId, layoutId)));
    for (const l of linkRows) companionOf.set(l.companionSeatId, l.accessSeatId);
  }

  const bySection = new Map<string, Map<string, SeatView[]>>();
  for (const s of seats) {
    let rows = bySection.get(s.sectionId);
    if (rows === undefined) bySection.set(s.sectionId, (rows = new Map()));
    let list = rows.get(s.rowLabel);
    if (list === undefined) rows.set(s.rowLabel, (list = []));
    list.push({
      id: s.id,
      rowLabel: s.rowLabel,
      seatLabel: s.seatLabel,
      x: s.x,
      y: s.y,
      accessFeatures: features.get(s.id) ?? [],
      companionOf: companionOf.get(s.id) ?? null,
    });
  }

  return {
    id: found.id,
    venueId: found.venueId,
    name: found.name,
    sections: sections.map((s) => ({
      ...s,
      rows: [...(bySection.get(s.id) ?? new Map<string, SeatView[]>())].map(
        ([label, rowSeats]) => ({ label, seats: rowSeats }),
      ),
    })),
  };
}
