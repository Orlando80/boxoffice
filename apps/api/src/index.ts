import { buildApp } from "./app.js";
import { parseEnv } from "./env.js";

const { PORT } = parseEnv(process.env);
const app = buildApp();

const shutdown = (): void => {
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: "0.0.0.0" });
