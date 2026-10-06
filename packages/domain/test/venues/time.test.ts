import { describe, expect, it } from "vitest";
import { formatInZone } from "../../src/index.js";

const f = (iso: string, z = "Europe/London") => formatInZone(new Date(iso), z);

describe("formatInZone", () => {
  it("BST/GMT either side of 25 Oct 2026 clock change", () => {
    expect(f("2026-10-24T18:30:00Z")).toBe("Sat 24 Oct 2026, 19:30");
    expect(f("2026-10-25T19:30:00Z")).toBe("Sun 25 Oct 2026, 19:30");
  });
  it("same wall time is 25h apart in UTC across the change", () => {
    const a = new Date("2026-10-24T18:30:00Z").getTime();
    const b = new Date("2026-10-25T19:30:00Z").getTime();
    expect(b - a).toBe(25 * 3600_000);
  });
  it("25 Oct 2026 repeated hour", () => {
    expect(f("2026-10-25T00:30:00Z")).toBe("Sun 25 Oct 2026, 01:30");
    expect(f("2026-10-25T01:30:00Z")).toBe("Sun 25 Oct 2026, 01:30");
  });
  it("29 Mar 2026 spring forward", () => {
    expect(f("2026-03-28T19:30:00Z")).toBe("Sat 28 Mar 2026, 19:30");
    expect(f("2026-03-29T18:30:00Z")).toBe("Sun 29 Mar 2026, 19:30");
    expect(f("2026-03-29T00:59:00Z")).toBe("Sun 29 Mar 2026, 00:59");
    expect(f("2026-03-29T01:00:00Z")).toBe("Sun 29 Mar 2026, 02:00");
  });
  it("midnight renders as 00:xx (h23), not 24:xx", () => {
    expect(f("2026-01-10T00:05:00Z")).toBe("Sat 10 Jan 2026, 00:05");
    expect(f("2026-06-30T23:05:00Z")).toBe("Wed 1 Jul 2026, 00:05");
  });
  it("other zones", () => {
    expect(f("2026-10-25T19:30:00Z", "UTC")).toBe("Sun 25 Oct 2026, 19:30");
    expect(f("2026-10-25T19:30:00Z", "Asia/Tokyo")).toBe("Mon 26 Oct 2026, 04:30");
  });
  it("throws RangeError on invalid zone or date", () => {
    expect(() => f("2026-10-25T19:30:00Z", "Not/AZone")).toThrow(RangeError);
    expect(() => formatInZone(new Date("nope"), "Europe/London")).toThrow(RangeError);
  });
});
