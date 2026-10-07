import type { LayoutView } from "@boxoffice/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import LayoutPage, { generateMetadata } from "../app/venues/[venueId]/layouts/[layoutId]/page";
import { ApiUnavailable, getLayout } from "../src/api";
import { SeatMap } from "../src/seat-map/SeatMap";
import { SeatTable } from "../src/seat-map/SeatTable";
import { FEATURE_LABELS, buildModel, type AccessFeatureName } from "../src/seat-map/model";

type Seat = LayoutView["sections"][number]["rows"][number]["seats"][number];
type Section = LayoutView["sections"][number];

const VID = "11111111-1111-4111-8111-111111111111";
const LID = "33333333-3333-4333-8333-333333333333";
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function seat(
  n: number,
  row: string,
  label: string,
  x: number,
  y: number,
  accessFeatures: AccessFeatureName[] = [],
  companionOf: string | null = null,
): Seat {
  return { id: uid(n), rowLabel: row, seatLabel: label, x, y, accessFeatures, companionOf };
}

const fixture: LayoutView = {
  id: LID,
  venueId: VID,
  name: "Test layout",
  sections: [
    {
      id: uid(9001),
      name: "Stalls",
      kind: "reserved",
      gaCapacity: null,
      rows: [
        {
          label: "B",
          seats: [seat(1, "B", "1", 0, 0), seat(2, "B", "2", 1, 0, ["aisle", "extra_legroom"])],
        },
        {
          label: "C",
          seats: [
            seat(3, "C", "12", 5, 1, ["wheelchair_space"]),
            seat(4, "C", "13", 6, 1, [], uid(3)),
            seat(5, "C", "14", 7, 1),
          ],
        },
      ],
    },
    {
      id: uid(9002),
      name: "Circle, upper",
      kind: "reserved",
      gaCapacity: null,
      rows: [
        {
          label: "A",
          seats: [
            seat(6, "A", "1", -2, 10, ["hearing_loop"]),
            seat(7, "A", "2", -1, 10, ["transfer_seat", "step_free"], uid(6)),
          ],
        },
      ],
    },
    { id: uid(9003), name: "Standing", kind: "ga", gaCapacity: 120, rows: [] },
  ],
};

const html = (el: ReactElement) =>
  new DOMParser().parseFromString(`<body>${renderToStaticMarkup(el)}</body>`, "text/html");

// ---- derivation of comparable records from svg and from table ----
const FEATURE_BY_LABEL = Object.fromEntries(
  Object.entries(FEATURE_LABELS).map(([k, v]) => [v, k]),
) as Record<string, AccessFeatureName>;

function fromSvg(doc: Document): string[] {
  const out: string[] = [];
  for (const g of doc.querySelectorAll("svg[role=img] g.seat")) {
    const t = g.querySelector("title")!.textContent!;
    const m = /^(.*?), Row (.+?), Seat (.+?)(?: — .*)?$/.exec(t)!;
    const comp = /companion for (Row .+?, Seat [^;]+)/.exec(t)?.[1] ?? "";
    const feats = (g.getAttribute("data-features") ?? "").split(" ").filter(Boolean).sort();
    out.push([m[1], m[2], m[3], feats.join("+"), comp].join("|"));
  }
  return out.sort();
}

function fromTable(doc: Document): string[] {
  const out: string[] = [];
  for (const sec of doc.querySelectorAll("section")) {
    const tbl = sec.querySelector("table");
    if (!tbl) continue;
    const name = sec.querySelector("h2")!.textContent!;
    for (const tr of tbl.querySelectorAll("tbody tr")) {
      const [row, s, f, c] = [...tr.querySelectorAll("td")].map((d) => d.textContent!);
      const feats =
        f === "None"
          ? []
          : f!
              .split(", ")
              .map((l) => FEATURE_BY_LABEL[l]!)
              .sort();
      const comp = /Companion for (Row .+?, Seat [^;]+)/.exec(c!)?.[1] ?? "";
      out.push([name, row, s, feats.join("+"), comp].join("|"));
    }
  }
  return out.sort();
}

function generated(n: number): LayoutView {
  const perRow = 50;
  const features: AccessFeatureName[][] = [
    [],
    [],
    [],
    ["aisle"],
    ["wheelchair_space"],
    ["hearing_loop", "near_exit"],
  ];
  const rows: Section["rows"] = [];
  for (let r = 0; r * perRow < n; r++) {
    const seats: Seat[] = [];
    for (let k = 0; k < perRow && r * perRow + k < n; k++) {
      const i = r * perRow + k;
      const f = features[i % features.length]!;
      const prevIsWc = k > 0 && features[(i - 1) % features.length]!.includes("wheelchair_space");
      seats.push(seat(i + 1, `R${r + 1}`, String(k + 1), k, r, f, prevIsWc ? uid(i) : null));
    }
    rows.push({ label: `R${r + 1}`, seats });
  }
  return {
    id: LID,
    venueId: VID,
    name: "Big",
    sections: [{ id: uid(99999), name: "Arena", kind: "reserved", gaCapacity: null, rows }],
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("1. model", () => {
  const m = buildModel(fixture);
  const allSeats = m.sections.flatMap((s) => (s.kind === "reserved" ? s.seats : []));

  it("totals and summary", () => {
    expect(m.totals).toEqual({ seats: 7, accessSeats: 4, companionSeats: 2, gaCapacity: 120 });
    expect(m.summary).toBe(
      "Seat map of Test layout: 7 reserved seats, 4 access seats, 2 companion seats, general admission capacity 120",
    );
  });
  it("singular wording and empty / GA-only layouts give finite bounds", () => {
    const one = buildModel({
      ...fixture,
      sections: [
        { ...fixture.sections[0]!, rows: [{ label: "B", seats: [seat(1, "B", "1", 0, 0)] }] },
      ],
    });
    expect(one.summary).toContain("1 reserved seat,");
    expect(one.summary).toContain("0 access seats");
    const empty = buildModel({ ...fixture, sections: [] });
    expect(empty.totals.seats).toBe(0);
    for (const v of Object.values(empty.bounds)) expect(Number.isFinite(v)).toBe(true);
    expect(empty.bounds.width).toBeGreaterThan(0);
    expect(empty.bounds.height).toBeGreaterThan(0);
    const gaOnly = buildModel({ ...fixture, sections: [fixture.sections[2]!] });
    for (const v of Object.values(gaOnly.bounds)) expect(Number.isFinite(v)).toBe(true);
    expect(gaOnly.bounds.height).toBeGreaterThan(0);
  });
  it("companion relation in both directions", () => {
    const by = (l: string) => allSeats.find((s) => s.label === l && s.sectionName === "Stalls")!;
    expect(by("Row C, Seat 13").companionFor).toEqual(["Row C, Seat 12"]);
    expect(by("Row C, Seat 12").companions).toEqual(["Row C, Seat 13"]);
    expect(by("Row C, Seat 14").companions).toEqual([]);
    expect(by("Row C, Seat 14").companionFor).toEqual([]);
    expect(by("Row C, Seat 13").marker).toBe("companion");
    expect(by("Row C, Seat 12").marker).toBe("wheelchair");
  });
  it("bounds cover every seat and the GA area", () => {
    const b = m.bounds;
    for (const s of allSeats) {
      expect(s.x * 10 - 4.5).toBeGreaterThanOrEqual(b.x);
      expect(s.x * 10 + 4.5).toBeLessThanOrEqual(b.x + b.width);
      expect(s.y * 10 - 4.5).toBeGreaterThanOrEqual(b.y);
      expect(s.y * 10 + 4.5).toBeLessThanOrEqual(b.y + b.height);
    }
    const ga = m.sections.find((s) => s.kind === "ga")!;
    if (ga.kind !== "ga") throw new Error("expected ga");
    expect(ga.x * 10).toBeGreaterThanOrEqual(b.x);
    expect((ga.x + ga.width) * 10).toBeLessThanOrEqual(b.x + b.width);
    expect((ga.y + ga.height) * 10).toBeLessThanOrEqual(b.y + b.height);
    expect(ga.y).toBeGreaterThan(Math.max(...allSeats.map((s) => s.y)));
  });
});

describe("2. AC 12 non-colour markers", () => {
  const doc = html(<SeatMap model={buildModel(fixture)} />);
  const svg = doc.querySelector("svg[role=img]")!;
  const seatG = (n: number) => svg.querySelector(`g.seat[data-seat-id="${uid(n)}"]`)!;

  it("svg role=img with summary label", () => {
    expect(doc.querySelectorAll("svg[role=img]")).toHaveLength(1);
    expect(svg.getAttribute("aria-label")).toBe(
      `${buildModel(fixture).summary}. Full details in the seat table below.`,
    );
  });
  it("access seats have shape marker and wordy title; plain are plain", () => {
    const expected: Record<number, [string, string, string[]]> = {
      1: ["plain", "circle", []],
      2: ["access", "polygon", ["aisle seat", "extra legroom"]],
      3: ["wheelchair", "rect", ["wheelchair space", "companion seat Row C, Seat 13"]],
      4: ["companion", "polygon", ["companion for Row C, Seat 12"]],
      5: ["plain", "circle", []],
      6: ["access", "polygon", ["hearing loop", "companion seat Row A, Seat 2"]],
      7: [
        "companion",
        "polygon",
        ["transfer seat", "step-free access", "companion for Row A, Seat 1"],
      ],
    };
    for (const [n, [marker, shape, words]] of Object.entries(expected)) {
      const g = seatG(Number(n));
      expect(g.getAttribute("data-marker")).toBe(marker);
      expect(g.querySelector(shape)).not.toBeNull();
      const t = g.querySelector("title")!.textContent!;
      for (const w of words) expect(t).toContain(w);
      if (marker !== "plain") {
        expect(g.querySelector("circle")).toBeNull();
        expect(g.querySelector("text")!.textContent).toMatch(/^[WAC]$/);
      }
    }
    expect(seatG(3).querySelector("title")!.textContent).toBe(
      "Stalls, Row C, Seat 12 — wheelchair space; companion seat Row C, Seat 13",
    );
    expect(seatG(4).querySelector("title")!.textContent).toBe(
      "Stalls, Row C, Seat 13 — companion for Row C, Seat 12",
    );
    expect(seatG(1).querySelector("title")!.textContent).toBe("Stalls, Row B, Seat 1");
  });
  it("every seat with any feature or companion link is non-plain, and vice versa", () => {
    for (const g of svg.querySelectorAll("g.seat")) {
      const hasInfo =
        (g.getAttribute("data-features") ?? "") !== "" ||
        /companion/.test(g.querySelector("title")!.textContent!);
      expect(g.getAttribute("data-marker") !== "plain").toBe(hasInfo);
    }
  });
  it("GA is a labelled area with title", () => {
    const ga = svg.querySelector("g.ga")!;
    expect(ga.querySelector("rect.ga-area")).not.toBeNull();
    expect(ga.textContent).toContain("Standing");
    expect(ga.textContent).toContain("120");
  });
  it("legend items have visible text and hidden decorative svgs", () => {
    const items = [...doc.querySelectorAll("ul.seatmap-legend li")];
    expect(items).toHaveLength(5);
    for (const li of items)
      expect(li.querySelector("span")!.textContent!.trim().length).toBeGreaterThan(5);
    const all = items.map((l) => l.textContent).join("|");
    expect(all).toMatch(/wheelchair/i);
    expect(all).toMatch(/companion/i);
    expect(all).toMatch(/general admission/i);
    for (const li of items)
      expect(li.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
  it("stylesheet distinguishes GA by dash, not colour only", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
    expect(css).toMatch(/ga-area[^}]*stroke-dasharray/s);
  });
});

describe("3. AC 13 map and table carry the same information", () => {
  it("fixture", () => {
    const model = buildModel(fixture);
    const svg = fromSvg(html(<SeatMap model={model} />));
    const tbl = fromTable(html(<SeatTable model={model} />));
    expect(svg).toHaveLength(7);
    expect(tbl).toHaveLength(7);
    expect(tbl).toEqual(svg);
    expect(svg).toContain("Stalls|C|12|wheelchair_space|");
    expect(svg).toContain("Stalls|C|13||Row C, Seat 12");
    expect(svg).toContain("Circle, upper|A|2|step_free+transfer_seat|Row A, Seat 1");
  });
  it("fixture: GA capacity in table", () => {
    const d = html(<SeatTable model={buildModel(fixture)} />);
    expect(d.body.textContent).toContain("Standing");
    expect(d.body.textContent).toContain("capacity 120");
  });
  it("5,000 seats", () => {
    const model = buildModel(generated(5000));
    expect(model.totals.seats).toBe(5000);
    const svg = fromSvg(html(<SeatMap model={model} />));
    const tbl = fromTable(html(<SeatTable model={model} />));
    expect(svg).toHaveLength(5000);
    expect(tbl).toHaveLength(5000);
    expect(new Set(svg).size).toBe(5000);
    expect(new Set(tbl)).toEqual(new Set(svg));
    expect(tbl).toEqual(svg);
    expect(svg.some((r) => /\|Row R\d+, Seat \d+$/.test(r))).toBe(true);
  }, 60_000);
  it("table markup: caption, th scope=col, focusable labelled region per reserved section", () => {
    const d = html(<SeatTable model={buildModel(fixture)} />);
    expect(d.querySelectorAll("table")).toHaveLength(2);
    for (const t of d.querySelectorAll("table")) {
      expect(t.querySelector("caption")!.textContent!.trim()).not.toBe("");
      t.querySelectorAll("thead th").forEach((th) => expect(th.getAttribute("scope")).toBe("col"));
      const region = t.closest("[role=region]")!;
      expect(region.getAttribute("tabindex")).toBe("0");
      expect(region.getAttribute("aria-label")).toBeTruthy();
    }
    expect(d.querySelectorAll("h2")).toHaveLength(3);
  });
});

describe("4. zoom controls", () => {
  const status = () => screen.getByRole("status").textContent;
  const vb = () => document.querySelector("svg[role=img]")!.getAttribute("viewBox")!;
  const btn = (n: string) => screen.getByRole("button", { name: n }) as HTMLButtonElement;
  const off = (n: string) => btn(n).getAttribute("aria-disabled") === "true";
  const pans = ["Pan left", "Pan right", "Pan up", "Pan down"];

  it("zoom in/out/reset and pan state", () => {
    render(<SeatMap model={buildModel(fixture)} />);
    const v0 = vb();
    expect(status()).toBe("Zoom 100%");
    for (const p of pans) expect(off(p)).toBe(true);
    expect(off("Zoom out")).toBe(true);
    expect(off("Reset")).toBe(true);
    expect(off("Zoom in")).toBe(false);
    for (const b of screen.getAllByRole("button")) expect(b.hasAttribute("disabled")).toBe(false);

    fireEvent.click(btn("Zoom in"));
    expect(status()).toBe("Zoom 150%");
    const v1 = vb();
    expect(v1).not.toBe(v0);
    const w0 = Number(v0.split(" ")[2]);
    const w1 = Number(v1.split(" ")[2]);
    expect(w1).toBeCloseTo(w0 / 1.5, 1);
    for (const p of pans) expect(off(p)).toBe(false);
    expect(off("Zoom out")).toBe(false);
    expect(off("Reset")).toBe(false);

    fireEvent.click(btn("Pan right"));
    expect(vb()).not.toBe(v1);
    fireEvent.click(btn("Zoom out"));
    expect(status()).toBe("Zoom 100%");
    expect(vb()).toBe(v0);
    for (const p of pans) expect(off(p)).toBe(true);

    fireEvent.click(btn("Zoom in"));
    fireEvent.click(btn("Zoom in"));
    fireEvent.click(btn("Pan down"));
    fireEvent.click(btn("Reset"));
    expect(status()).toBe("Zoom 100%");
    expect(vb()).toBe(v0);
  });
  it("caps zoom and pan never leaves bounds", () => {
    render(<SeatMap model={buildModel(fixture)} />);
    const b = buildModel(fixture).bounds;
    for (let i = 0; i < 12; i++) if (!off("Zoom in")) fireEvent.click(btn("Zoom in"));
    expect(off("Zoom in")).toBe(true);
    for (let i = 0; i < 40; i++) {
      fireEvent.click(btn("Pan left"));
      fireEvent.click(btn("Pan up"));
    }
    const [x, y] = vb().split(" ").map(Number);
    expect(x!).toBeGreaterThanOrEqual(b.x - 0.01);
    expect(y!).toBeGreaterThanOrEqual(b.y - 0.01);
    for (let i = 0; i < 80; i++) {
      fireEvent.click(btn("Pan right"));
      fireEvent.click(btn("Pan down"));
    }
    const [x2, y2, w2, h2] = vb().split(" ").map(Number);
    expect(x2! + w2!).toBeLessThanOrEqual(b.x + b.width + 0.05);
    expect(y2! + h2!).toBeLessThanOrEqual(b.y + b.height + 0.05);
  });
  it("clicking an aria-disabled button does nothing", () => {
    render(<SeatMap model={buildModel(fixture)} />);
    const v0 = vb();
    for (const n of ["Zoom out", "Reset", ...pans]) {
      expect(off(n)).toBe(true);
      fireEvent.click(btn(n));
      expect(vb(), n).toBe(v0);
      expect(status(), n).toBe("Zoom 100%");
    }
    for (let i = 0; i < 12; i++) fireEvent.click(btn("Zoom in"));
    expect(off("Zoom in")).toBe(true);
    const vMax = vb();
    const sMax = status();
    fireEvent.click(btn("Zoom in"));
    expect(vb()).toBe(vMax);
    expect(status()).toBe(sMax);
  });
  it("pressed button keeps focus when it becomes aria-disabled at 100%", () => {
    render(<SeatMap model={buildModel(fixture)} />);
    for (const n of ["Reset", "Zoom out"]) {
      fireEvent.click(btn("Zoom in"));
      expect(status()).toBe("Zoom 150%");
      btn(n).focus();
      fireEvent.click(btn(n));
      expect(status()).toBe("Zoom 100%");
      expect(off(n)).toBe(true);
      expect(document.activeElement).toBe(btn(n));
    }
  });
  it("controls are real buttons with names; aria-controls targets the svg", () => {
    render(<SeatMap model={buildModel(fixture)} />);
    const group = screen.getByRole("group", { name: "Seat map view controls" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(7);
    const svgId = document.querySelector("svg[role=img]")!.id;
    expect(svgId).toBeTruthy();
    for (const b of buttons) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
      expect(b.textContent!.trim().length).toBeGreaterThan(0);
      expect(b.getAttribute("aria-controls")).toBe(svgId);
    }
    expect(document.querySelectorAll(`[id="${svgId}"]`)).toHaveLength(1);
  });
});

describe("5. page", () => {
  const params = { params: Promise.resolve({ venueId: VID, layoutId: LID }) };
  beforeEach(() => {
    vi.mocked(getLayout).mockResolvedValue(fixture);
  });

  function mount(page: ReactElement, docTitle: string) {
    const markup = renderToStaticMarkup(<RootLayout>{page}</RootLayout>);
    const parsed = new DOMParser().parseFromString(markup, "text/html");
    document.documentElement.lang = parsed.documentElement.lang;
    document.title = docTitle;
    document.body.innerHTML = parsed.body.innerHTML;
  }
  const serious = async () =>
    (
      await axe.run(document, { rules: { "color-contrast": { enabled: false } } })
    ).violations.filter((v) => v.impact === "serious" || v.impact === "critical");

  it("landmarks, single h1, axe clean, back link, title", async () => {
    const meta = await generateMetadata(params);
    expect(meta.title).toBe("Test layout - Boxoffice admin");
    mount(await LayoutPage(params), meta.title as string);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(document.querySelector("h1")!.textContent).toBe("Test layout");
    expect(document.querySelectorAll("main")).toHaveLength(1);
    expect(document.querySelectorAll("header")).toHaveLength(1);
    expect(document.querySelectorAll("nav[aria-label]")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Back to venue" }).getAttribute("href")).toBe(
      `/venues/${VID}`,
    );
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain(
      "Full details in the seat table below.",
    );
    const levels = [...document.querySelectorAll("h1,h2,h3")].map((h) => Number(h.tagName[1]));
    levels.forEach((l, i) => i > 0 && expect(l - levels[i - 1]!).toBeLessThanOrEqual(1));
    expect(await serious()).toEqual([]);
  });
  it("axe clean for a 600-seat layout too", async () => {
    vi.mocked(getLayout).mockResolvedValue(generated(600));
    mount(await LayoutPage(params), "t");
    expect(await serious()).toEqual([]);
  }, 120_000);
  it("ApiUnavailable renders service-unavailable with retry link, neutral title", async () => {
    vi.mocked(getLayout).mockImplementation(() => Promise.reject(new ApiUnavailable()));
    const meta = await generateMetadata(params);
    expect(meta.title as string).toMatch(/unavailable/i);
    expect(meta.title as string).not.toMatch(/not found/i);
    mount(await LayoutPage(params), meta.title as string);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Something went wrong");
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      `/venues/${VID}/layouts/${LID}`,
    );
    expect(await serious()).toEqual([]);
  });
  it("404 -> notFound and not-found title", async () => {
    vi.mocked(getLayout).mockResolvedValue(null);
    await expect(LayoutPage(params)).rejects.toMatchObject({
      digest: expect.stringContaining("404"),
    });
    expect((await generateMetadata(params)).title as string).toMatch(/not found/i);
  });
  it("other errors propagate", async () => {
    vi.mocked(getLayout).mockImplementation(() => Promise.reject(new Error("boom")));
    await expect(LayoutPage(params)).rejects.toThrow("boom");
  });
});
