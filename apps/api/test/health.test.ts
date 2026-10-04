import { afterEach, describe, expect, it } from "vitest";
import { HealthResponse } from "@boxoffice/contracts";
import { buildApp } from "../src/app.js";

let app: ReturnType<typeof buildApp>;
afterEach(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("returns 200 JSON matching HealthResponse", async () => {
    app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(() => HealthResponse.parse(res.json())).not.toThrow();
  });
});

describe("routing", () => {
  it("unknown route is 404", async () => {
    app = buildApp();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("response serialization (Q6)", () => {
  it("wrong handler body yields 500", async () => {
    app = buildApp();
    app.get("/bad", { schema: { response: { 200: HealthResponse } } }, () => ({ status: "nope" }) as never);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/bad" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("nope\"}");
  });

  it("extra property: documents behaviour, never 200 with non-conforming body", async () => {
    app = buildApp();
    app.get("/extra", { schema: { response: { 200: HealthResponse } } }, () => ({ status: "ok", extra: 1 }) as never);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/extra" });
    console.log("EXTRA BEHAVIOUR:", res.statusCode, res.body);
    if (res.statusCode === 200) {
      expect(HealthResponse.safeParse(res.json()).success).toBe(true);
      expect(res.json()).not.toHaveProperty("extra");
    } else {
      expect(res.statusCode).toBe(500);
    }
  });
});
