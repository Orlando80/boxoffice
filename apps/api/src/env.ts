import { z } from "zod";

const Port = z.coerce.number().int().min(1).max(65535).default(4000);
const DatabaseUrl = z.string().min(1);

export function parseEnv(source: Record<string, string | undefined>): {
  PORT: number;
  DATABASE_URL: string;
} {
  const raw = source["PORT"];
  const port = Port.safeParse(raw === undefined || raw === "" ? undefined : raw);
  if (!port.success) {
    // Name the variable only; never echo the value.
    throw new Error("Invalid PORT: expected an integer between 1 and 65535");
  }
  const url = DatabaseUrl.safeParse(source["DATABASE_URL"]);
  if (!url.success || !URL.canParse(url.data)) {
    throw new Error("Invalid DATABASE_URL: expected a postgres connection URL");
  }
  return { PORT: port.data, DATABASE_URL: url.data };
}
