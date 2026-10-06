import { z } from "zod";

export const PLACEHOLDER_URL = "postgres://placeholder:placeholder@localhost:5432/placeholder";

const schema = z.object({
  DATABASE_URL: z.url().default(PLACEHOLDER_URL),
});

export function parseEnv(source: Record<string, string | undefined>): { DATABASE_URL: string } {
  const result = schema.safeParse({ DATABASE_URL: source["DATABASE_URL"] });
  if (!result.success) {
    // Never echo the value: it may contain credentials.
    throw new Error("Invalid DATABASE_URL: expected a valid connection URL");
  }
  return result.data;
}

export const env = parseEnv(process.env);
