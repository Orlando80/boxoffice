import { EventDetail, LayoutView, VenueDetail, VenueSummary } from "@boxoffice/contracts";
import { z } from "zod";
import { parseEnv } from "./env";

/** The api could not be reached, answered 5xx, or broke its contract. */
export class ApiUnavailable extends Error {
  constructor() {
    super("The api is unavailable");
    this.name = "ApiUnavailable";
  }
}

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const { API_URL } = parseEnv(process.env);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  } catch {
    throw new ApiUnavailable();
  }
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new ApiUnavailable();
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiUnavailable();
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiUnavailable();
  return parsed.data;
}

/** Dev-only venue picker source (replaced by sign-in). */
export async function getVenues(): Promise<VenueSummary[]> {
  const venues = await get("/venues", z.array(VenueSummary));
  if (venues === null) throw new ApiUnavailable();
  return venues;
}

export function getVenue(venueId: string): Promise<VenueDetail | null> {
  return get(`/venues/${encodeURIComponent(venueId)}`, VenueDetail);
}

export function getEvent(venueId: string, eventId: string): Promise<EventDetail | null> {
  return get(
    `/venues/${encodeURIComponent(venueId)}/events/${encodeURIComponent(eventId)}`,
    EventDetail,
  );
}

export function getLayout(venueId: string, layoutId: string): Promise<LayoutView | null> {
  return get(
    `/venues/${encodeURIComponent(venueId)}/layouts/${encodeURIComponent(layoutId)}`,
    LayoutView,
  );
}
