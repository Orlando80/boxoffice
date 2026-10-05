import type { LayoutView } from "@boxoffice/contracts";

type SeatInput = LayoutView["sections"][number]["rows"][number]["seats"][number];
export type AccessFeatureName = SeatInput["accessFeatures"][number];

export const FEATURE_LABELS: Record<AccessFeatureName, string> = {
  wheelchair_space: "wheelchair space",
  transfer_seat: "transfer seat",
  step_free: "step-free access",
  aisle: "aisle seat",
  extra_legroom: "extra legroom",
  hearing_loop: "hearing loop",
  near_exit: "near exit",
};

/** Non-colour marker: the shape (and glyph) drawn for a seat. */
export type Marker = "plain" | "wheelchair" | "companion" | "access";

export type SeatModel = {
  id: string;
  sectionName: string;
  rowLabel: string;
  seatLabel: string;
  /** "Row R, Seat S" */
  label: string;
  x: number;
  y: number;
  features: AccessFeatureName[];
  /** Human-readable feature names. */
  featureText: string[];
  marker: Marker;
  /** Labels of the access seats this seat is the companion for. */
  companionFor: string[];
  /** Labels of the companion seats attached to this (access) seat. */
  companions: string[];
};

export type ReservedSectionModel = {
  kind: "reserved";
  id: string;
  name: string;
  seats: SeatModel[];
};

export type GaSectionModel = {
  kind: "ga";
  id: string;
  name: string;
  capacity: number;
  /** Position in seat units, placed below the reserved seats. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SectionModel = ReservedSectionModel | GaSectionModel;

export type LayoutModel = {
  id: string;
  venueId: string;
  name: string;
  sections: SectionModel[];
  /** In svg user units (seat units times SCALE). */
  bounds: { x: number; y: number; width: number; height: number };
  totals: { seats: number; accessSeats: number; companionSeats: number; gaCapacity: number };
  summary: string;
};

/** SVG user units per seat unit. */
export const SCALE = 10;
const PAD = 2;
const GA_HEIGHT = 6;
const GA_GAP = 3;
const GA_MIN_WIDTH = 30;

export function buildModel(layout: LayoutView): LayoutModel {
  const byId = new Map<string, { label: string; companions: string[] }>();
  for (const sec of layout.sections)
    for (const row of sec.rows)
      for (const s of row.seats)
        byId.set(s.id, { label: `Row ${s.rowLabel}, Seat ${s.seatLabel}`, companions: [] });
  for (const sec of layout.sections)
    for (const row of sec.rows)
      for (const s of row.seats)
        if (s.companionOf !== null) {
          const mine = byId.get(s.id);
          const target = byId.get(s.companionOf);
          if (mine && target) target.companions.push(mine.label);
        }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seats = 0;
  let accessSeats = 0;
  let companionSeats = 0;
  let gaCapacity = 0;

  const sections: SectionModel[] = [];
  const gaPending: GaSectionModel[] = [];
  for (const sec of layout.sections) {
    if (sec.kind === "ga") {
      const capacity = sec.gaCapacity ?? 0;
      gaCapacity += capacity;
      const ga: GaSectionModel = {
        kind: "ga",
        id: sec.id,
        name: sec.name,
        capacity,
        x: 0,
        y: 0,
        width: GA_MIN_WIDTH,
        height: GA_HEIGHT,
      };
      gaPending.push(ga);
      sections.push(ga);
      continue;
    }
    const out: SeatModel[] = [];
    for (const row of sec.rows) {
      for (const s of row.seats) {
        const info = byId.get(s.id)!;
        const features = [...s.accessFeatures];
        const marker: Marker = features.includes("wheelchair_space")
          ? "wheelchair"
          : s.companionOf !== null
            ? "companion"
            : features.length > 0
              ? "access"
              : "plain";
        seats += 1;
        if (features.length > 0) accessSeats += 1;
        if (s.companionOf !== null) companionSeats += 1;
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x);
        maxY = Math.max(maxY, s.y);
        const target = s.companionOf === null ? undefined : byId.get(s.companionOf);
        out.push({
          id: s.id,
          sectionName: sec.name,
          rowLabel: s.rowLabel,
          seatLabel: s.seatLabel,
          label: info.label,
          x: s.x,
          y: s.y,
          features,
          featureText: features.map((f) => FEATURE_LABELS[f]),
          marker,
          companionFor: target ? [target.label] : [],
          companions: info.companions,
        });
      }
    }
    sections.push({ kind: "reserved", id: sec.id, name: sec.name, seats: out });
  }

  if (seats === 0) {
    minX = 0;
    minY = 0;
    maxX = GA_MIN_WIDTH - 1;
    maxY = -GA_GAP;
  }
  const width = Math.max(maxX - minX + 1, GA_MIN_WIDTH);
  let y = maxY + GA_GAP;
  for (const ga of gaPending) {
    ga.x = minX - 0.5;
    ga.y = y;
    ga.width = width;
    ga.height = GA_HEIGHT;
    y += GA_HEIGHT + 1;
  }
  const bottom = gaPending.length > 0 ? y - 1 : maxY + 0.5;
  const bounds = {
    x: (minX - 0.5 - PAD) * SCALE,
    y: (minY - 0.5 - PAD) * SCALE,
    width: (width + 2 * PAD) * SCALE,
    height: (bottom - (minY - 0.5) + 2 * PAD) * SCALE,
  };

  const summary =
    `Seat map of ${layout.name}: ${seats} reserved ${seats === 1 ? "seat" : "seats"}, ` +
    `${accessSeats} access ${accessSeats === 1 ? "seat" : "seats"}, ` +
    `${companionSeats} companion ${companionSeats === 1 ? "seat" : "seats"}, ` +
    `general admission capacity ${gaCapacity}`;

  return {
    id: layout.id,
    venueId: layout.venueId,
    name: layout.name,
    sections,
    bounds,
    totals: { seats, accessSeats, companionSeats, gaCapacity },
    summary,
  };
}

/** Tooltip text, e.g. "Stalls, Row C, Seat 12 — wheelchair space; companion seat Row C, Seat 13". */
export function seatTitle(seat: SeatModel): string {
  const parts = [...seat.featureText];
  for (const c of seat.companions) parts.push(`companion seat ${c}`);
  for (const c of seat.companionFor) parts.push(`companion for ${c}`);
  const base = `${seat.sectionName}, ${seat.label}`;
  return parts.length === 0 ? base : `${base} — ${parts.join("; ")}`;
}
