import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RootLayout, { metadata, viewport } from "../app/layout";
import Page from "../app/page";

describe("placeholder page accessibility baseline", () => {
  const html = renderToStaticMarkup(
    <RootLayout>
      <Page />
    </RootLayout>,
  );

  it("sets lang en-GB on <html>", () => {
    expect(html).toMatch(/<html[^>]*lang="en-GB"/);
  });

  it("renders exactly one h1 with text", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
  });

  it("has a non-empty string title", () => {
    expect(typeof metadata.title).toBe("string");
    expect((metadata.title as string).trim().length).toBeGreaterThan(0);
  });

  it("viewport does not block zoom", () => {
    const v = viewport as Record<string, unknown>;
    for (const key of ["maximumScale", "maximum-scale", "maximumscale"]) {
      expect(key in v).toBe(false);
    }
    expect(v.userScalable).not.toBe(false);
    expect(v.userScalable).not.toBe(0);
    expect(v.userScalable).not.toBe("no");
    expect(v["user-scalable"]).toBeUndefined();
    expect(v.initialScale).toBe(1);
    expect(v.width).toBe("device-width");
  });
});
