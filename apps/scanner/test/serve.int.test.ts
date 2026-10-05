import path from "node:path";
import { startApp, type RunningApp } from "@boxoffice/config/serve-app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("scanner built app served via start", () => {
  let app: RunningApp;
  let html: string;

  beforeAll(async () => {
    app = await startApp(path.resolve(import.meta.dirname, ".."));
    html = await (await fetch(`${app.url}/`)).text();
  });

  afterAll(async () => {
    await app?.stop();
  });

  it("GET / returns 200 HTML with en-GB lang and exactly one h1", async () => {
    const res = await fetch(`${app.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('lang="en-GB"');
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it("serves the static assets referenced by the HTML", async () => {
    const refs = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    const results = await Promise.all(
      refs.map(async (r) => [r, (await fetch(`${app.url}${r}`)).status] as const),
    );
    expect(results.filter(([, s]) => s !== 200)).toEqual([]);
  });

  it("serves a valid web manifest", async () => {
    const res = await fetch(`${app.url}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m.name).toEqual(expect.any(String));
    expect(m.start_url).toEqual(expect.any(String));
    expect(m.display).toEqual(expect.any(String));
    expect(Array.isArray(m.icons) && m.icons.length > 0).toBe(true);
  });

  it("serves /sw.js as JavaScript", async () => {
    const res = await fetch(`${app.url}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
  });

  it("serves /icon.svg", async () => {
    const res = await fetch(`${app.url}/icon.svg`);
    expect(res.status).toBe(200);
  });
});
