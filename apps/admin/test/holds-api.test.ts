import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiUnavailable, getAvailability, getPerformance } from "../src/api";

const ID = "11111111-1111-4111-8111-111111111111";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("API_URL", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const perf = {
  id: ID,
  venueId: ID,
  eventId: ID,
  eventName: "Test Play",
  startsAt: "2026-10-25T19:30:00.000Z",
  layoutId: ID,
  accessTags: [],
};
const avail = {
  performanceId: ID,
  asOf: "2026-10-25T13:05:09.000Z",
  heldSeatIds: [ID],
  ga: [{ sectionId: ID, held: 1, capacity: 5 }],
};

describe("performance and availability client (holds step 10)", () => {
  it("encodes path segments and uses no-store", async () => {
    fetchMock.mockImplementation(async () => json({}, 404));
    await getPerformance("a/b?c", "d#e f");
    await getAvailability("../x", "y%z");
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://localhost:4000/venues/a%2Fb%3Fc/performances/d%23e%20f",
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "http://localhost:4000/venues/..%2Fx/performances/y%25z/availability",
    );
    for (const c of fetchMock.mock.calls) expect(c[1]).toMatchObject({ cache: "no-store" });
  });
  it("returns parsed data on success", async () => {
    fetchMock.mockImplementation(async () => json(perf));
    await expect(getPerformance(ID, ID)).resolves.toEqual(perf);
    fetchMock.mockImplementation(async () => json(avail));
    await expect(getAvailability(ID, ID)).resolves.toEqual(avail);
  });
  it.each([400, 404])("%i gives null", async (status) => {
    fetchMock.mockImplementation(async () => json({ error: "x" }, status));
    await expect(getPerformance(ID, ID)).resolves.toBeNull();
    await expect(getAvailability(ID, ID)).resolves.toBeNull();
  });
  it.each([500, 502, 503])("%i is ApiUnavailable", async (status) => {
    fetchMock.mockImplementation(async () => json({ error: "x" }, status));
    await expect(getPerformance(ID, ID)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(getAvailability(ID, ID)).rejects.toBeInstanceOf(ApiUnavailable);
  });
  it("contract violations (wrong type, extra keys) are ApiUnavailable", async () => {
    const bad: [unknown, unknown][] = [
      [
        { ...perf, holdToken: "tok_x" },
        { ...avail, need: "x" },
      ],
      [
        { ...perf, startsAt: "yesterday" },
        { ...avail, heldSeatIds: ["nope"] },
      ],
      [{ id: ID }, { ...avail, ga: [{ sectionId: ID, held: -1, capacity: 5 }] }],
      [[], { ...avail, ga: [{ sectionId: ID, held: 1, capacity: 5, holdId: ID }] }],
    ];
    for (const [p, v] of bad) {
      fetchMock.mockImplementation(async () => json(p));
      await expect(getPerformance(ID, ID)).rejects.toBeInstanceOf(ApiUnavailable);
      fetchMock.mockImplementation(async () => json(v));
      await expect(getAvailability(ID, ID)).rejects.toBeInstanceOf(ApiUnavailable);
    }
  });
  it("network error and non-JSON are ApiUnavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("ECONNREFUSED"));
    await expect(getPerformance(ID, ID)).rejects.toBeInstanceOf(ApiUnavailable);
    fetchMock.mockImplementation(async () => new Response("<html>", { status: 200 }));
    await expect(getAvailability(ID, ID)).rejects.toBeInstanceOf(ApiUnavailable);
  });
});
