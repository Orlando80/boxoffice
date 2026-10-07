import { createDb } from "@boxoffice/db";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { sql } from "drizzle-orm";
import { createActivities } from "./activities.js";
import { buildConnectionOptions } from "./connection.js";
import { parseEnv } from "./env.js";
import { startRelay } from "./relay.js";
import { createWorker, TASK_QUEUE } from "./worker.js";

const env = parseEnv(process.env);
const dbHost = new URL(env.DATABASE_URL).hostname;
const { db, close: closeDb } = createDb(env.DATABASE_URL);

try {
  await db.execute(sql`select 1`);
} catch {
  // Log the host only; never credentials or the full URL.
  console.error(`Database unreachable at host ${dbHost}`);
  await closeDb().catch(() => undefined);
  process.exit(1);
}

let connection: NativeConnection;
let clientConnection: Connection;
try {
  const options = buildConnectionOptions(env);
  connection = await NativeConnection.connect(options);
  // No gRPC auto-retry for the relay: the outbox already retries with backoff, and a
  // pending library retry timer would fire after the connection closes.
  clientConnection = await Connection.connect({ ...options, interceptors: [] });
} catch {
  // Log the address only; never the API key or the underlying error (may echo config).
  console.error(`Failed to connect to Temporal at ${env.TEMPORAL_ADDRESS}`);
  process.exit(1);
}

const worker = await createWorker(connection, {
  namespace: env.TEMPORAL_NAMESPACE,
  activities: createActivities(db),
});
const relay = startRelay({
  db,
  client: new Client({ connection: clientConnection, namespace: env.TEMPORAL_NAMESPACE }),
  taskQueue: TASK_QUEUE,
});

const shutdown = (): void => {
  void relay.stop().then(() => worker.shutdown());
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await worker.run();
  await relay.stop();
  await clientConnection.close();
  await connection.close();
  await closeDb();
  process.exit(0);
} catch {
  console.error(`Worker failed (Temporal at ${env.TEMPORAL_ADDRESS})`);
  process.exit(1);
}
