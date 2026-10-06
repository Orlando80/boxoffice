import { z } from "zod";

const ApiUrl = z.url({ protocol: /^https?$/ }).default("http://localhost:4000");

export function parseEnv(source: Record<string, string | undefined>): { API_URL: string } {
  const raw = source["API_URL"];
  const url = ApiUrl.safeParse(raw === undefined || raw === "" ? undefined : raw);
  if (!url.success) {
    // Name the variable only; never echo the value.
    throw new Error("Invalid API_URL: expected an absolute http(s) URL");
  }
  return { API_URL: url.data.replace(/\/+$/, "") };
}
