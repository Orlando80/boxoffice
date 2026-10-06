import type {
  GaSectionFact,
  HoldFacts,
  HoldRequest,
  HoldViolation,
  SeatFact,
} from "../../src/index.js";

export const NOW = new Date("2030-01-01T12:00:00Z");
export const FUTURE = new Date("2030-01-02T12:00:00Z");
export const LAYOUT = "layout-a";

export const seatFact = (seatId: string, over: Partial<SeatFact> = {}): SeatFact => ({
  seatId,
  sectionKind: "reserved",
  layoutId: LAYOUT,
  accessFeatures: [],
  companionOf: null,
  ...over,
});

export const gaFact = (sectionId: string, over: Partial<GaSectionFact> = {}): GaSectionFact => ({
  sectionId,
  sectionKind: "ga",
  layoutId: LAYOUT,
  ...over,
});

export const makeFacts = (
  seats: SeatFact[],
  sections: GaSectionFact[] = [],
  over: Partial<HoldFacts> = {},
): HoldFacts => ({
  performanceLayoutId: LAYOUT,
  performanceStartsAt: FUTURE,
  seats: new Map(seats.map((s) => [s.seatId, s])),
  sections: new Map(sections.map((s) => [s.sectionId, s])),
  ...over,
});

/** Fixture: standard s1..s12, access w1 (+ companions c1, c1b), access t1 (+ c2), GA g1/g2, reserved section res. */
export const baseFacts = (over: Partial<HoldFacts> = {}): HoldFacts =>
  makeFacts(
    [
      ...Array.from({ length: 12 }, (_, i) => seatFact(`s${i + 1}`)),
      seatFact("w1", { accessFeatures: ["wheelchair_space"] }),
      seatFact("c1", { companionOf: "w1" }),
      seatFact("c1b", { companionOf: "w1" }),
      seatFact("t1", { accessFeatures: ["aisle"] }),
      seatFact("c2", { companionOf: "t1" }),
      seatFact("ga-seat", { sectionKind: "ga" }),
      seatFact("other", { layoutId: "layout-b" }),
    ],
    [
      gaFact("g1"),
      gaFact("g2"),
      gaFact("res", { sectionKind: "reserved" }),
      gaFact("far", { layoutId: "layout-b" }),
    ],
    over,
  );

export const req = (r: Partial<HoldRequest>): HoldRequest => ({ seats: [], ga: [], ...r });

export const rulesOf = (violations: readonly HoldViolation[]): string[] =>
  violations.map((x) => x.rule);
