// Dev-owned test support for worker integration tests: Postgres + Temporal + worker + relay.
import { randomUUID } from "node:crypto";
import { createDb, createHold, runMigrations, type Db } from "@boxoffice/db";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, type Worker } from "@temporalio/worker";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createActivities } from "../../src/activities.js";
import { startRelay, type Relay } from "../../src/relay.js";
import { createWorker } from "../../src/worker.js";
import { seedId, buildSeed } from "../../../../packages/db/src/seed/data.js";
import { seedDatabase } from "../../../../packages/db/src/seed/run.js";
import {
  futurePerformance,
  type FuturePerformance,
} from "../../../../packages/db/test/support/performances.js";
import { getTemporalTarget, type TemporalTarget } from "../temporal-target.js";

const STUDIO = "quillmarsh-studio";
const STUDIO_LAYOUT = "Standing and stalls";

export const stallsSeat = (row: string, n: number): string =>
  seedId("seat", STUDIO, STUDIO_LAYOUT, "Stalls", row, String(n));

type SqlTag = Parameters<typeof futurePerformance>[0];

export interface HoldsStack {
  db: Db;
  sql: SqlTag;
  client: Client;
  taskQueue: string;
  /** Lines the activities logged (the hold.expired JSON lines). */
  logLines: string[];
  /** Lines the relay logged. */
  relayLogs: string[];
  /** The running relay, or undefined when started with relay: "none". */
  relay: () => Relay | undefined;
  /** A fresh future performance on the seeded studio venue. */
  createPerformance: () => Promise<FuturePerformance>;
  /** Creates a hold on `seatIds` (default: one fresh stalls seat); returns ids. */
  createHoldFor: (
    perf: FuturePerformance,
    opts?: { lengthSeconds?: number; seatIds?: string[] },
  ) => Promise<{ holdId: string; token: string; expiresAt: Date; seatIds: string[] }>;
  /** Stops any relay and starts one whose Temporal client cannot connect (AC 20). */
  useUnreachableRelay: (address?: string) => Promise<Relay>;
  /** Stops any relay and starts one against the real Temporal target. */
  useRealRelay: () => Promise<Relay>;
  stop: () => Promise<void>;
}

export async function startHoldsStack(
  opts: { relay?: "real" | "none"; intervalMs?: number } = {},
): Promise<HoldsStack> {
  const intervalMs = opts.intervalMs ?? 100;
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withStartupTimeout(110_000)
    .start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  await seedDatabase(url, buildSeed());
  const { db, close } = createDb(url);
  const sql = (db as unknown as { $client: SqlTag }).$client;

  const target: TemporalTarget = await getTemporalTarget();
  const native = await NativeConnection.connect({ address: target.address });
  const clientConn = await Connection.connect({ address: target.address, interceptors: [] });
  const client = new Client({ connection: clientConn });
  const taskQueue = `holds-${randomUUID()}`;
  const logLines: string[] = [];
  const relayLogs: string[] = [];

  const worker: Worker = await createWorker(native, {
    namespace: "default",
    taskQueue,
    activities: createActivities(db, (l) => void logLines.push(l)),
  });
  const workerRun = worker.run();

  let relay: Relay | undefined;
  const extraConns: Connection[] = [];
  const begin = (c: Client): Relay =>
    startRelay({ db, client: c, taskQueue, intervalMs, deliverTimeoutMs: 1000, log: (l) => void relayLogs.push(l) });
  const stopRelay = async (): Promise<void> => {
    await relay?.stop();
    relay = undefined;
  };
  if (opts.relay !== "none") relay = begin(client);

  let seatCounter = 0;
  const rows = "ABCDEFGHIJ";

  return {
    db,
    sql,
    client,
    taskQueue,
    logLines,
    relayLogs,
    relay: () => relay,
    createPerformance: () =>
      futurePerformance(sql, {
        venueSlug: STUDIO,
        eventSlug: "late-night-comedy",
        layoutName: STUDIO_LAYOUT,
        daysAhead: 5,
      }),
    async createHoldFor(perf, o = {}) {
      const seatIds =
        o.seatIds ??
        [stallsSeat(rows[Math.floor(seatCounter / 10) % rows.length]!, (seatCounter++ % 10) + 1)];
      const r = await createHold(
        db,
        perf.venueId,
        perf.id,
        { seats: seatIds.map((seatId) => ({ seatId, role: "standard" as const })), ga: [] },
        { lengthSeconds: o.lengthSeconds ?? 2 },
      );
      if (!r.ok) throw new Error(`createHoldFor failed: ${JSON.stringify(r.error)}`);
      return { holdId: r.value.holdId, token: r.value.token, expiresAt: r.value.expiresAt, seatIds };
    },
    async useUnreachableRelay(address = "127.0.0.1:1") {
      await stopRelay();
      const lazy = Connection.lazy({ address, interceptors: [] });
      extraConns.push(lazy);
      const c = new Client({ connection: lazy });
      return (relay = begin(c));
    },
    async useRealRelay() {
      await stopRelay();
      return (relay = begin(client));
    },
    async stop() {
      await stopRelay();
      worker.shutdown();
      await workerRun.catch(() => undefined);
      for (const c of extraConns) await c.close().catch(() => undefined);
      await clientConn.close().catch(() => undefined);
      await native.close().catch(() => undefined);
      await target.stop().catch(() => undefined);
      await close().catch(() => undefined);
      await container.stop().catch(() => undefined);
    },
  };
}
