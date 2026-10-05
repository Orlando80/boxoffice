import { createHash } from "node:crypto";
import type {
  AccessFeature,
  Event,
  Layout,
  Performance,
  PerformanceAccessTag,
  Seat,
  Section,
  Venue,
  VenueGraph,
} from "@boxoffice/domain";

/*
 * Invented seed data (plan P1): every venue name ends in " (Example)"; there
 * are no people, emails, phones or real addresses. Ids are UUIDv5 values
 * derived from stable natural keys, so a rerun produces identical rows.
 */

const NAMESPACE = "6f1d3c52-8a0e-4b7a-9d41-2c5e7b9a1f30";

/** RFC 4122 version-5 UUID of `name` in the seed namespace. */
export function seedId(...key: string[]): string {
  const ns = Buffer.from(NAMESPACE.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(ns).update(key.join("\u0000")).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** A..Z, then AA..AZ, BA.. */
const alphaRow = (i: number): string =>
  i < 26 ? letters.charAt(i) : `${letters.charAt(Math.floor(i / 26) - 1)}${letters.charAt(i % 26)}`;

interface AccessSpec {
  /** Zero-based row index. */
  readonly row: number;
  /** One-based seat number of the access seat. */
  readonly col: number;
  readonly features: readonly AccessFeature[];
  /** Companion is the seat at col + 1 (or col - 1 when `companionBefore`). */
  readonly companionBefore?: boolean;
}

interface ReservedSpec {
  readonly name: string;
  readonly rows: number;
  readonly cols: number;
  /** Layout-unit origin of the section (one unit per seat pitch). */
  readonly ox: number;
  readonly oy: number;
  readonly rowLabel?: (i: number) => string;
  readonly access: readonly AccessSpec[];
}

function reservedSection(venueSlug: string, layoutName: string, spec: ReservedSpec): Section {
  const label = spec.rowLabel ?? alphaRow;
  const sectionKey = [venueSlug, layoutName, spec.name] as const;
  const id = (row: string, seat: number): string => seatId(...sectionKey, row, String(seat));

  const features = new Map<string, readonly AccessFeature[]>();
  const companionOf = new Map<string, string>();
  for (const a of spec.access) {
    const row = label(a.row);
    const accessId = id(row, a.col);
    features.set(accessId, a.features);
    companionOf.set(id(row, a.companionBefore === true ? a.col - 1 : a.col + 1), accessId);
  }

  const seats: Seat[] = [];
  for (let r = 0; r < spec.rows; r++) {
    const rowLabel = label(r);
    for (let c = 1; c <= spec.cols; c++) {
      const sid = id(rowLabel, c);
      seats.push({
        id: sid,
        rowLabel,
        seatLabel: String(c),
        x: spec.ox + c - 1,
        y: spec.oy + r,
        accessFeatures: features.get(sid) ?? [],
        companionOf: companionOf.get(sid) ?? null,
      });
    }
  }
  return {
    id: sectionId(...sectionKey),
    name: spec.name,
    kind: "reserved",
    gaCapacity: null,
    seats,
  };
}

const seatId = (...k: string[]): string => seedId("seat", ...k);
const sectionId = (...k: string[]): string => seedId("section", ...k);

function gaSection(
  venueSlug: string,
  layoutName: string,
  name: string,
  gaCapacity: number,
): Section {
  return {
    id: sectionId(venueSlug, layoutName, name),
    name,
    kind: "ga",
    gaCapacity,
    seats: [],
  };
}

function makeLayout(venue: Venue, name: string, sections: Section[]): Layout {
  return { id: seedId("layout", venue.slug, name), venueId: venue.id, name, sections };
}

interface PerfSpec {
  readonly startsAt: string;
  readonly layout: Layout;
  readonly accessTags?: readonly PerformanceAccessTag[];
}

function makeEvent(
  venue: Venue,
  e: {
    slug: string;
    name: string;
    description: string;
    runningTimeMinutes: number;
    ageGuidance: string;
    performances: readonly PerfSpec[];
  },
): Event {
  const performances: Performance[] = e.performances.map((p) => ({
    id: seedId("performance", venue.slug, e.slug, new Date(p.startsAt).toISOString()),
    startsAt: new Date(p.startsAt),
    layoutId: p.layout.id,
    accessTags: p.accessTags ?? [],
  }));
  return {
    id: seedId("event", venue.slug, e.slug),
    venueId: venue.id,
    name: e.name,
    slug: e.slug,
    description: e.description,
    runningTimeMinutes: e.runningTimeMinutes,
    ageGuidance: e.ageGuidance,
    performances,
  };
}

const makeVenue = (slug: string, name: string): Venue => ({
  id: seedId("venue", slug),
  name,
  slug,
  timeZone: "Europe/London",
});

export function buildSeed(): VenueGraph {
  // Studio: ~300 capacity, GA standing plus a small reserved block (100 seats + 200 standing).
  const studio = makeVenue("riverside-studio", "Riverside Studio (Example)");
  const studioStanding = makeLayout(studio, "Standing and stalls", [
    reservedSection(studio.slug, "Standing and stalls", {
      name: "Stalls",
      rows: 10,
      cols: 10,
      ox: 0,
      oy: 0,
      access: [
        { row: 9, col: 1, features: ["wheelchair_space", "near_exit"] },
        { row: 9, col: 10, features: ["transfer_seat", "aisle"], companionBefore: true },
        { row: 0, col: 5, features: ["hearing_loop"] },
      ],
    }),
    gaSection(studio.slug, "Standing and stalls", "Standing", 200),
  ]);
  const studioAllStanding = makeLayout(studio, "All standing", [
    gaSection(studio.slug, "All standing", "Standing", 300),
  ]);

  // Theatre: 1,200 seats (stalls 600, circle 480, boxes 120).
  const theatre = makeVenue("harbour-lane-theatre", "Harbour Lane Theatre (Example)");
  const theatreEnd = makeLayout(theatre, "End-on", [
    reservedSection(theatre.slug, "End-on", {
      name: "Stalls",
      rows: 20,
      cols: 30,
      ox: 0,
      oy: 10,
      access: [
        { row: 19, col: 3, features: ["wheelchair_space", "step_free"] },
        { row: 19, col: 28, features: ["wheelchair_space", "step_free"], companionBefore: true },
        { row: 0, col: 1, features: ["aisle", "extra_legroom"] },
        { row: 5, col: 30, features: ["transfer_seat", "aisle"], companionBefore: true },
        { row: 10, col: 15, features: ["hearing_loop"] },
        { row: 19, col: 15, features: ["near_exit", "step_free"] },
      ],
    }),
    reservedSection(theatre.slug, "End-on", {
      name: "Circle",
      rows: 16,
      cols: 30,
      ox: 0,
      oy: 34,
      access: [
        { row: 0, col: 2, features: ["transfer_seat", "extra_legroom"] },
        { row: 0, col: 29, features: ["aisle", "near_exit"], companionBefore: true },
        { row: 8, col: 15, features: ["hearing_loop"] },
      ],
    }),
    reservedSection(theatre.slug, "End-on", {
      name: "Boxes",
      rows: 12,
      cols: 10,
      ox: 34,
      oy: 10,
      rowLabel: (i) => `Box ${i + 1}`,
      access: [
        { row: 0, col: 1, features: ["wheelchair_space"] },
        { row: 6, col: 10, features: ["step_free", "wheelchair_space"], companionBefore: true },
      ],
    }),
  ]);

  // Arena: 5,000 reserved seats plus a 500 GA floor.
  const arena = makeVenue("northgate-arena", "Northgate Arena (Example)");
  const arenaConcert = makeLayout(arena, "Concert", [
    gaSection(arena.slug, "Concert", "Floor", 500),
    reservedSection(arena.slug, "Concert", {
      name: "Lower Bowl",
      rows: 40,
      cols: 85,
      ox: 0,
      oy: 4,
      access: [
        { row: 0, col: 10, features: ["wheelchair_space", "step_free"] },
        { row: 0, col: 66, features: ["wheelchair_space", "step_free"], companionBefore: true },
        { row: 12, col: 1, features: ["aisle", "near_exit"] },
        { row: 12, col: 75, features: ["aisle", "transfer_seat"], companionBefore: true },
        { row: 20, col: 38, features: ["hearing_loop"] },
        { row: 39, col: 38, features: ["extra_legroom"] },
      ],
    }),
    reservedSection(arena.slug, "Concert", {
      name: "Upper Tier",
      rows: 25,
      cols: 64,
      ox: 8,
      oy: 48,
      access: [
        { row: 0, col: 5, features: ["wheelchair_space", "near_exit"] },
        { row: 0, col: 55, features: ["wheelchair_space", "near_exit"], companionBefore: true },
        { row: 24, col: 30, features: ["aisle", "step_free"] },
      ],
    }),
  ]);

  const venues = [studio, theatre, arena];
  const layouts = [studioStanding, studioAllStanding, theatreEnd, arenaConcert];

  const events: Event[] = [
    makeEvent(studio, {
      slug: "late-night-comedy",
      name: "Late Night Comedy Club",
      description: "An evening of stand-up from a rotating line-up of invented comedians.",
      runningTimeMinutes: 120,
      ageGuidance: "16+",
      performances: [
        { startsAt: "2026-10-23T19:30:00Z", layout: studioStanding },
        { startsAt: "2026-10-24T18:30:00Z", layout: studioStanding },
        { startsAt: "2026-10-25T19:30:00Z", layout: studioAllStanding, accessTags: ["captioned"] },
      ],
    }),
    makeEvent(studio, {
      slug: "open-mic-night",
      name: "Open Mic Night",
      description: "Short sets from local performers, standing room only.",
      runningTimeMinutes: 150,
      ageGuidance: "All ages",
      performances: [{ startsAt: "2026-11-05T19:00:00Z", layout: studioAllStanding }],
    }),
    makeEvent(theatre, {
      slug: "the-lantern-keeper",
      name: "The Lantern Keeper",
      description: "A new play about a lighthouse and the stories it keeps.",
      runningTimeMinutes: 135,
      ageGuidance: "12+",
      performances: [
        { startsAt: "2026-10-24T18:30:00Z", layout: theatreEnd },
        {
          startsAt: "2026-10-25T14:00:00Z",
          layout: theatreEnd,
          accessTags: ["relaxed", "audio_described"],
        },
        {
          startsAt: "2026-10-25T19:30:00Z",
          layout: theatreEnd,
          accessTags: ["captioned", "bsl_interpreted"],
        },
      ],
    }),
    makeEvent(theatre, {
      slug: "winter-ballet-gala",
      name: "Winter Ballet Gala",
      description: "A seasonal programme of short ballets with a live chamber ensemble.",
      runningTimeMinutes: 150,
      ageGuidance: "All ages",
      performances: [
        { startsAt: "2026-12-12T19:30:00Z", layout: theatreEnd },
        { startsAt: "2026-12-13T14:30:00Z", layout: theatreEnd, accessTags: ["relaxed"] },
      ],
    }),
    makeEvent(arena, {
      slug: "midnight-circuit-live",
      name: "Midnight Circuit Live",
      description: "An electronic music show with a full light rig.",
      runningTimeMinutes: 180,
      ageGuidance: "14+ (under 16s accompanied)",
      performances: [
        { startsAt: "2026-10-24T19:00:00Z", layout: arenaConcert },
        { startsAt: "2026-10-25T19:00:00Z", layout: arenaConcert, accessTags: ["captioned"] },
      ],
    }),
    makeEvent(arena, {
      slug: "city-skyline-games",
      name: "City Skyline Indoor Games",
      description: "An indoor athletics meeting with reserved seating and a standing floor.",
      runningTimeMinutes: 210,
      ageGuidance: "All ages",
      performances: [{ startsAt: "2027-03-28T13:00:00Z", layout: arenaConcert }],
    }),
  ];

  return { venues, layouts, events };
}
