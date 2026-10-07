import { z } from "zod";

export interface WorkerEnv {
  TEMPORAL_ADDRESS: string;
  TEMPORAL_NAMESPACE: string;
  TEMPORAL_API_KEY?: string | undefined;
  DATABASE_URL: string;
}

// host:port, host non-empty with no whitespace or colon (or [ipv6]), port 1-65535.
const address = z.string().refine((v) => {
  const m = /^(\[[^\s\]]+\]|[^\s:[\]]+):(\d{1,5})$/.exec(v);
  if (m === null) return false;
  const port = Number(m[2]);
  return port >= 1 && port <= 65535;
});
const namespace = z.string().regex(/^\S+$/);
const apiKey = z.string().refine((v) => v.trim().length > 0);

const databaseUrl = z.string().refine((v) => URL.canParse(v));

const schema = z.object({
  TEMPORAL_ADDRESS: address.default("localhost:7233"),
  TEMPORAL_NAMESPACE: namespace.default("default"),
  TEMPORAL_API_KEY: apiKey.optional(),
  DATABASE_URL: databaseUrl,
});

export function parseEnv(source: Record<string, string | undefined>): WorkerEnv {
  const pick = (name: string): string | undefined => {
    const v = source[name];
    return v === undefined || v === "" ? undefined : v;
  };
  const result = schema.safeParse({
    TEMPORAL_ADDRESS: pick("TEMPORAL_ADDRESS"),
    TEMPORAL_NAMESPACE: pick("TEMPORAL_NAMESPACE"),
    TEMPORAL_API_KEY: pick("TEMPORAL_API_KEY"),
    DATABASE_URL: pick("DATABASE_URL"),
  });
  if (!result.success) {
    // Name the variables only; never echo values (TEMPORAL_API_KEY and DATABASE_URL are secrets).
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Invalid environment: ${names.join(", ")}`);
  }
  return result.data;
}
