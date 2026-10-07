import { z } from "zod";

const Port = z.coerce.number().int().min(1).max(65535).default(4000);
const HoldLength = z.coerce.number().int().min(1).max(3600).default(600);
const DatabaseUrl = z.string().min(1);

export function parseEnv(source: Record<string, string | undefined>): {
  PORT: number;
  DATABASE_URL: string;
  HOLD_LENGTH_SECONDS: number;
} {
  const raw = source["PORT"];
  const port = Port.safeParse(raw === undefined || raw === "" ? undefined : raw);
  if (!port.success) {
    // Name the variable only; never echo the value.
    throw new Error("Invalid PORT: expected an integer between 1 and 65535");
  }
  const rawLength = source["HOLD_LENGTH_SECONDS"];
  const length = HoldLength.safeParse(
    rawLength === undefined || rawLength === "" ? undefined : rawLength,
  );
  if (!length.success) {
    throw new Error("Invalid HOLD_LENGTH_SECONDS: expected an integer between 1 and 3600");
  }
  const url = DatabaseUrl.safeParse(source["DATABASE_URL"]);
  if (!url.success || !URL.canParse(url.data)) {
    throw new Error("Invalid DATABASE_URL: expected a postgres connection URL");
  }
  return { PORT: port.data, DATABASE_URL: url.data, HOLD_LENGTH_SECONDS: length.data };
}
