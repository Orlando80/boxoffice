import { NativeConnection } from "@temporalio/worker";
import { buildConnectionOptions } from "./connection.js";
import { parseEnv } from "./env.js";
import { createWorker } from "./worker.js";

const env = parseEnv(process.env);

let connection: NativeConnection;
try {
  connection = await NativeConnection.connect(buildConnectionOptions(env));
} catch {
  // Log the address only; never the API key or the underlying error (may echo config).
  console.error(`Failed to connect to Temporal at ${env.TEMPORAL_ADDRESS}`);
  process.exit(1);
}

const worker = await createWorker(connection, { namespace: env.TEMPORAL_NAMESPACE });

const shutdown = (): void => {
  worker.shutdown();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await worker.run();
  await connection.close();
  process.exit(0);
} catch {
  console.error(`Worker failed (Temporal at ${env.TEMPORAL_ADDRESS})`);
  process.exit(1);
}
