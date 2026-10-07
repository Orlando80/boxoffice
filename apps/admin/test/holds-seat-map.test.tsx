import type { LayoutView } from "@boxoffice/contracts";
import axe from "axe-core";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RootLayout from "../app/layout";
import { SeatMap } from "../src/seat-map/SeatMap";
import { SeatTable } from "../src/seat-map/SeatTable";
import { buildModel, type AccessFeatureName } from "../src/seat-map/model";

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

const html = (el: ReactElement) =>
  new DOMParser().parseFromString(`<body>${renderToStaticMarkup(el)}</body>`, "text/html");

const avail = (
  heldSeatIds: string[],
  ga: { sectionId: string; held: number; capacity: number }[] = [],
) => ({
  performanceId: uid(777),
  asOf: "2026-10-25T13:05:09.000Z",
  heldSeatIds,
  ga,
});

describe("held state (AC 22)", () => {
  // 1 plain, 3 wheelchair + 4 its companion, 7 companion of a non-held access seat
  const heldIds = [uid(1), uid(3), uid(4), uid(7)];
  const model = buildModel(
    fixture,
    avail(heldIds, [{ sectionId: uid(9003), held: 40, capacity: 120 }]),
  );
  const doc = html(<SeatMap model={model} />);
  const svg = doc.querySelector("svg[role=img]")!;
  const g = (n: number) => svg.querySelector(`g.seat[data-seat-id="${uid(n)}"]`)!;
  const seatsOf = () => model.sections.flatMap((s) => (s.kind === "reserved" ? s.seats : []));

  it("every held seat has data-held, hatch overlay, glyph and 'held' in title; others none", () => {
    for (const el of svg.querySelectorAll("g.seat")) {
      const id = el.getAttribute("data-seat-id")!;
      const isHeld = heldIds.includes(id);
      expect(el.getAttribute("data-held") === "true").toBe(isHeld);
      expect(el.hasAttribute("data-held")).toBe(isHeld);
      expect(el.querySelector("g.held-overlay") !== null).toBe(isHeld);
      expect(/\bheld\b/.test(el.querySelector("title")!.textContent!)).toBe(isHeld);
      const glyphs = [...el.querySelectorAll("text.held-glyph")];
      expect(glyphs.length).toBe(isHeld ? 1 : 0);
      if (isHeld) expect(glyphs[0]!.textContent).toBe("H");
    }
    expect(svg.querySelectorAll("[data-held=true]")).toHaveLength(4);
  });

  it("hatch pattern defined once and referenced by the css fill", async () => {
    expect(svg.querySelectorAll("pattern#held-hatch")).toHaveLength(1);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
    expect(css).toMatch(/held-overlay[^{]*\{[^}]*url\(#held-hatch\)/s);
  });

  it("held access seat and companion keep their markers AND show held", () => {
    expect(g(3).getAttribute("data-marker")).toBe("wheelchair");
    expect(g(3).querySelector("text:not(.held-glyph)")!.textContent).toBe("W");
    expect(g(3).querySelector("title")!.textContent).toBe(
      "Stalls, Row C, Seat 12 — wheelchair space; held; companion seat Row C, Seat 13",
    );
    expect(g(4).getAttribute("data-marker")).toBe("companion");
    expect(g(4).querySelector("text:not(.held-glyph)")!.textContent).toBe("C");
    const t4 = g(4).querySelector("title")!.textContent!;
    expect(t4).toContain("held");
    expect(t4).toContain("companion for Row C, Seat 12");
    expect(g(7).getAttribute("data-marker")).toBe("companion");
    expect(g(7).getAttribute("data-held")).toBe("true");
    expect(g(6).getAttribute("data-held")).toBeNull();
  });

  it("held overlay shape matches marker shape", () => {
    expect(g(3).querySelector("g.held-overlay rect")).not.toBeNull();
    expect(g(4).querySelector("g.held-overlay polygon")).not.toBeNull();
    expect(g(1).querySelector("g.held-overlay circle")).not.toBeNull();
  });

  it("table Status matches the map for every seat", () => {
    const t = html(<SeatTable model={model} />);
    const mapStatus = new Map(
      [...svg.querySelectorAll("g.seat")].map((s) => [
        s.getAttribute("data-seat-id")!,
        s.getAttribute("data-held") === "true" ? "Held" : "Available",
      ]),
    );
    const byLabel = new Map(seatsOf().map((s) => [`${s.sectionName}|${s.label}`, s.id]));
    let n = 0;
    for (const sec of t.querySelectorAll("section")) {
      if (!sec.querySelector("table")) continue;
      const name = sec.querySelector("h2")!.textContent!;
      const heads = [...sec.querySelectorAll("thead th")].map((h) => h.textContent);
      expect(heads.at(-1)).toBe("Status");
      for (const tr of sec.querySelectorAll("tbody tr")) {
        const cells = [...tr.querySelectorAll("th,td")].map((d) => d.textContent!);
        const id = byLabel.get(`${name}|Row ${cells[0]}, Seat ${cells[1]}`)!;
        expect(id, `${name} ${cells[0]} ${cells[1]}`).toBeDefined();
        expect(cells.at(-1)).toBe(mapStatus.get(id));
        n++;
      }
    }
    expect(n).toBe(7);
  });

  it("GA 'N of M held' in map (label and title) and table", () => {
    const ga = svg.querySelector("g.ga")!;
    expect(ga.querySelector("text")!.textContent).toBe("Standing - 40 of 120 held");
    expect(ga.querySelector("title")!.textContent).toContain("40 of 120 held");
    const t = html(<SeatTable model={model} />);
    expect(t.body.textContent).toContain("General admission, capacity 120, 40 of 120 held.");
  });

  it("legend gains one 'Held (hatched)' item; summary reports held totals", () => {
    const items = [...doc.querySelectorAll("ul.seatmap-legend li")];
    expect(items).toHaveLength(6);
    const held = items.filter((l) => /Held/.test(l.textContent!));
    expect(held).toHaveLength(1);
    expect(held[0]!.textContent).toContain("Held (hatched)");
    expect(held[0]!.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(model.summary).toBe(
      "Seat map of Test layout: 7 reserved seats, 4 access seats, 2 companion seats, general admission capacity 120; 4 reserved seats held, 40 general admission places held",
    );
    expect(model.heldTotals).toEqual({ seats: 4, ga: 40 });
  });

  it("singular wording, unknown ids ignored, empty availability still shows held UI", () => {
    const one = buildModel(
      fixture,
      avail([uid(1), uid(424242)], [{ sectionId: uid(9003), held: 1, capacity: 120 }]),
    );
    expect(one.summary).toContain("1 reserved seat held, 1 general admission place held");
    expect(one.heldTotals.seats).toBe(1);
    const none = buildModel(fixture, avail([]));
    expect(none.showHeld).toBe(true);
    expect(none.summary).toContain("0 reserved seats held, 0 general admission places held");
    const d = html(<SeatMap model={none} />);
    expect(d.querySelector("g.ga text")!.textContent).toBe("Standing - 0 of 120 held");
  });

  it("without availability the rendering is unchanged", () => {
    const plain = buildModel(fixture);
    expect(plain.showHeld).toBe(false);
    expect(plain.summary).toBe(
      "Seat map of Test layout: 7 reserved seats, 4 access seats, 2 companion seats, general admission capacity 120",
    );
    const d = html(<SeatMap model={plain} />);
    expect(d.querySelectorAll("[data-held]")).toHaveLength(0);
    expect(d.querySelectorAll("pattern")).toHaveLength(0);
    expect(d.querySelectorAll("g.held-overlay,text.held-glyph")).toHaveLength(0);
    expect(d.querySelectorAll("ul.seatmap-legend li")).toHaveLength(5);
    expect(d.body.textContent).not.toMatch(/held/i);
    const t = html(<SeatTable model={plain} />);
    expect(t.body.textContent).not.toMatch(/held|Status|Available/i);
    expect(t.querySelectorAll("table")[0]!.querySelectorAll("thead th")).toHaveLength(4);
    expect(t.body.textContent).toContain("General admission, capacity 120.");
    expect(renderToStaticMarkup(<SeatMap model={buildModel(fixture, undefined)} />)).toBe(
      renderToStaticMarkup(<SeatMap model={plain} />),
    );
  });

  it("held glyph stays inside its own seat cell (does not overlap the next row or column)", () => {
    const problems: string[] = [];
    for (const el of svg.querySelectorAll("g.seat[data-held=true]")) {
      const t = el.querySelector("text.held-glyph")!;
      const s = seatsOf().find((m) => m.id === el.getAttribute("data-seat-id"))!;
      const cx = s.x * 10;
      const cy = s.y * 10;
      const x = Number(t.getAttribute("x"));
      const y = Number(t.getAttribute("y"));
      const size = Number(t.getAttribute("font-size"));
      // seat pitch is 10 units, so a 4.5 half-extent keeps clear of neighbours
      if (y > cy + 4.5) problems.push(`${s.label}: baseline ${y - cy} below seat edge 4.5`);
      if (y - 0.7 * size < cy - 4.5) problems.push(`${s.label}: top above seat`);
      if (x + 0.35 * size > cx + 5) problems.push(`${s.label}: right edge into next column`);
    }
    expect(problems).toEqual([]);
  });

  it("axe clean for the held map plus table (static markup)", async () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <h1>Held</h1>
        <SeatMap model={model} />
        <SeatTable model={model} />
      </RootLayout>,
    );
    const parsed = new DOMParser().parseFromString(markup, "text/html");
    document.documentElement.lang = "en-GB";
    document.title = "t";
    document.body.innerHTML = parsed.body.innerHTML;
    const res = await axe.run(document, { rules: { "color-contrast": { enabled: false } } });
    expect(res.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
      [],
    );
  });
});

describe("held large layout parity", () => {
  it("1,200 seats with mixed held seats: map and table agree seat for seat", () => {
    const layout = generated(1200);
    const ids = layout.sections[0]!.rows.flatMap((r) => r.seats.map((s) => s.id));
    const held = new Set(ids.filter((_, i) => i % 7 === 0 || i % 11 === 3));
    const model = buildModel(layout, avail([...held]));
    expect(model.heldTotals.seats).toBe(held.size);
    const svgDoc = html(<SeatMap model={model} />);
    const gs = [...svgDoc.querySelectorAll("svg[role=img] g.seat")];
    expect(gs).toHaveLength(1200);
    expect(gs.filter((x) => x.getAttribute("data-held") === "true")).toHaveLength(held.size);
    for (const x of gs)
      expect(x.getAttribute("data-held") === "true").toBe(
        held.has(x.getAttribute("data-seat-id")!),
      );
    const tDoc = html(<SeatTable model={model} />);
    const statuses = [...tDoc.querySelectorAll("tbody tr")].map(
      (tr) => [...tr.querySelectorAll("td")].at(-1)!.textContent,
    );
    expect(statuses).toHaveLength(1200);
    // both follow model seat order, so index-wise comparison is seat-for-seat
    expect(statuses).toEqual(
      gs.map((x) => (x.getAttribute("data-held") === "true" ? "Held" : "Available")),
    );
    // markers survive alongside held
    const wc = gs.filter(
      (x) => x.getAttribute("data-marker") === "wheelchair" && x.hasAttribute("data-held"),
    );
    expect(wc.length).toBeGreaterThan(0);
    for (const x of wc) expect(x.querySelector("text:not(.held-glyph)")!.textContent).toBe("W");
  }, 60_000);
});

describe("hatch contrast (A11Y-4: UI parts 3:1)", () => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  it("hatch and outline colour vs every seat fill and the page background", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const css = fs.readFileSync(path.resolve(__dirname, "../app/globals.css"), "utf8");
    const hatch = /\.held-hatch-line\s*\{[^}]*stroke:\s*(#[0-9a-f]{6})/i.exec(css)![1]!;
    const outline = /\.held-overlay polygon\s*\{[^}]*stroke:\s*(#[0-9a-f]{6})/i.exec(css)![1]!;
    const fills = [
      ...css.matchAll(
        /\.seat(?:-\w+)?\s+(?:circle|rect|polygon)\s*\{[^}]*fill:\s*(#[0-9a-f]{6})/gi,
      ),
    ].map((m) => m[1]!);
    const bg = /--bg:\s*(#[0-9a-f]{6})/i.exec(css)![1]!;
    expect(fills.length).toBeGreaterThanOrEqual(4);
    for (const c of [hatch, outline])
      for (const f of [...fills, bg]) expect(ratio(c, f), `${c} vs ${f}`).toBeGreaterThanOrEqual(3);
  });
});

describe("glyph boxes (round 2)", () => {
  const box = (t: Element, cx: number, cy: number) => {
    const x = Number(t.getAttribute("x")) - cx;
    const y = Number(t.getAttribute("y")) - cy;
    const s = Number(t.getAttribute("font-size"));
    return { l: x - 0.35 * s, r: x + 0.35 * s, t: y - 0.7 * s, b: y };
  };
  const model = buildModel(
    fixture,
    avail([uid(3), uid(4), uid(2), uid(6)]),
  );
  const svg = html(<SeatMap model={model} />).querySelector("svg[role=img]")!;
  const all = model.sections.flatMap((s) => (s.kind === "reserved" ? s.seats : []));

  it("marker glyph and H do not overlap and both stay in the seat's 9x9 box, for W, C and A", () => {
    for (const n of [3, 4, 2]) {
      const s = all.find((m) => m.id === uid(n))!;
      const g = svg.querySelector(`g.seat[data-seat-id="${uid(n)}"]`)!;
      const m = box(g.querySelector("text:not(.held-glyph)")!, s.x * 10, s.y * 10);
      const h = box(g.querySelector("text.held-glyph")!, s.x * 10, s.y * 10);
      const overlap = m.l < h.r && h.l < m.r && m.t < h.b && h.t < m.b;
      expect(overlap, `seat ${n}`).toBe(false);
      for (const b of [m, h]) {
        expect(b.l).toBeGreaterThanOrEqual(-4.5);
        expect(b.r).toBeLessThanOrEqual(4.5);
        expect(b.t).toBeGreaterThanOrEqual(-4.5);
        expect(b.b).toBeLessThanOrEqual(4.5);
      }
    }
  });
  it("unheld marker glyphs keep the original position (baseline cy+2, size 5.5)", () => {
    const s = all.find((m) => m.id === uid(7))!;
    const unheld = html(<SeatMap model={buildModel(fixture, avail([]))} />).querySelector(
      "svg[role=img]",
    )!;
    const plain = html(<SeatMap model={buildModel(fixture)} />).querySelector("svg[role=img]")!;
    for (const root of [unheld, plain]) {
      const t = root.querySelector(`g.seat[data-seat-id="${uid(7)}"] text`)!;
      expect(Number(t.getAttribute("y"))).toBe(s.y * 10 + 2);
      expect(t.getAttribute("font-size")).toBe("5.5");
      expect(root.querySelectorAll("text.held-glyph")).toHaveLength(0);
    }
  });
});
