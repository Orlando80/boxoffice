import type { WorkerEnv } from "./env.js";

export interface ConnectionOptions {
  address: string;
  tls?: true;
  apiKey?: string;
}

export function buildConnectionOptions(env: WorkerEnv): ConnectionOptions {
  if (env.TEMPORAL_API_KEY === undefined) {
    return { address: env.TEMPORAL_ADDRESS };
  }
  return { address: env.TEMPORAL_ADDRESS, tls: true, apiKey: env.TEMPORAL_API_KEY };
}
