import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
});

export function parseEnv(source: Record<string, string | undefined>): { PORT: number } {
  const raw = source["PORT"];
  const result = schema.safeParse({ PORT: raw === undefined || raw === "" ? undefined : raw });
  if (!result.success) {
    // Name the variable only; never echo the value.
    throw new Error("Invalid PORT: expected an integer between 1 and 65535");
  }
  return result.data;
}
