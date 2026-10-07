import path from "node:path";
import { buildApp } from "@boxoffice/api/app";
import { createRepository } from "@boxoffice/api/repository";
import { startApp, type RunningApp } from "@boxoffice/config/serve-app";
import { createDb, createHold, type Db } from "@boxoffice/db";
import { seedDatabase } from "@boxoffice/db/seed";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { performance } from "../../../../packages/db/src/schema.js";
import { buildSeed, seedId } from "../../../../packages/db/src/seed/data.js";

export interface HeldPerformance {
  venueId: string;
  eventId: string;
  performanceId: string;
  /** Admin path of the performance page. */
  url: string;
  /** Admin path of the event page that lists it. */
  eventUrl: string;
  /** Labels as the seat table shows them, e.g. "Row T, Seat 3". */
  heldSeatLabels: string[];
}

export interface Stack {
  adminUrl: string;
  apiUrl: string;
  /** A future theatre performance with one standard hold and one access+companion hold. */
  heldPerformance: HeldPerformance;
  /** Stops only the API (idempotent), to simulate an outage. */
  stopApi: () => Promise<void>;
  /** Stops everything (idempotent). */
  stop: () => Promise<void>;
}

const ADMIN_DIR = path.resolve(import.meta.dirname, "../..");

const VENUE = "harbour-lane-theatre";
const EVENT = "the-lantern-keeper";
const LAYOUT = "End-on";
const stalls = (row: string, n: number): string =>
  seedId("seat", VENUE, LAYOUT, "Stalls", row, String(n));

/**
 * Inserts a theatre performance 30 days ahead (so it never counts as started),
 * then holds a standard seat, and an access seat with its companion (T3 + T4).
 * Holds last an hour, so they outlive the run.
 */
async function seedHeldPerformance(db: Db): Promise<HeldPerformance> {
  const graph = buildSeed();
  const venue = graph.venues.find((v) => v.slug === VENUE);
  const event = graph.events.find((e) => e.venueId === venue?.id && e.slug === EVENT);
  const layout = graph.layouts.find((l) => l.venueId === venue?.id && l.name === LAYOUT);
  if (!venue || !event || !layout) throw new Error("seed: theatre event or layout not found");

  const rows = await db
    .insert(performance)
    .values({
      venueId: venue.id,
      eventId: event.id,
      layoutId: layout.id,
      startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: performance.id });
  const performanceId = rows[0]?.id;
  if (!performanceId) throw new Error("seed: performance insert returned no row");

  const holds = [
    [{ seatId: stalls("B", 5), role: "standard" as const }],
    [
      { seatId: stalls("T", 3), role: "access" as const, accessNeed: "wheelchair_space" },
      { seatId: stalls("T", 4), role: "companion" as const },
    ],
  ];
  for (const seats of holds) {
    const r = await createHold(
      db,
      venue.id,
      performanceId,
      { seats, ga: [] },
      { lengthSeconds: 3600 },
    );
    if (!r.ok) throw new Error(`seed: hold failed: ${JSON.stringify(r.error)}`);
  }
  return {
    venueId: venue.id,
    eventId: event.id,
    performanceId,
    url: `/venues/${venue.id}/performances/${performanceId}`,
    eventUrl: `/venues/${venue.id}/events/${event.id}`,
    heldSeatLabels: ["Row B, Seat 5", "Row T, Seat 3", "Row T, Seat 4"],
  };
}

/** Postgres (seeded) + in-process API on a free port + the built admin app served by `start`. */
export async function startStack(): Promise<Stack> {
  let container: StartedPostgreSqlContainer | undefined;
  let closeDb: (() => Promise<void>) | undefined;
  let api: ReturnType<typeof buildApp> | undefined;
  let admin: RunningApp | undefined;
  let apiStopped = false;

  const stopApi = async (): Promise<void> => {
    if (apiStopped) return;
    apiStopped = true;
    await api?.close();
  };
  const stop = async (): Promise<void> => {
    const steps: Array<() => Promise<unknown> | undefined> = [
      () => admin?.stop(),
      () => stopApi(),
      () => closeDb?.(),
      () => container?.stop(),
    ];
    for (const s of steps) {
      try {
        await s();
      } catch {
        // keep cleaning up
      }
    }
  };

  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withStartupTimeout(110_000)
      .start();
    const url = container.getConnectionUri();
    await seedDatabase(url);
    const created = createDb(url);
    closeDb = created.close;
    const heldPerformance = await seedHeldPerformance(created.db);
    api = buildApp(createRepository(created.db));
    await api.listen({ port: 0, host: "127.0.0.1" });
    const addr = api.server.address();
    if (addr === null || typeof addr === "string") throw new Error("API has no TCP address");
    const apiUrl = `http://127.0.0.1:${addr.port}`;
    admin = await startApp(ADMIN_DIR, { env: { API_URL: apiUrl } });
    return { adminUrl: admin.url, apiUrl, heldPerformance, stopApi, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
