import type { AccessFeature } from "./access-features.js";

export type SectionKind = "reserved" | "ga";

export type PerformanceAccessTag = "relaxed" | "captioned" | "bsl_interpreted" | "audio_described";

export const PERFORMANCE_ACCESS_TAGS: readonly PerformanceAccessTag[] = [
  "relaxed",
  "captioned",
  "bsl_interpreted",
  "audio_described",
];

export interface Venue {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** IANA zone, e.g. "Europe/London". */
  readonly timeZone: string;
}

export interface Seat {
  readonly id: string;
  readonly rowLabel: string;
  readonly seatLabel: string;
  /** Integer layout units, origin top-left, y grows downward, one unit per seat pitch. */
  readonly x: number;
  readonly y: number;
  /** Typed as string so that out-of-list values can be detected at the boundary. */
  readonly accessFeatures: readonly (AccessFeature | string)[];
  /** Companion link: the id of the access seat this seat serves as companion for. */
  readonly companionOf: string | null;
}

export interface Section {
  readonly id: string;
  readonly name: string;
  readonly kind: SectionKind;
  /** Integer >= 1 on `ga` sections; null on `reserved` sections. */
  readonly gaCapacity: number | null;
  /** Empty for `ga` sections. */
  readonly seats: readonly Seat[];
}

export interface Layout {
  readonly id: string;
  readonly venueId: string;
  readonly name: string;
  readonly sections: readonly Section[];
}

export interface Performance {
  readonly id: string;
  readonly startsAt: Date;
  /** Layout per performance (F-1). */
  readonly layoutId: string;
  readonly accessTags: readonly PerformanceAccessTag[];
}

export interface Event {
  readonly id: string;
  readonly venueId: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly runningTimeMinutes: number;
  readonly ageGuidance: string;
  readonly performances: readonly Performance[];
}

export interface VenueGraph {
  readonly venues: readonly Venue[];
  readonly layouts: readonly Layout[];
  readonly events: readonly Event[];
}
