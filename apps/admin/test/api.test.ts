import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiUnavailable, getEvent, getLayout, getVenue, getVenues } from "../src/api";
import { parseEnv } from "../src/env";

const ID = "11111111-1111-4111-8111-111111111111";
const venue = { id: ID, name: "Test Hall", slug: "test-hall", timeZone: "Europe/London" };

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

describe("api client failure mapping", () => {
  it("maps a contract violation to ApiUnavailable", async () => {
    fetchMock.mockResolvedValue(json([{ id: "not-a-uuid", name: 1 }]));
    await expect(getVenues()).rejects.toBeInstanceOf(ApiUnavailable);
  });
  it("rejects extra (strict) keys as a contract violation", async () => {
    fetchMock.mockResolvedValue(json([{ ...venue, extra: true }]));
    await expect(getVenues()).rejects.toBeInstanceOf(ApiUnavailable);
  });
  it("maps non-JSON body to ApiUnavailable", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(getVenues()).rejects.toBeInstanceOf(ApiUnavailable);
  });
  it("maps a network error to ApiUnavailable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed ECONNREFUSED"));
    await expect(getVenues()).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(getVenue(ID)).rejects.toBeInstanceOf(ApiUnavailable);
  });
  it.each([500, 502, 503])("maps %i to ApiUnavailable", async (status) => {
    fetchMock.mockImplementation(async () => json({ error: "x" }, status));
    await expect(getVenues()).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(getVenue(ID)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(getEvent(ID, ID)).rejects.toBeInstanceOf(ApiUnavailable);
    await expect(getLayout(ID, ID)).rejects.toBeInstanceOf(ApiUnavailable);
  });
  it("ApiUnavailable message does not leak the cause", async () => {
    fetchMock.mockRejectedValue(new TypeError("secret-host.internal refused"));
    const err = await getVenues().then(
      () => new Error("resolved"),
      (e: unknown) => e as Error,
    );
    expect(err.message).not.toContain("secret-host");
    expect(err.name).toBe("ApiUnavailable");
  });
  it("getVenues 404 is ApiUnavailable (the list always exists)", async () => {
    fetchMock.mockResolvedValue(json({}, 404));
    await expect(getVenues()).rejects.toBeInstanceOf(ApiUnavailable);
  });
  it("returns parsed data on success", async () => {
    fetchMock.mockResolvedValue(json([venue]));
    await expect(getVenues()).resolves.toEqual([venue]);
  });
});

describe("api client 404 handling", () => {
  it("getVenue / getEvent / getLayout return null on 404", async () => {
    fetchMock.mockImplementation(async () => json({ error: "not_found" }, 404));
    await expect(getVenue(ID)).resolves.toBeNull();
    await expect(getEvent(ID, ID)).resolves.toBeNull();
    await expect(getLayout(ID, ID)).resolves.toBeNull();
  });
});

describe("api client request shape", () => {
  it("encodes path segments", async () => {
    fetchMock.mockImplementation(async () => json({}, 404));
    await getVenue("a/b?c#d e");
    await getEvent("../x", "y%z");
    await getLayout("v/1", "l?2");
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe("http://localhost:4000/venues/a%2Fb%3Fc%23d%20e");
    expect(urls[1]).toBe("http://localhost:4000/venues/..%2Fx/events/y%25z");
    expect(urls[2]).toBe("http://localhost:4000/venues/v%2F1/layouts/l%3F2");
  });
  it("uses cache: no-store", async () => {
    fetchMock.mockResolvedValue(json([]));
    await getVenues();
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
  });
  it("defaults API_URL to http://localhost:4000", async () => {
    fetchMock.mockResolvedValue(json([]));
    await getVenues();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:4000/venues");
  });
  it("overrides API_URL and strips trailing slashes, read per call", async () => {
    fetchMock.mockImplementation(async () => json([]));
    vi.stubEnv("API_URL", "https://api.example.test/");
    await getVenues();
    vi.stubEnv("API_URL", "https://other.example.test");
    await getVenues();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.test/venues");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://other.example.test/venues");
  });
});

describe("env", () => {
  it("defaults when unset or empty", () => {
    expect(parseEnv({})).toEqual({ API_URL: "http://localhost:4000" });
    expect(parseEnv({ API_URL: "" })).toEqual({ API_URL: "http://localhost:4000" });
  });
  it("error names API_URL and does not echo the value", () => {
    const bad = "not a url with-secret-token-123";
    let message = "";
    try {
      parseEnv({ API_URL: bad });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("API_URL");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain(bad);
  });
  it("invalid API_URL surfaces from the client without echoing", async () => {
    vi.stubEnv("API_URL", "nope-secret");
    const err = await getVenues().then(
      () => new Error("resolved"),
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain("API_URL");
    expect(err.message).not.toContain("nope-secret");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects non-http schemes (message promises http(s))", () => {
    expect(() => parseEnv({ API_URL: "ftp://example.test" })).toThrow(/API_URL/);
  });
});
