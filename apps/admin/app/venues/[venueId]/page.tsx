import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiUnavailable, getVenue } from "../../../src/api";
import { ServiceUnavailable } from "../../../src/ServiceUnavailable";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ venueId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { venueId } = await params;
  try {
    const detail = await getVenue(venueId);
    return { title: detail ? `${detail.venue.name} - Boxoffice admin` : "Venue not found" };
  } catch {
    return { title: "Venue data unavailable · Boxoffice admin" };
  }
}

export default async function Page({ params }: Props) {
  const { venueId } = await params;
  let detail;
  try {
    detail = await getVenue(venueId);
  } catch (e) {
    if (e instanceof ApiUnavailable) {
      return <ServiceUnavailable retryHref={`/venues/${encodeURIComponent(venueId)}`} />;
    }
    throw e;
  }
  if (detail === null) notFound();
  const { venue, layouts, events } = detail;
  return (
    <>
      <h1>{venue.name}</h1>
      <p>Time zone: {venue.timeZone}</p>
      <h2>Layouts</h2>
      {layouts.length === 0 ? (
        <p>No layouts.</p>
      ) : (
        <ul>
          {layouts.map((l) => (
            <li key={l.id}>
              <a href={`/venues/${venue.id}/layouts/${l.id}`}>{l.name}</a>
            </li>
          ))}
        </ul>
      )}
      <h2>Events</h2>
      {events.length === 0 ? (
        <p>No events.</p>
      ) : (
        <ul>
          {events.map((e) => (
            <li key={e.id}>
              <a href={`/venues/${venue.id}/events/${e.id}`}>{e.name}</a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
