import type { AccessFeature } from "../venues/access-features.js";
import type { SectionKind } from "../venues/types.js";

export const SEAT_ROLES = ["standard", "access", "companion"] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];

export const HOLD_STATUSES = ["active", "released", "expired"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export interface HoldSeatLine {
  readonly seatId: string;
  readonly role: SeatRole;
  /** Typed as string so that out-of-list values can be detected at the boundary. */
  readonly accessNeed?: AccessFeature | string | undefined;
}

export interface HoldGaLine {
  readonly sectionId: string;
  readonly quantity: number;
}

export interface HoldRequest {
  readonly seats: readonly HoldSeatLine[];
  readonly ga: readonly HoldGaLine[];
}

export interface SeatFact {
  readonly seatId: string;
  readonly sectionKind: SectionKind;
  readonly layoutId: string;
  readonly accessFeatures: readonly (AccessFeature | string)[];
  /** Id of the access seat this seat is companion for, or null. */
  readonly companionOf: string | null;
}

export interface GaSectionFact {
  readonly sectionId: string;
  readonly sectionKind: SectionKind;
  readonly layoutId: string;
}

/** Facts for the requested ids only. A requested id with no fact is outside the layout. */
export interface HoldFacts {
  readonly performanceLayoutId: string;
  readonly performanceStartsAt: Date;
  readonly seats: ReadonlyMap<string, SeatFact>;
  readonly sections: ReadonlyMap<string, GaSectionFact>;
}

export interface ValidatedHold {
  /** Places counted towards the limit; companion seats excluded. */
  readonly placeCount: number;
  readonly seats: readonly HoldSeatLine[];
  readonly ga: readonly HoldGaLine[];
}
