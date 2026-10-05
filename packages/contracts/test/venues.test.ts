import { ACCESS_FEATURES, PERFORMANCE_ACCESS_TAGS } from "@boxoffice/domain";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ErrorBody,
  EventDetail,
  EventSummary,
  LayoutSummary,
  LayoutView,
  PerformanceSummary,
  RowView,
  SeatView,
  SectionView,
  VenueDetail,
  VenueSummary,
} from "../src/index.js";

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
  s.safeParse(v).success;

const seat = (n: number, over: Record<string, unknown> = {}) => ({
  id: u(100 + n),
  rowLabel: "A",
  seatLabel: String(n),
  x: n * 10,
  y: 0,
  accessFeatures: [] as string[],
  companionOf: null as string | null,
  ...over,
});

const venue = { id: u(1), name: "Test Hall", slug: "test-hall", timeZone: "Europe/London" };
const eventSummary = {
  id: u(2),
  slug: "test-show",
  name: "Test Show",
  runningTimeMinutes: 120,
  ageGuidance: null,
};
const perf = {
  id: u(3),
  startsAt: "2030-01-01T19:30:00.000Z",
  layoutId: u(4),
  accessTags: ["relaxed", "captioned"],
};
const layoutView = () => ({
  id: u(4),
  venueId: u(1),
  name: "End on",
  sections: [
    {
      id: u(10),
      name: "Stalls",
      kind: "reserved",
      gaCapacity: null as number | null,
      rows: [
        {
          label: "A",
          seats: [
            seat(1, { accessFeatures: ["wheelchair_space", "step_free"] }),
            seat(2, { companionOf: u(101) }),
            seat(3, { accessFeatures: ["aisle", "hearing_loop"] }),
          ],
        },
        { label: "B", seats: [seat(4, { rowLabel: "B" })] },
      ],
    },
    { id: u(11), name: "Standing", kind: "ga", gaCapacity: 50 as number | null, rows: [] },
  ],
});

describe("valid samples parse", () => {
  it.each([
    ["VenueSummary", VenueSummary, venue],
    ["LayoutSummary", LayoutSummary, { id: u(4), name: "End on" }],
    ["EventSummary", EventSummary, eventSummary],
    [
      "EventSummary nullables",
      EventSummary,
      { ...eventSummary, runningTimeMinutes: null, ageGuidance: "12+" },
    ],
    [
      "VenueDetail",
      VenueDetail,
      { venue, layouts: [{ id: u(4), name: "End on" }], events: [eventSummary] },
    ],
    ["PerformanceSummary", PerformanceSummary, perf],
    ["PerformanceSummary empty tags", PerformanceSummary, { ...perf, accessTags: [] }],
    ["EventDetail", EventDetail, { ...eventSummary, description: "d", performances: [perf] }],
    [
      "EventDetail null desc",
      EventDetail,
      { ...eventSummary, description: null, performances: [] },
    ],
    ["SeatView", SeatView, seat(1)],
    ["RowView", RowView, { label: "A", seats: [seat(1)] }],
    ["LayoutView", LayoutView, layoutView()],
    ["ErrorBody", ErrorBody, { error: "not_found" }],
  ] as const)("%s", (_n, schema, v) => {
    expect(schema.safeParse(v).success).toBe(true);
  });

  it("every access feature, tag and error code is accepted", () => {
    expect(ok(SeatView, seat(1, { accessFeatures: [...ACCESS_FEATURES] }))).toBe(true);
    expect(ok(PerformanceSummary, { ...perf, accessTags: [...PERFORMANCE_ACCESS_TAGS] })).toBe(
      true,
    );
    for (const error of ["not_found", "bad_request", "unavailable"]) {
      expect(ok(ErrorBody, { error })).toBe(true);
    }
  });

  it("parse preserves data", () => {
    expect(LayoutView.parse(layoutView())).toEqual(layoutView());
  });
});

describe("strictness: extra keys rejected at every level", () => {
  it.each([
    ["VenueSummary", VenueSummary, venue],
    ["LayoutSummary", LayoutSummary, { id: u(4), name: "n" }],
    ["EventSummary", EventSummary, eventSummary],
    ["VenueDetail", VenueDetail, { venue, layouts: [], events: [] }],
    ["PerformanceSummary", PerformanceSummary, perf],
    ["EventDetail", EventDetail, { ...eventSummary, description: null, performances: [] }],
    ["SeatView", SeatView, seat(1)],
    ["RowView", RowView, { label: "A", seats: [] }],
    ["ErrorBody", ErrorBody, { error: "not_found" }],
  ] as const)("%s top level", (_n, schema, v) => {
    expect(schema.safeParse({ ...v, extra: 1 }).success).toBe(false);
  });

  it("nested levels of LayoutView", () => {
    expect(ok(LayoutView, { ...layoutView(), extra: 1 })).toBe(false);

    const sec = layoutView();
    Object.assign(sec.sections[0]!, { extra: 1 });
    expect(ok(LayoutView, sec)).toBe(false);

    const row = layoutView();
    Object.assign(row.sections[0]!.rows[0]!, { extra: 1 });
    expect(ok(LayoutView, row)).toBe(false);

    const st = layoutView();
    Object.assign(st.sections[0]!.rows[0]!.seats[0]!, { extra: 1 });
    expect(ok(LayoutView, st)).toBe(false);
  });

  it("nested levels of VenueDetail / EventDetail", () => {
    expect(ok(VenueDetail, { venue: { ...venue, x: 1 }, layouts: [], events: [] })).toBe(false);
    expect(ok(VenueDetail, { venue, layouts: [{ id: u(4), name: "n", x: 1 }], events: [] })).toBe(
      false,
    );
    expect(ok(VenueDetail, { venue, layouts: [], events: [{ ...eventSummary, x: 1 }] })).toBe(
      false,
    );
    expect(
      ok(EventDetail, { ...eventSummary, description: null, performances: [{ ...perf, x: 1 }] }),
    ).toBe(false);
  });

  it("SectionView top level", () => {
    const s = layoutView().sections[1];
    expect(ok(SectionView, s)).toBe(true);
    expect(ok(SectionView, { ...s, extra: 1 })).toBe(false);
  });
});

describe("invalid values rejected", () => {
  it("non-uuid ids", () => {
    for (const bad of ["abc", "", "123", u(1).slice(1), 5, null]) {
      expect(ok(VenueSummary, { ...venue, id: bad })).toBe(false);
      expect(ok(LayoutSummary, { id: bad, name: "n" })).toBe(false);
      expect(ok(EventSummary, { ...eventSummary, id: bad })).toBe(false);
      expect(ok(PerformanceSummary, { ...perf, id: bad })).toBe(false);
      expect(ok(PerformanceSummary, { ...perf, layoutId: bad })).toBe(false);
      expect(ok(SeatView, seat(1, { id: bad }))).toBe(false);
      expect(ok(SeatView, seat(1, { companionOf: bad }))).toBe(bad === null);
      expect(ok(LayoutView, { ...layoutView(), id: bad })).toBe(false);
      expect(ok(LayoutView, { ...layoutView(), venueId: bad })).toBe(false);
      const sec = layoutView();
      Object.assign(sec.sections[0]!, { id: bad });
      expect(ok(LayoutView, sec)).toBe(false);
    }
  });

  it("non-integer or non-number x/y", () => {
    for (const bad of [1.5, NaN, Infinity, "1", null, undefined]) {
      expect(ok(SeatView, seat(1, { x: bad }))).toBe(false);
      expect(ok(SeatView, seat(1, { y: bad }))).toBe(false);
    }
    expect(ok(SeatView, seat(1, { x: -5, y: 0 }))).toBe(true);
  });

  it("running time must be an integer", () => {
    expect(ok(EventSummary, { ...eventSummary, runningTimeMinutes: 90.5 })).toBe(false);
    expect(ok(EventSummary, { ...eventSummary, runningTimeMinutes: undefined })).toBe(false);
  });

  it("unknown access feature / tag", () => {
    expect(ok(SeatView, seat(1, { accessFeatures: ["jetpack"] }))).toBe(false);
    expect(ok(SeatView, seat(1, { accessFeatures: ["WHEELCHAIR_SPACE"] }))).toBe(false);
    expect(ok(PerformanceSummary, { ...perf, accessTags: ["nope"] })).toBe(false);
    expect(ok(PerformanceSummary, { ...perf, accessTags: ["relaxed", "nope"] })).toBe(false);
  });

  it("ga / capacity rules", () => {
    const sec = (over: Record<string, unknown>) => ({ ...layoutView().sections[1], ...over });
    expect(ok(SectionView, sec({ gaCapacity: null }))).toBe(false);
    expect(ok(SectionView, sec({ gaCapacity: 0 }))).toBe(false);
    expect(ok(SectionView, sec({ gaCapacity: -1 }))).toBe(false);
    expect(ok(SectionView, sec({ gaCapacity: 1.5 }))).toBe(false);
    expect(ok(SectionView, sec({ gaCapacity: 1 }))).toBe(true);
    const res = layoutView().sections[0];
    expect(ok(SectionView, { ...res, gaCapacity: 10 })).toBe(false);
    expect(ok(SectionView, { ...res, kind: "standing" })).toBe(false);
    const lv = layoutView();
    lv.sections[1]!.gaCapacity = null;
    expect(ok(LayoutView, lv)).toBe(false);
    const lv2 = layoutView();
    lv2.sections[0]!.gaCapacity = 5;
    expect(ok(LayoutView, lv2)).toBe(false);
  });

  it("startsAt format (z.iso.datetime behaviour)", () => {
    const p = (startsAt: unknown) => ok(PerformanceSummary, { ...perf, startsAt });
    expect(p("2030-01-01T19:30:00Z")).toBe(true);
    expect(p("2030-01-01T19:30:00.000Z")).toBe(true);
    expect(p("2030-01-01T19:30Z")).toBe(false); // zod 4 requires seconds
    for (const bad of [
      "2030-01-01",
      "2030-01-01 19:30:00Z",
      "2030-01-01T19:30:00",
      "2030-01-01T19:30:00+01:00",
      "2030-01-01T19:30:00+00:00",
      "2030-01-01T19:30:00.000-05:00",
      "2030-13-01T19:30:00Z",
      "2030-02-30T19:30:00Z",
      "not a date",
      "",
      1893526200000,
      null,
    ]) {
      expect(p(bad), String(bad)).toBe(false);
    }
  });

  it("companionOf must reference a seat in the view", () => {
    const lv = layoutView();
    lv.sections[0]!.rows[0]!.seats[1]!.companionOf = u(999);
    const r = LayoutView.safeParse(lv);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.path).toEqual([
        "sections",
        0,
        "rows",
        0,
        "seats",
        1,
        "companionOf",
      ]);
    }
  });

  it("companionOf may reference a seat in another row", () => {
    const lv = layoutView();
    lv.sections[0]!.rows[1]!.seats[0]!.companionOf = u(101);
    expect(ok(LayoutView, lv)).toBe(true);
  });

  it("companionOf self-reference is accepted by the schema (documented behaviour)", () => {
    const lv = layoutView();
    lv.sections[0]!.rows[0]!.seats[0]!.companionOf = u(101);
    expect(ok(LayoutView, lv)).toBe(true);
  });

  it("ErrorBody unknown code", () => {
    for (const error of ["boom", "NOT_FOUND", "", 404, null, undefined]) {
      expect(ok(ErrorBody, { error })).toBe(false);
    }
    expect(ok(ErrorBody, {})).toBe(false);
  });

  it("missing required fields", () => {
    expect(ok(VenueSummary, { id: venue.id, name: "n", slug: "s" })).toBe(false);
    expect(ok(LayoutView, { id: u(4), venueId: u(1), name: "n" })).toBe(false);
    expect(ok(EventDetail, eventSummary)).toBe(false);
  });
});

describe("enums match the domain constants", () => {
  const firstIssue = (schema: { safeParse: (v: unknown) => unknown }, v: unknown) => {
    const r = schema.safeParse(v) as {
      success: boolean;
      error?: { issues: { values?: string[] }[] };
    };
    expect(r.success).toBe(false);
    return r.error!.issues[0]!;
  };

  it("access features: exactly the domain set", () => {
    const issue = firstIssue(SeatView, seat(1, { accessFeatures: ["zzz"] }));
    expect([...issue.values!].sort()).toEqual([...ACCESS_FEATURES].sort());
  });

  it("performance tags: exactly the domain set", () => {
    const issue = firstIssue(PerformanceSummary, { ...perf, accessTags: ["zzz"] });
    expect([...issue.values!].sort()).toEqual([...PERFORMANCE_ACCESS_TAGS].sort());
  });
});

describe("types", () => {
  type Tag = (typeof PERFORMANCE_ACCESS_TAGS)[number];
  type Feature = (typeof ACCESS_FEATURES)[number];

  it("have expected field types", () => {
    expectTypeOf<PerformanceSummary["accessTags"]>().toEqualTypeOf<Tag[]>();
    expectTypeOf<PerformanceSummary["accessTags"]>().not.toEqualTypeOf<string[]>();
    expectTypeOf<PerformanceSummary["startsAt"]>().toEqualTypeOf<string>();
    expectTypeOf<SeatView["accessFeatures"]>().toEqualTypeOf<Feature[]>();
    expectTypeOf<SeatView["accessFeatures"]>().not.toEqualTypeOf<string[]>();
    expectTypeOf<SeatView["companionOf"]>().toEqualTypeOf<string | null>();
    expectTypeOf<SeatView["x"]>().toEqualTypeOf<number>();
    expectTypeOf<SectionView["kind"]>().toEqualTypeOf<"reserved" | "ga">();
    expectTypeOf<SectionView["gaCapacity"]>().toEqualTypeOf<number | null>();
    expectTypeOf<SectionView["rows"]>().toEqualTypeOf<RowView[]>();
    expectTypeOf<EventSummary["runningTimeMinutes"]>().toEqualTypeOf<number | null>();
    expectTypeOf<EventSummary["ageGuidance"]>().toEqualTypeOf<string | null>();
    expectTypeOf<EventDetail["performances"]>().toEqualTypeOf<PerformanceSummary[]>();
    expectTypeOf<EventDetail["description"]>().toEqualTypeOf<string | null>();
    expectTypeOf<LayoutView["sections"]>().toEqualTypeOf<SectionView[]>();
    expectTypeOf<ErrorBody["error"]>().toEqualTypeOf<"not_found" | "bad_request" | "unavailable">();
    expectTypeOf<VenueDetail["layouts"]>().toEqualTypeOf<LayoutSummary[]>();
    expectTypeOf<VenueDetail["events"]>().toEqualTypeOf<EventSummary[]>();
    expectTypeOf<VenueSummary>().toEqualTypeOf<{
      id: string;
      name: string;
      slug: string;
      timeZone: string;
    }>();
  });
});

describe("JSON round-trip", () => {
  it("LayoutView survives JSON", () => {
    const v = LayoutView.parse(layoutView());
    const back: unknown = JSON.parse(JSON.stringify(v));
    expect(LayoutView.safeParse(back).success).toBe(true);
    expect(LayoutView.parse(back)).toEqual(v);
  });

  it("EventDetail survives JSON", () => {
    const v = EventDetail.parse({ ...eventSummary, description: null, performances: [perf] });
    expect(EventDetail.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
});
