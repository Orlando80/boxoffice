import { describe, expect, it } from "vitest";
import {
  ACCESS_FEATURES,
  validateLayout,
  validateVenueGraph,
  type Layout,
  type Seat,
  type Section,
  type VenueGraph,
  type Violation,
} from "../../src/index.js";
import { eventFor, layoutA, layoutB, seat, validGraph } from "./fixtures.js";

const violations = (r: { ok: boolean; error?: Violation[] }): Violation[] =>
  r.ok ? [] : (r.error ?? []);
const pairs = (r: { ok: boolean; error?: Violation[] }) =>
  violations(r)
    .map((x) => `${x.rule}@${x.item}`)
    .sort();

const withSections = (l: Layout, f: (s: readonly Section[]) => Section[]): Layout => ({
  ...l,
  sections: f(l.sections),
});
const mapSeats = (l: Layout, secId: string, f: (s: readonly Seat[]) => Seat[]): Layout =>
  withSections(l, (ss) => ss.map((s) => (s.id === secId ? { ...s, seats: f(s.seats) } : s)));
const addStalls = (...extra: Seat[]) => mapSeats(layoutA(), "sec-stalls", (s) => [...s, ...extra]);

describe("valid fixtures", () => {
  it("layouts pass validateLayout", () => {
    expect(validateLayout(layoutA()).ok).toBe(true);
    expect(validateLayout(layoutB()).ok).toBe(true);
  });
  it("graph passes validateVenueGraph", () => {
    const r = validateVenueGraph(validGraph());
    expect(violations(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("feature list is exactly F-4", () => {
    expect([...ACCESS_FEATURES]).toEqual([
      "wheelchair_space",
      "transfer_seat",
      "step_free",
      "aisle",
      "extra_legroom",
      "hearing_loop",
      "near_exit",
    ]);
  });
  it("every listed feature is accepted", () => {
    expect(
      validateLayout(addStalls(seat("all", "Z", "1", { accessFeatures: [...ACCESS_FEATURES] }))).ok,
    ).toBe(true);
  });
  it("empty layout and empty graph are valid", () => {
    expect(validateLayout({ id: "l", venueId: "v", name: "n", sections: [] }).ok).toBe(true);
    expect(validateVenueGraph({ venues: [], layouts: [], events: [] }).ok).toBe(true);
  });
});

describe("AC 2 rejections (exact rule, exact item, nothing else)", () => {
  it("duplicate seat label in a row", () => {
    expect(pairs(validateLayout(addStalls(seat("dup", "A", "1", { x: 9 }))))).toEqual([
      "duplicate_seat_label@seat:dup",
    ]);
  });
  it("same label in another row or another section is fine", () => {
    const l = withSections(addStalls(seat("ok1", "Q", "1")), (ss) => [
      ...ss,
      {
        id: "sec2",
        name: "Other",
        kind: "reserved",
        gaCapacity: null,
        seats: [seat("o1", "A", "1")],
      },
    ]);
    expect(validateLayout(l).ok).toBe(true);
  });
  it("labels that collide if naively joined are distinct", () => {
    const l = addStalls(seat("p", "A1", "2"), seat("q", "A", "12"), seat("r", "A", "1 2"));
    expect(violations(validateLayout(l))).toEqual([]);
  });
  it.each([0, -1, 1.5, null, Number.NaN, Infinity])("GA capacity %s rejected", (cap) => {
    const l = withSections(layoutA(), (ss) =>
      ss.map((s) => (s.id === "sec-ga" ? { ...s, gaCapacity: cap } : s)),
    );
    expect(pairs(validateLayout(l))).toEqual(["ga_capacity_invalid@section:sec-ga"]);
  });
  it("GA capacity 1 accepted", () => {
    const l = withSections(layoutA(), (ss) =>
      ss.map((s) => (s.id === "sec-ga" ? { ...s, gaCapacity: 1 } : s)),
    );
    expect(validateLayout(l).ok).toBe(true);
  });
  it("companion in another section", () => {
    const l = withSections(layoutA(), (ss) => [
      ...ss,
      {
        id: "sec2",
        name: "Box",
        kind: "reserved",
        gaCapacity: null,
        seats: [seat("x1", "A", "1", { companionOf: "w1" })],
      },
    ]);
    expect(pairs(validateLayout(l))).toEqual(["companion_cross_section@seat:x1"]);
  });
  it("companion in another layout (graph)", () => {
    const bad: VenueGraph = {
      ...validGraph(),
      layouts: [addStalls(seat("x1", "Q", "1", { companionOf: "bw" })), layoutB()],
    };
    expect(pairs(validateVenueGraph(bad))).toEqual(["companion_cross_layout@seat:x1"]);
  });
  it("companion to a nonexistent seat", () => {
    expect(pairs(validateLayout(addStalls(seat("x1", "Q", "1", { companionOf: "nope" }))))).toEqual(
      ["companion_unknown_seat@seat:x1"],
    );
  });
  it("two companions for one access seat", () => {
    expect(pairs(validateLayout(addStalls(seat("c1b", "W", "3", { companionOf: "w1" }))))).toEqual([
      "companion_duplicate_for_access_seat@seat:w1",
    ]);
  });
  it("three companions yield one violation for the access seat", () => {
    const l = addStalls(
      seat("c1b", "W", "3", { companionOf: "w1" }),
      seat("c1c", "W", "4", { companionOf: "w1" }),
    );
    expect(pairs(validateLayout(l))).toEqual(["companion_duplicate_for_access_seat@seat:w1"]);
  });
  it("access feature outside the list", () => {
    const l = addStalls(seat("bad", "Q", "1", { accessFeatures: ["step_free", "jacuzzi"] }));
    expect(pairs(validateLayout(l))).toEqual(["access_feature_unknown@seat:bad"]);
  });
  it.each(["Aisle", "aisle ", "", "toString", "constructor", "__proto__"])(
    "feature matching is exact: %j",
    (f) => {
      const l = addStalls(seat("bad", "Q", "1", { accessFeatures: [f] }));
      expect(pairs(validateLayout(l))).toEqual(["access_feature_unknown@seat:bad"]);
    },
  );
  it("performance referencing another venue's layout", () => {
    const g = validGraph();
    const bad: VenueGraph = {
      ...g,
      events: [eventFor("venue-a", "ev-a", ["layout-a", "layout-b"]), g.events[1]!],
    };
    expect(pairs(validateVenueGraph(bad))).toEqual([
      "performance_layout_other_venue@performance:ev-a-p1",
    ]);
  });
});

describe("extra rules", () => {
  it("ga_capacity_on_reserved_section", () => {
    const l = withSections(layoutA(), (ss) =>
      ss.map((s) => (s.id === "sec-stalls" ? { ...s, gaCapacity: 5 } : s)),
    );
    expect(pairs(validateLayout(l))).toEqual([
      "ga_capacity_on_reserved_section@section:sec-stalls",
    ]);
  });
  it("seats_on_ga_section", () => {
    const l = withSections(layoutA(), (ss) =>
      ss.map((s) => (s.id === "sec-ga" ? { ...s, seats: [seat("g", "A", "1")] } : s)),
    );
    expect(pairs(validateLayout(l))).toEqual(["seats_on_ga_section@section:sec-ga"]);
  });
  it("duplicate_seat_id within and across sections", () => {
    expect(pairs(validateLayout(addStalls(seat("a1", "Q", "9"))))).toContain(
      "duplicate_seat_id@seat:a1",
    );
    const l2 = withSections(layoutA(), (ss) => [
      ...ss,
      { id: "s2", name: "S2", kind: "reserved", gaCapacity: null, seats: [seat("a1", "A", "1")] },
    ]);
    expect(pairs(validateLayout(l2))).toContain("duplicate_seat_id@seat:a1");
  });
  it.each([1.5, Number.NaN, Infinity])("seat_position_not_integer x=%s", (x) => {
    expect(pairs(validateLayout(addStalls(seat("p", "Q", "1", { x }))))).toEqual([
      "seat_position_not_integer@seat:p",
    ]);
  });
  it("seat_position_not_integer for y; zero/negative integers allowed", () => {
    expect(pairs(validateLayout(addStalls(seat("p", "Q", "1", { y: 0.1 }))))).toEqual([
      "seat_position_not_integer@seat:p",
    ]);
    expect(validateLayout(addStalls(seat("p", "Q", "1", { x: 0, y: -3 }))).ok).toBe(true);
  });
  it("companion_is_access_seat: self", () => {
    expect(pairs(validateLayout(addStalls(seat("me", "Q", "1", { companionOf: "me" }))))).toEqual([
      "companion_is_access_seat@seat:me",
    ]);
  });
  it("companion_is_access_seat: chain", () => {
    const l = addStalls(seat("x", "Q", "1", { companionOf: "c1" }));
    expect(pairs(validateLayout(l))).toContain("companion_is_access_seat@seat:x");
  });
  it("access_seat_without_feature", () => {
    const l = addStalls(seat("plain", "Q", "1"), seat("pc", "Q", "2", { companionOf: "plain" }));
    expect(pairs(validateLayout(l))).toEqual(["access_seat_without_feature@seat:plain"]);
  });
  it.each(["Mars/Olympus", "", "BST", "EST", "CET", "GB", "+01:00", "Europe/london", "europe/nowhere"])("venue_time_zone_invalid %j", (tz) => {
    const g = validGraph();
    const bad = { ...g, venues: [{ ...g.venues[0]!, timeZone: tz }, g.venues[1]!] };
    expect(pairs(validateVenueGraph(bad))).toEqual(["venue_time_zone_invalid@venue:venue-a"]);
  });
  it("performance_layout_unknown", () => {
    const g = validGraph();
    const bad = { ...g, events: [eventFor("venue-a", "ev-a", ["ghost"]), g.events[1]!] };
    expect(pairs(validateVenueGraph(bad))).toEqual([
      "performance_layout_unknown@performance:ev-a-p0",
    ]);
  });
  it("graph validation also runs layout checks", () => {
    const bad = { ...validGraph(), layouts: [addStalls(seat("d", "A", "1")), layoutB()] };
    expect(pairs(validateVenueGraph(bad))).toEqual(["duplicate_seat_label@seat:d"]);
  });
  it("does not mutate input", () => {
    const g = validGraph();
    const snap = JSON.stringify(g);
    validateVenueGraph(g);
    expect(JSON.stringify(g)).toBe(snap);
  });
  it("violations carry messages and kind:id items", () => {
    for (const x of violations(validateLayout(addStalls(seat("dup", "A", "1"))))) {
      expect(x.message.length).toBeGreaterThan(0);
      expect(x.item).toMatch(/^[a-z]+:.+/);
    }
  });
});

describe("not fail-fast", () => {
  it("reports every violation across layouts, sections and performances", () => {
    const g = validGraph();
    const l1 = withSections(
      addStalls(
        seat("dup", "A", "1"),
        seat("bad", "Q", "1", { accessFeatures: ["nope"] }),
        seat("cc", "W", "9", { companionOf: "w1" }),
      ),
      (ss) => ss.map((s) => (s.id === "sec-ga" ? { ...s, gaCapacity: 0 } : s)),
    );
    const bad: VenueGraph = {
      venues: [{ ...g.venues[0]!, timeZone: "Nope/Zone" }, g.venues[1]!],
      layouts: [l1, layoutB()],
      events: [eventFor("venue-a", "ev-a", ["layout-b", "ghost"]), g.events[1]!],
    };
    expect(pairs(validateVenueGraph(bad))).toEqual(
      [
        "venue_time_zone_invalid@venue:venue-a",
        "duplicate_seat_label@seat:dup",
        "access_feature_unknown@seat:bad",
        "companion_duplicate_for_access_seat@seat:w1",
        "ga_capacity_invalid@section:sec-ga",
        "performance_layout_other_venue@performance:ev-a-p0",
        "performance_layout_unknown@performance:ev-a-p1",
      ].sort(),
    );
  });
});

describe("zone acceptance", () => {
  it.each(["Europe/London", "UTC"])("%s accepted", (tz) => {
    const g = validGraph();
    const ok = { ...g, venues: [{ ...g.venues[0]!, timeZone: tz }, g.venues[1]!] };
    expect(violations(validateVenueGraph(ok))).toEqual([]);
  });
});
