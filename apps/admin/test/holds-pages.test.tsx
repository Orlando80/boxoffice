import { cleanup, screen } from "@testing-library/react";
import axe from "axe-core";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/api", async (orig) => ({
  ApiUnavailable: (await orig<typeof import("../src/api")>()).ApiUnavailable,
  getVenues: vi.fn(),
  getVenue: vi.fn(),
  getEvent: vi.fn(),
  getLayout: vi.fn(),
  getPerformance: vi.fn(),
  getAvailability: vi.fn(),
}));

import RootLayout from "../app/layout";
import EventPage from "../app/venues/[venueId]/events/[eventId]/page";
import PerformancePage, {
  generateMetadata as perfMeta,
} from "../app/venues/[venueId]/performances/[performanceId]/page";
import {
  ApiUnavailable,
  getAvailability,
  getEvent,
  getLayout,
  getPerformance,
  getVenue,
} from "../src/api";

const VID = "11111111-1111-4111-8111-111111111111";
const EID = "22222222-2222-4222-8222-222222222222";
const LID = "33333333-3333-4333-8333-333333333333";
const L2 = "44444444-4444-4444-8444-444444444444";
const PID = "55555555-5555-4555-8555-555555555555";
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const venueSummary = { id: VID, name: "Test Hall", slug: "test-hall", timeZone: "Europe/London" };
const venueDetail = {
  venue: venueSummary,
  layouts: [
    { id: LID, name: "Stalls only" },
    { id: L2, name: "Full house" },
  ],
  events: [
    { id: EID, slug: "test-play", name: "Test Play", runningTimeMinutes: 120, ageGuidance: "12+" },
  ],
};
const eventDetail = {
  ...venueDetail.events[0]!,
  description: "A play for testing.",
  performances: [
    { id: PID, startsAt: "2026-10-25T19:30:00.000Z", layoutId: LID, accessTags: [] },
    {
      id: "66666666-6666-4666-8666-666666666666",
      startsAt: "2026-10-24T18:30:00.000Z",
      layoutId: L2,
      accessTags: [],
    },
  ],
};

function mount(page: ReactElement, docTitle: string) {
  const markup = renderToStaticMarkup(<RootLayout>{page}</RootLayout>);
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  document.documentElement.lang = parsed.documentElement.lang;
  document.title = docTitle;
  document.body.innerHTML = parsed.body.innerHTML;
}
async function seriousViolations() {
  const results = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}
const title = (m: { title?: unknown }) => m.title as string;

const eparams = { params: Promise.resolve({ venueId: VID, eventId: EID }) };
const pparams = { params: Promise.resolve({ venueId: VID, performanceId: PID }) };

const perf = {
  id: PID,
  venueId: VID,
  eventId: EID,
  eventName: "Test Play",
  startsAt: "2026-10-25T19:30:00.000Z",
  layoutId: LID,
  accessTags: [],
};
const mkSeat = (n: number, label: string, f: string[], companionOf: string | null) => ({
  id: uid(n),
  rowLabel: "C",
  seatLabel: label,
  x: n - 1,
  y: 0,
  accessFeatures: f,
  companionOf,
});
const layout = {
  id: LID,
  venueId: VID,
  name: "Stalls only",
  sections: [
    {
      id: uid(9001),
      name: "Stalls",
      kind: "reserved",
      gaCapacity: null,
      rows: [
        {
          label: "C",
          seats: [
            mkSeat(1, "1", [], null),
            mkSeat(2, "2", ["wheelchair_space"], null),
            mkSeat(3, "3", [], uid(2)),
          ],
        },
      ],
    },
    { id: uid(9002), name: "Standing", kind: "ga", gaCapacity: 50, rows: [] },
  ],
};
const availability = {
  performanceId: PID,
  asOf: "2026-10-25T13:05:09.000Z",
  heldSeatIds: [uid(2), uid(3)],
  ga: [{ sectionId: uid(9002), held: 7, capacity: 50 }],
};

beforeEach(() => {
  vi.mocked(getVenue).mockResolvedValue(venueDetail);
  vi.mocked(getEvent).mockResolvedValue(eventDetail as never);
  vi.mocked(getPerformance).mockResolvedValue(perf as never);
  vi.mocked(getAvailability).mockResolvedValue(availability as never);
  vi.mocked(getLayout).mockResolvedValue(layout as never);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("event page performance links", () => {
  it("row header links to the performance page; layout link remains", async () => {
    mount(await EventPage(eparams), "t");
    const table = screen.getByRole("table");
    for (const p of eventDetail.performances) {
      const th = [...table.querySelectorAll("tbody th")].find((t) =>
        t.closest("tr")!.querySelector(`a[href="/venues/${VID}/layouts/${p.layoutId}"]`),
      )!;
      const a = th.querySelector("a")!;
      expect(a.getAttribute("href")).toBe(`/venues/${VID}/performances/${p.id}`);
      expect(th.getAttribute("scope")).toBe("row");
      expect(a.textContent!.trim().length).toBeGreaterThan(0);
    }
    expect(screen.getAllByRole("link", { name: "Stalls only" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Full house" })).toHaveLength(1);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe("performance page", () => {
  it("renders title, h1, venue-zone times, links, map and table; axe clean", async () => {
    const meta = await perfMeta(pparams);
    expect(title(meta)).toContain("Test Play");
    mount(await PerformancePage(pparams), title(meta));
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.documentElement.lang).toBe("en-GB");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Test Play");
    expect(document.body.textContent).toContain("Performance: Sun 25 Oct 2026, 19:30");
    // 25 Oct 13:05:09Z is GMT (BST ended 01:00 UTC that day)
    expect(document.body.textContent).toContain("Held state as of 13:05:09 (venue time)");
    expect(screen.getByRole("link", { name: "Refresh" }).getAttribute("href")).toBe(
      `/venues/${VID}/performances/${PID}`,
    );
    expect(screen.getByRole("link", { name: "Back to event" }).getAttribute("href")).toBe(
      `/venues/${VID}/events/${EID}`,
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(document.body.textContent).toContain("7 of 50 held");
    expect(document.querySelectorAll("[data-held=true]")).toHaveLength(2);
    expect(getLayout).toHaveBeenCalledWith(VID, LID);
    const levels = [...document.querySelectorAll("h1,h2,h3")].map((h) => Number(h.tagName[1]));
    levels.forEach((l, i) => i > 0 && expect(l - levels[i - 1]!).toBeLessThanOrEqual(1));
    expect(await seriousViolations()).toEqual([]);
  });

  it("as-of time uses the venue zone, not the runtime zone", async () => {
    vi.mocked(getVenue).mockResolvedValue({
      ...venueDetail,
      venue: { ...venueSummary, timeZone: "America/New_York" },
    });
    mount(await PerformancePage(pparams), "t");
    expect(document.body.textContent).toContain("as of 09:05:09 (venue time)");
  });

  it("zero holds still shows the Status column, all Available", async () => {
    vi.mocked(getAvailability).mockResolvedValue({
      ...availability,
      heldSeatIds: [],
      ga: [],
    } as never);
    mount(await PerformancePage(pparams), "t");
    expect(document.querySelectorAll("[data-held]")).toHaveLength(0);
    expect([...document.querySelectorAll("th")].some((t) => t.textContent === "Status")).toBe(true);
    expect(await seriousViolations()).toEqual([]);
  });

  it.each([
    ["performance", () => vi.mocked(getPerformance).mockResolvedValue(null)],
    ["availability", () => vi.mocked(getAvailability).mockResolvedValue(null)],
    ["venue", () => vi.mocked(getVenue).mockResolvedValue(null)],
    ["layout", () => vi.mocked(getLayout).mockResolvedValue(null)],
  ])("null %s triggers notFound", async (_n, arrange) => {
    arrange();
    await expect(PerformancePage(pparams)).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });

  it("metadata: not found title on null, neutral on unavailable", async () => {
    vi.mocked(getPerformance).mockResolvedValue(null);
    expect(title(await perfMeta(pparams))).toMatch(/not found/i);
    vi.mocked(getPerformance).mockRejectedValue(new ApiUnavailable());
    const t = title(await perfMeta(pparams));
    expect(t).toMatch(/unavailable/i);
    expect(t).not.toMatch(/not found/i);
  });

  it.each([
    ["performance", () => vi.mocked(getPerformance).mockRejectedValue(new ApiUnavailable())],
    ["availability", () => vi.mocked(getAvailability).mockRejectedValue(new ApiUnavailable())],
    ["venue", () => vi.mocked(getVenue).mockRejectedValue(new ApiUnavailable())],
    ["layout", () => vi.mocked(getLayout).mockRejectedValue(new ApiUnavailable())],
  ])("unavailable %s renders retry to the same URL", async (_n, arrange) => {
    arrange();
    mount(await PerformancePage(pparams), "t");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      `/venues/${VID}/performances/${PID}`,
    );
    expect(await seriousViolations()).toEqual([]);
  });

  it("non-ApiUnavailable errors propagate", async () => {
    vi.mocked(getAvailability).mockRejectedValue(new Error("boom"));
    await expect(PerformancePage(pparams)).rejects.toThrow("boom");
  });

  it("encodes ids in the retry href", async () => {
    const bad = { params: Promise.resolve({ venueId: "a/b", performanceId: "c d" }) };
    vi.mocked(getPerformance).mockRejectedValue(new ApiUnavailable());
    mount(await PerformancePage(bad), "t");
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      "/venues/a%2Fb/performances/c%20d",
    );
  });

  describe("AC 24 no token, hold id or access-need value in the HTML", () => {
    const LEAK = ["tok_SECRETVALUE", "hold-id-LEAK-123", "need-LEAKED", "idempotency-LEAK"];

    it("page output drops extra fields even if the api layer returned them", async () => {
      vi.mocked(getPerformance).mockResolvedValue({
        ...perf,
        holdToken: LEAK[0],
        holdId: LEAK[1],
      } as never);
      vi.mocked(getAvailability).mockResolvedValue({
        ...availability,
        holds: [{ id: LEAK[1], token: LEAK[0], need: LEAK[2], seatId: uid(2) }],
        accessNeeds: [LEAK[2]],
        idempotencyKey: LEAK[3],
      } as never);
      const markup = renderToStaticMarkup(
        <RootLayout>{await PerformancePage(pparams)}</RootLayout>,
      );
      for (const v of LEAK) expect(markup).not.toContain(v);
      expect(markup).not.toMatch(/holdToken|holdId|accessNeed|idempotency/i);
    });

    it("the contracts reject (strict) such extra fields", async () => {
      const { PerformanceAvailability, PerformanceDetail } = await import("@boxoffice/contracts");
      expect(PerformanceDetail.safeParse({ ...perf, holdToken: LEAK[0] }).success).toBe(false);
      expect(PerformanceAvailability.safeParse({ ...availability, need: LEAK[2] }).success).toBe(
        false,
      );
      expect(
        PerformanceAvailability.safeParse({
          ...availability,
          ga: [{ ...availability.ga[0], holdId: LEAK[1] }],
        }).success,
      ).toBe(false);
      expect(PerformanceDetail.safeParse(perf).success).toBe(true);
      expect(PerformanceAvailability.safeParse(availability).success).toBe(true);
    });

    it("a held access seat shows only as Held", async () => {
      mount(await PerformancePage(pparams), "t");
      const row = [...document.querySelectorAll("tbody tr")].find((r) =>
        /wheelchair/i.test(r.textContent!),
      )!;
      expect([...row.querySelectorAll("td")].at(-1)!.textContent).toBe("Held");
      expect(document.body.innerHTML).not.toMatch(/\bneed\b/i);
    });
  });
});
