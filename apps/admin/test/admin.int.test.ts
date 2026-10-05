import AxeBuilder from "@axe-core/playwright";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startStack, type Stack } from "./support/stack";

const THEATRE = "Harbour Lane Theatre (Example)";
const ARENA = "Northgate Arena (Example)";
const fileStart = Date.now();

let stack: Stack;
let browser: Browser;
let context: BrowserContext;
let theatreUrl: string;
let theatreLayoutUrl: string;
let theatreEventUrl: string;
let arenaLayoutUrl: string;

async function get<T>(p: string): Promise<T> {
  return (await (await fetch(`${stack.apiUrl}${p}`)).json()) as T;
}

async function newPage(width = 1280, height = 800): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  return page;
}

async function seriousViolations(page: Page) {
  const res = await new AxeBuilder({ page }).analyze();
  return res.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target) }));
}

/** Describes the focused element and whether its focus indicator is visible and unobscured. */
async function focusState(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { name: "", visible: false, why: "body focused" };
    const cs = getComputedStyle(el);
    const hasIndicator =
      (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) ||
      (cs.boxShadow !== "" && cs.boxShadow !== "none");
    const r = el.getBoundingClientRect();
    const x1 = Math.max(r.left, 0);
    const y1 = Math.max(r.top, 0);
    const x2 = Math.min(r.right, window.innerWidth);
    const y2 = Math.min(r.bottom, window.innerHeight);
    const inViewport = x2 > x1 && y2 > y1;
    let unobscured = false;
    if (inViewport) {
      // Probe points of the visible part (the element may be taller than the viewport).
      const pts = [
        [(x1 + x2) / 2, (y1 + y2) / 2],
        [x1 + 2, y1 + 2],
      ] as const;
      unobscured = pts.some(([px, py]) => {
        const top = document.elementFromPoint(px, py);
        return top !== null && (top === el || el.contains(top));
      });
    }
    const name =
      (el.getAttribute("aria-label") ?? "") ||
      (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    return {
      name,
      visible: hasIndicator && inViewport && unobscured,
      why: JSON.stringify({
        outline: cs.outlineStyle,
        shadow: cs.boxShadow,
        inViewport,
        unobscured,
      }),
    };
  });
}

async function expectFocusVisible(page: Page, step: string) {
  const s = await focusState(page);
  expect(s.visible, `focus not visible at "${step}" on "${s.name}": ${s.why}`).toBe(true);
  return s;
}

/** Presses Tab (or Shift+Tab) until the focused element's name matches; checks focus each step. */
async function tabTo(page: Page, match: RegExp, step: string, key = "Tab", max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(key);
    const s = await expectFocusVisible(page, `${step} (after ${i + 1} ${key})`);
    if (match.test(s.name)) return s;
  }
  throw new Error(`Never reached ${match} by keyboard for step "${step}"`);
}

beforeAll(async () => {
  stack = await startStack();
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ locale: "en-GB" });
    const venues = await get<{ id: string; name: string }[]>("/venues");
    const theatre = venues.find((v) => v.name === THEATRE)!;
    const arena = venues.find((v) => v.name === ARENA)!;
    theatreUrl = `${stack.adminUrl}/venues/${theatre.id}`;
    const td = await get<{ layouts: { id: string }[]; events: { id: string }[] }>(
      `/venues/${theatre.id}`,
    );
    theatreLayoutUrl = `${theatreUrl}/layouts/${td.layouts[0]!.id}`;
    theatreEventUrl = `${theatreUrl}/events/${td.events[0]!.id}`;
    const ad = await get<{ layouts: { id: string }[] }>(`/venues/${arena.id}`);
    arenaLayoutUrl = `${stack.adminUrl}/venues/${arena.id}/layouts/${ad.layouts[0]!.id}`;
  } catch (e) {
    await browser?.close();
    await stack.stop();
    throw e;
  }
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
  console.log(
    `[timing] admin.int.test.ts total: ${((Date.now() - fileStart) / 1000).toFixed(1)} s`,
  );
});

describe("AC 10: axe in Chromium (colour contrast included)", () => {
  it.each([
    ["home", () => `${stack.adminUrl}/`],
    ["venue", () => theatreUrl],
    ["event", () => theatreEventUrl],
    ["theatre layout (map + table)", () => theatreLayoutUrl],
    ["arena layout (map + table)", () => arenaLayoutUrl],
  ])(
    "%s has no serious or critical violations",
    async (_n, url) => {
      const page = await newPage();
      await page.goto(url());
      expect(await page.locator("h1").count()).toBe(1);
      expect(await seriousViolations(page)).toEqual([]);
      await page.close();
    },
    300_000,
  );

  it("theatre layout stays clean after zooming in", async () => {
    const page = await newPage();
    await page.goto(theatreLayoutUrl);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    expect(await seriousViolations(page)).toEqual([]);
    await page.close();
  });
});

describe("AC 11: keyboard-only path", () => {
  it("skip link is the first Tab stop and moves focus to main", async () => {
    const page = await newPage();
    await page.goto(`${stack.adminUrl}/`);
    await page.keyboard.press("Tab");
    const s = await expectFocusVisible(page, "skip link");
    expect(s.name).toBe("Skip to main content");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
    await page.close();
  });

  it("home -> theatre -> layout -> zoom in/out -> access seat and companion rows", async () => {
    const page = await newPage();
    await page.goto(`${stack.adminUrl}/`);

    await tabTo(page, /^Harbour Lane Theatre/, "theatre link");
    await Promise.all([page.waitForURL(/\/venues\/[^/]+$/), page.keyboard.press("Enter")]);
    expect(await page.locator("h1").innerText()).toBe(THEATRE);

    await tabTo(page, /^End-on/, "layout link");
    expect(await page.evaluate(() => (document.activeElement as HTMLAnchorElement).href)).toMatch(
      /\/layouts\//,
    );
    await Promise.all([page.waitForURL(/\/layouts\//), page.keyboard.press("Enter")]);
    await page.getByRole("button", { name: "Zoom in" }).waitFor();
    // Buttons only work once the client component is hydrated.
    await page.waitForFunction(() =>
      Object.keys(document.querySelector("button") ?? {}).some((k) => k.startsWith("__react")),
    );

    const status = page.getByRole("status");
    await tabTo(page, /^Zoom in$/, "Zoom in");
    await page.keyboard.press("Enter");
    await expect.poll(() => status.innerText()).toBe("Zoom 150%");
    await expectFocusVisible(page, "Zoom in after activation");
    await page.keyboard.press("Space");
    await expect.poll(() => status.innerText()).toBe("Zoom 225%");

    await tabTo(page, /^Zoom out$/, "Zoom out");
    await page.keyboard.press("Enter");
    await expect.poll(() => status.innerText()).toBe("Zoom 150%");
    await page.keyboard.press("Space");
    await expect.poll(() => status.innerText()).toBe("Zoom 100%");

    // Tab into the Stalls seat table region (focusable, named).
    const region = await tabTo(page, /Stalls seat table/, "Stalls seat table region");
    expect(region.name).toBe("Stalls seat table");

    const rows = page.locator('[role="region"][aria-label="Stalls seat table"] tbody tr');
    const accessRow = rows
      .filter({ hasText: "wheelchair space" })
      .filter({ hasText: "Has companion" })
      .first();
    const cells = await accessRow.locator("td").allInnerTexts();
    const accessLabel = `Row ${cells[0]}, Seat ${cells[1]}`;
    const companionRow = rows.filter({ hasText: `Companion for ${accessLabel}` });
    // The 600-row table is long: Space / Shift+Space page the focused region's scroller.
    const settle = async () => {
      let last = -1;
      for (let i = 0; i < 40; i++) {
        const y = await page.evaluate(() => window.scrollY);
        if (y === last) return;
        last = y;
        await page.waitForTimeout(60);
      }
    };
    for (const [row, step] of [
      [accessRow, "access seat row"],
      [companionRow, "companion row"],
    ] as const) {
      expect(await row.count(), step).toBe(1);
      const inRegion = await row.evaluate(
        (r) =>
          document.activeElement!.contains(r) &&
          document.activeElement!.getAttribute("role") === "region",
      );
      expect(inRegion, `${step} is inside the focused region`).toBe(true);
      let reached = false;
      for (let i = 0; i < 80 && !reached; i++) {
        const pos = await row.evaluate((r) => {
          const b = r.getBoundingClientRect();
          return b.top < 0 ? "above" : b.bottom > window.innerHeight ? "below" : "in";
        });
        reached = pos === "in";
        if (!reached) {
          await page.keyboard.press(pos === "below" ? "Space" : "Shift+Space");
          await settle();
        }
      }
      expect(reached, `${step} scrolled into view by keyboard`).toBe(true);
      await expectFocusVisible(page, `${step} (region still focused)`);
    }
    const accessText = (await accessRow.innerText()).replace(/\s+/g, " ");
    const companionText = (await companionRow.innerText()).replace(/\s+/g, " ");
    expect(accessText).toMatch(/wheelchair space/i);
    expect(accessText).toMatch(/Has companion/);
    expect(companionText).toContain(`Companion for ${accessLabel}`);
    await page.close();
  });
});

describe("AC 12 sanity: tooltip text in the browser", () => {
  it("a wheelchair seat has a <title> naming its feature", async () => {
    const page = await newPage();
    await page.goto(theatreLayoutUrl);
    const titles = await page.locator(".seat-wheelchair > title").allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    expect(titles[0]).toMatch(/wheelchair space/i);
    expect(titles[0]).toMatch(/Stalls|Boxes|Circle/);
    await page.close();
  });
});

describe("AC 14: small viewport and 200% text", () => {
  it("arena layout at 320x640: no page horizontal scroll, table reachable", async () => {
    const page = await newPage(320, 640);
    await page.goto(arenaLayoutUrl);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    const region = page.getByRole("region", { name: "Lower Bowl seat table" });
    await region.scrollIntoViewIfNeeded();
    await expect.poll(() => region.isVisible()).toBe(true);
    await region.focus();
    await expectFocusVisible(page, "table region at 320px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    await page.close();
  });

  it("theatre layout at 200% text: no horizontal page scroll", async () => {
    for (const width of [1280, 320]) {
      const page = await newPage(width, 800);
      await page.goto(theatreLayoutUrl);
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      const sw = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(sw, `viewport ${width}`).toBeLessThanOrEqual(width);
      await page.close();
    }
  });
});

describe("F-2 measurement", () => {
  it("reports arena layout load time", async () => {
    const page = await newPage();
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      await page.goto(arenaLayoutUrl, { waitUntil: "load" });
      runs.push(
        await page.evaluate(() => {
          const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
          return Math.round(n.loadEventEnd - n.startTime);
        }),
      );
    }
    console.log(`[timing] arena layout navigation->load ms (3 runs): ${runs.join(", ")}`);
    await page.close();
  });
});

describe("AC 15 (browser half): API unreachable", () => {
  it("venue page renders the ServiceUnavailable state, axe-clean", async () => {
    await stack.stopApi();
    const page = await newPage();
    await page.goto(theatreUrl);
    await expect.poll(() => page.locator("h1").innerText()).toBe("Something went wrong");
    const retry = page.getByRole("link", { name: "Try again" });
    await expect.poll(() => retry.isVisible()).toBe(true);
    expect(await retry.getAttribute("href")).toBe(new URL(theatreUrl).pathname);
    expect(await page.getByRole("navigation", { name: "Main" }).isVisible()).toBe(true);
    expect(await page.locator("body").innerText()).not.toMatch(/ECONNREFUSED|at \w+ \(/);
    expect(await seriousViolations(page)).toEqual([]);
    for (const u of [`${stack.adminUrl}/`, theatreLayoutUrl, theatreEventUrl]) {
      await page.goto(u);
      await expect.poll(() => page.locator("h1").innerText()).toBe("Something went wrong");
      expect(await page.getByRole("link", { name: "Try again" }).isVisible()).toBe(true);
    }
    await page.close();
  });
});
