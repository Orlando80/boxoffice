import { formatInZone } from "@boxoffice/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  ApiUnavailable,
  getAvailability,
  getLayout,
  getPerformance,
  getVenue,
} from "../../../../../src/api";
import { SeatMap, buildModel } from "../../../../../src/seat-map/SeatMap";
import { SeatTable } from "../../../../../src/seat-map/SeatTable";
import { ServiceUnavailable } from "../../../../../src/ServiceUnavailable";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ venueId: string; performanceId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { venueId, performanceId } = await params;
  try {
    const performance = await getPerformance(venueId, performanceId);
    return {
      title: performance
        ? `${performance.eventName} performance - Boxoffice admin`
        : "Performance not found",
    };
  } catch {
    return { title: "Venue data unavailable · Boxoffice admin" };
  }
}

function timeOfDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

export default async function Page({ params }: Props) {
  const { venueId, performanceId } = await params;
  const here = `/venues/${encodeURIComponent(venueId)}/performances/${encodeURIComponent(performanceId)}`;
  let performance, availability, detail, layout;
  try {
    [performance, availability, detail] = await Promise.all([
      getPerformance(venueId, performanceId),
      getAvailability(venueId, performanceId),
      getVenue(venueId),
    ]);
    if (performance === null || availability === null || detail === null) notFound();
    layout = await getLayout(venueId, performance.layoutId);
  } catch (e) {
    if (e instanceof ApiUnavailable) return <ServiceUnavailable retryHref={here} />;
    throw e;
  }
  if (layout === null) notFound();
  const { timeZone } = detail.venue;
  const model = buildModel(layout, availability);
  return (
    <>
      <h1>{performance.eventName}</h1>
      <p>Performance: {formatInZone(new Date(performance.startsAt), timeZone)}</p>
      <p>
        Held state as of {timeOfDay(availability.asOf, timeZone)} (venue time).{" "}
        <a href={here}>Refresh</a>
      </p>
      <p>
        <a
          href={`/venues/${encodeURIComponent(venueId)}/events/${encodeURIComponent(performance.eventId)}`}
        >
          Back to event
        </a>
      </p>
      <SeatMap model={model} />
      <SeatTable model={model} />
    </>
  );
}
