import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import ErrorPage from "../app/error";
import RootLayout, { metadata as layoutMetadata, viewport } from "../app/layout";
import NotFound, { metadata as notFoundMetadata } from "../app/not-found";
import HomePage, { metadata as homeMetadata } from "../app/page";
import EventPage, {
  generateMetadata as eventMeta,
} from "../app/venues/[venueId]/events/[eventId]/page";
import VenuePage, { generateMetadata as venueMeta } from "../app/venues/[venueId]/page";
import { ApiUnavailable, getEvent, getVenue, getVenues } from "../src/api";

const VID = "11111111-1111-4111-8111-111111111111";
const EID = "22222222-2222-4222-8222-222222222222";
const LID = "33333333-3333-4333-8333-333333333333";
const L2 = "44444444-4444-4444-8444-444444444444";

const venueSummary = { id: VID, name: "Test Hall", slug: "test-hall", timeZone: "Europe/London" };
const venueDetail = {
  venue: venueSummary,
  layouts: [
    { id: LID, name: "Stalls only" },
    { id: L2, name: "Full house" },
  ],
  events: [
    {
      id: EID,
      slug: "test-play",
      name: "Test Play",
      runningTimeMinutes: 120,
      ageGuidance: "12+",
    },
  ],
};
const eventDetail = {
  ...venueDetail.events[0]!,
  description: "A play for testing.",
  performances: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      startsAt: "2026-10-25T19:30:00.000Z",
      layoutId: LID,
      accessTags: ["relaxed", "bsl_interpreted"],
    },
    {
      id: "66666666-6666-4666-8666-666666666666",
      startsAt: "2026-10-24T18:30:00.000Z",
      layoutId: L2,
      accessTags: [],
    },
  ],
};

const params = { params: Promise.resolve({ venueId: VID, eventId: EID }) };

/** Compose layout + page as static markup, load into the jsdom document. */
function mount(page: ReactElement, docTitle: string) {
  const markup = renderToStaticMarkup(<RootLayout>{page}</RootLayout>);
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  document.documentElement.lang = parsed.documentElement.lang;
  document.title = docTitle;
  document.body.innerHTML = parsed.body.innerHTML;
}

async function seriousViolations() {
  const results = await axe.run(document, {
    // jsdom has no layout engine; colour contrast cannot be computed here.
    rules: { "color-contrast": { enabled: false } },
  });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

function expectBaseline() {
  expect(document.querySelectorAll("h1")).toHaveLength(1);
  expect(document.querySelector("h1")!.textContent!.trim().length).toBeGreaterThan(0);
  expect(document.querySelectorAll("main")).toHaveLength(1);
  expect(document.querySelectorAll("header")).toHaveLength(1);
  expect(document.querySelectorAll("nav[aria-label]")).toHaveLength(1);
  expect(document.documentElement.lang).toBe("en-GB");
  expect(document.title.trim().length).toBeGreaterThan(0);
}

beforeEach(() => {
  vi.mocked(getVenues).mockResolvedValue([venueSummary]);
  vi.mocked(getVenue).mockResolvedValue(venueDetail);
  vi.mocked(getEvent).mockResolvedValue(eventDetail as never);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const title = (m: { title?: unknown }) => m.title as string;

describe("layout", () => {
  it("has a string title and zoom-safe viewport", () => {
    expect(title(layoutMetadata).trim()).not.toBe("");
    const v = viewport as Record<string, unknown>;
    expect(v.userScalable).toBeUndefined();
    expect(v.maximumScale).toBeUndefined();
    expect(v.initialScale).toBe(1);
  });

  it("skip link is the first focusable element and targets #main", async () => {
    mount(await HomePage(), "t");
    const focusables = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusables[0]!;
    expect(first.tagName).toBe("A");
    expect(first.getAttribute("href")).toBe("#main");
    expect(first.textContent).toMatch(/skip/i);
    const target = document.querySelector("#main")!;
    expect(target.tagName).toBe("MAIN");
    expect(document.querySelectorAll("#main")).toHaveLength(1);
    expect(first.compareDocumentPosition(document.querySelector("header")!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("home page", () => {
  it("lists venues, dev note, one h1, landmarks, title, no axe violations", async () => {
    mount(await HomePage(), title(homeMetadata));
    expectBaseline();
    expect(title(homeMetadata)).toMatch(/venue/i);
    expect(screen.getByRole("link", { name: "Test Hall" }).getAttribute("href")).toBe(
      `/venues/${VID}`,
    );
    expect(document.body.textContent).toContain("Development venue picker — replaced by sign-in");
    expect(await seriousViolations()).toEqual([]);
  });
  it("renders an empty state", async () => {
    vi.mocked(getVenues).mockResolvedValue([]);
    mount(await HomePage(), "t");
    expect(document.body.textContent).toContain("There are no venues yet.");
    expect(document.querySelectorAll("ul")).toHaveLength(0);
    expect(await seriousViolations()).toEqual([]);
  });
  it("propagates api failure so the error boundary renders", async () => {
    vi.mocked(getVenues).mockRejectedValue(new Error("The api is unavailable"));
    await expect(HomePage()).rejects.toThrow();
  });
});

describe("venue page", () => {
  it("shows name, time zone, layouts and events; metadata; axe clean", async () => {
    const meta = await venueMeta(params);
    expect(title(meta)).toContain("Test Hall");
    mount(await VenuePage(params), title(meta));
    expectBaseline();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Test Hall");
    expect(document.body.textContent).toContain("Europe/London");
    expect(screen.getByRole("link", { name: "Stalls only" }).getAttribute("href")).toBe(
      `/venues/${VID}/layouts/${LID}`,
    );
    expect(screen.getByRole("link", { name: "Test Play" }).getAttribute("href")).toBe(
      `/venues/${VID}/events/${EID}`,
    );
    expect(await seriousViolations()).toEqual([]);
  });
  it("empty layouts and events", async () => {
    vi.mocked(getVenue).mockResolvedValue({ ...venueDetail, layouts: [], events: [] });
    mount(await VenuePage(params), "t");
    expect(document.body.textContent).toContain("No layouts.");
    expect(document.body.textContent).toContain("No events.");
    expect(await seriousViolations()).toEqual([]);
  });
  it("unknown venue triggers notFound (page) and a not-found title", async () => {
    vi.mocked(getVenue).mockResolvedValue(null);
    await expect(VenuePage(params)).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect(title(await venueMeta(params))).toMatch(/not found/i);
  });
});

describe("event page", () => {
  it("renders details, table semantics, venue-zone times, tag text; axe clean", async () => {
    const meta = await eventMeta(params);
    expect(title(meta)).toContain("Test Play");
    mount(await EventPage(params), title(meta));
    expectBaseline();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Test Play");
    expect(document.body.textContent).toContain("120 minutes");
    expect(document.body.textContent).toContain("12+");
    expect(document.body.textContent).toContain("A play for testing.");

    const table = screen.getByRole("table");
    expect(table.querySelector("caption")!.textContent!.trim()).not.toBe("");
    const colHeads = [...table.querySelectorAll("thead th")];
    expect(colHeads.length).toBeGreaterThan(0);
    colHeads.forEach((th) => expect(th.getAttribute("scope")).toBe("col"));
    table
      .querySelectorAll("tbody th")
      .forEach((th) => expect(th.getAttribute("scope")).toBe("row"));

    const rowHeads = [...table.querySelectorAll("tbody th")].map((t) => t.textContent);
    expect(rowHeads).toContain("Sun 25 Oct 2026, 19:30");
    // 2026-10-24T18:30Z is BST (UTC+1) -> 19:30 local
    expect(rowHeads).toContain("Sat 24 Oct 2026, 19:30");

    expect(table.textContent).toContain("Relaxed");
    expect(table.textContent).toContain("BSL interpreted");
    expect(table.textContent).toContain("None");
    expect(await seriousViolations()).toEqual([]);
  });
  it("uses the venue zone, not the runtime zone", async () => {
    vi.mocked(getVenue).mockResolvedValue({
      ...venueDetail,
      venue: { ...venueSummary, timeZone: "America/New_York" },
    });
    mount(await EventPage(params), "t");
    expect(document.body.textContent).toContain("Sat 24 Oct 2026, 14:30");
  });
  it("null running time / age / description render without 'null'", async () => {
    vi.mocked(getEvent).mockResolvedValue({
      ...eventDetail,
      runningTimeMinutes: null,
      ageGuidance: null,
      description: null,
      performances: [],
    } as never);
    mount(await EventPage(params), "t");
    expect(document.body.textContent).not.toMatch(/null|undefined/);
    expect(await seriousViolations()).toEqual([]);
  });
  it("unknown event or venue triggers notFound", async () => {
    vi.mocked(getEvent).mockResolvedValue(null);
    await expect(EventPage(params)).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect(title(await eventMeta(params))).toMatch(/not found/i);
    vi.mocked(getEvent).mockResolvedValue(eventDetail as never);
    vi.mocked(getVenue).mockResolvedValue(null);
    await expect(EventPage(params)).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });
  it("performance whose layout is missing from the venue list still renders", async () => {
    vi.mocked(getVenue).mockResolvedValue({ ...venueDetail, layouts: [] });
    mount(await EventPage(params), "t");
    expect(screen.getAllByRole("link", { name: "Layout" }).length).toBe(2);
  });
});

describe("error page", () => {
  it("has one h1, retry button that calls reset, no error text; axe clean", async () => {
    const reset = vi.fn();
    const secret = new Error("ECONNREFUSED secret-host.internal:4000");
    const { container } = render(<ErrorPage error={secret} reset={reset} />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(container.textContent).not.toContain("ECONNREFUSED");
    expect(container.textContent).not.toContain("secret-host");
    const btn = screen.getByRole("button", { name: "Try again" });
    expect(btn.getAttribute("type")).toBe("button");
    fireEvent.click(btn);
    expect(reset).toHaveBeenCalledTimes(1);
    cleanup();
    mount(<ErrorPage error={secret} reset={reset} />, "Error - Boxoffice admin");
    expectBaseline();
    expect(await seriousViolations()).toEqual([]);
  });
});

describe("not-found page", () => {
  it("has title metadata, one h1, a way home; axe clean", async () => {
    expect(title(notFoundMetadata).trim()).not.toBe("");
    mount(<NotFound />, title(notFoundMetadata));
    expectBaseline();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Page not found");
    expect(screen.getByRole("link", { name: "Back to venues" }).getAttribute("href")).toBe("/");
    expect(await seriousViolations()).toEqual([]);
  });
});

describe("api unavailable state", () => {
  const down = () => new ApiUnavailable();
  const cases: [string, () => Promise<ReactElement>, string, () => Promise<{ title?: unknown }>][] =
    [
      ["home", () => HomePage(), "/", async () => homeMetadata],
      ["venue", () => VenuePage(params), `/venues/${VID}`, () => venueMeta(params)],
      ["event", () => EventPage(params), `/venues/${VID}/events/${EID}`, () => eventMeta(params)],
    ];

  it.each(cases)(
    "%s page renders an in-layout error with a retry link",
    async (name, page, href, meta) => {
      vi.mocked(getVenues).mockRejectedValue(down());
      vi.mocked(getVenue).mockRejectedValue(down());
      vi.mocked(getEvent).mockRejectedValue(down());
      const docTitle = name === "home" ? title(homeMetadata) : title(await meta());
      mount(await page(), docTitle);
      expectBaseline();
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
      const retry = screen.getByRole("link", { name: "Try again" });
      expect(retry.getAttribute("href")).toBe(href);
      expect(document.querySelector("main")!.contains(retry)).toBe(true);
      const first = document.querySelector<HTMLElement>("a[href], button")!;
      expect(first.getAttribute("href")).toBe("#main");
      expect(await seriousViolations()).toEqual([]);
    },
  );

  it.each([
    ["venue", () => venueMeta(params)],
    ["event", () => eventMeta(params)],
  ])("%s metadata title is neutral when the api is down", async (_n, meta) => {
    vi.mocked(getVenue).mockRejectedValue(down());
    vi.mocked(getEvent).mockRejectedValue(down());
    const t = title(await meta());
    expect(t).toMatch(/unavailable/i);
    expect(t).not.toMatch(/not found/i);
  });

  it("encodes the venue id in the retry href", async () => {
    vi.mocked(getVenue).mockRejectedValue(down());
    const bad = { params: Promise.resolve({ venueId: "a/b c", eventId: EID }) };
    mount(await VenuePage(bad), "t");
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      "/venues/a%2Fb%20c",
    );
  });

  it("non-ApiUnavailable errors still propagate to the error boundary", async () => {
    vi.mocked(getVenues).mockRejectedValue(new Error("boom"));
    vi.mocked(getVenue).mockRejectedValue(new Error("boom"));
    vi.mocked(getEvent).mockRejectedValue(new Error("boom"));
    await expect(HomePage()).rejects.toThrow("boom");
    await expect(VenuePage(params)).rejects.toThrow("boom");
    await expect(EventPage(params)).rejects.toThrow("boom");
  });

  it("a real 404 still gives not-found, not the unavailable state", async () => {
    vi.mocked(getVenue).mockResolvedValue(null);
    await expect(VenuePage(params)).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect(title(await venueMeta(params))).toBe("Venue not found");
  });
});
