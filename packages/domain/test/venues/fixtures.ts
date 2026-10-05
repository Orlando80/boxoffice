import type { Event, Layout, Seat, VenueGraph } from "../../src/index.js";

export const seat = (id: string, row: string, n: string, over: Partial<Seat> = {}): Seat => ({
  id,
  rowLabel: row,
  seatLabel: n,
  x: 1,
  y: 1,
  accessFeatures: [],
  companionOf: null,
  ...over,
});

export const layoutA = (): Layout => ({
  id: "layout-a",
  venueId: "venue-a",
  name: "Stalls and standing",
  sections: [
    {
      id: "sec-stalls",
      name: "Stalls",
      kind: "reserved",
      gaCapacity: null,
      seats: [
        seat("a1", "A", "1"),
        seat("a2", "A", "2", { x: 2 }),
        seat("w1", "W", "1", { accessFeatures: ["wheelchair_space", "step_free"], y: 5 }),
        seat("c1", "W", "2", { companionOf: "w1", y: 5, x: 2 }),
        seat("t1", "B", "1", { accessFeatures: ["transfer_seat", "aisle"], y: 2 }),
        seat("c2", "B", "2", { companionOf: "t1", y: 2, x: 2 }),
      ],
    },
    { id: "sec-ga", name: "Standing", kind: "ga", gaCapacity: 100, seats: [] },
  ],
});

export const layoutB = (): Layout => ({
  id: "layout-b",
  venueId: "venue-b",
  name: "Circle",
  sections: [
    {
      id: "sec-circle",
      name: "Circle",
      kind: "reserved",
      gaCapacity: null,
      seats: [
        seat("b1", "A", "1"),
        seat("bw", "A", "2", { accessFeatures: ["hearing_loop", "near_exit", "extra_legroom"] }),
        seat("bc", "A", "3", { companionOf: "bw" }),
      ],
    },
  ],
});

export const eventFor = (venueId: string, id: string, layoutIds: string[]): Event => ({
  id,
  venueId,
  name: "Invented Show",
  slug: id,
  description: "An invented show.",
  runningTimeMinutes: 120,
  ageGuidance: "Suitable for all",
  performances: layoutIds.map((layoutId, i) => ({
    id: `${id}-p${i}`,
    startsAt: new Date(Date.UTC(2026, 9, 25, 19, 30)),
    layoutId,
    accessTags: i === 0 ? ["relaxed", "captioned"] : [],
  })),
});

export const validGraph = (): VenueGraph => ({
  venues: [
    { id: "venue-a", name: "Test Studio", slug: "test-studio", timeZone: "Europe/London" },
    { id: "venue-b", name: "Test Theatre", slug: "test-theatre", timeZone: "Europe/London" },
  ],
  layouts: [layoutA(), layoutB()],
  events: [
    eventFor("venue-a", "ev-a", ["layout-a", "layout-a"]),
    eventFor("venue-b", "ev-b", ["layout-b"]),
  ],
});
