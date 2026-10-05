import { formatInZone } from "@boxoffice/domain";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiUnavailable, getEvent, getVenue } from "../../../../../src/api";
import { ServiceUnavailable } from "../../../../../src/ServiceUnavailable";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ venueId: string; eventId: string }> };

const TAG_LABELS: Record<string, string> = {
  relaxed: "Relaxed",
  captioned: "Captioned",
  bsl_interpreted: "BSL interpreted",
  audio_described: "Audio described",
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { venueId, eventId } = await params;
  try {
    const event = await getEvent(venueId, eventId);
    return { title: event ? `${event.name} - Boxoffice admin` : "Event not found" };
  } catch {
    return { title: "Venue data unavailable · Boxoffice admin" };
  }
}

export default async function Page({ params }: Props) {
  const { venueId, eventId } = await params;
  let event, detail;
  try {
    [event, detail] = await Promise.all([getEvent(venueId, eventId), getVenue(venueId)]);
  } catch (e) {
    if (e instanceof ApiUnavailable) {
      return (
        <ServiceUnavailable
          retryHref={`/venues/${encodeURIComponent(venueId)}/events/${encodeURIComponent(eventId)}`}
        />
      );
    }
    throw e;
  }
  if (event === null || detail === null) notFound();
  const { venue } = detail;
  return (
    <>
      <h1>{event.name}</h1>
      <p>
        Running time:{" "}
        {event.runningTimeMinutes === null ? "not set" : `${event.runningTimeMinutes} minutes`}
      </p>
      <p>Age guidance: {event.ageGuidance ?? "not set"}</p>
      {event.description !== null && <p>{event.description}</p>}
      <div className="table-wrap">
        <table>
          <caption>Performances (times in {venue.timeZone})</caption>
          <thead>
            <tr>
              <th scope="col">Date and time</th>
              <th scope="col">Layout</th>
              <th scope="col">Access</th>
            </tr>
          </thead>
          <tbody>
            {event.performances.map((p) => (
              <tr key={p.id}>
                <th scope="row">{formatInZone(new Date(p.startsAt), venue.timeZone)}</th>
                <td>
                  <a href={`/venues/${venue.id}/layouts/${p.layoutId}`}>
                    {detail.layouts.find((l) => l.id === p.layoutId)?.name ?? "Layout"}
                  </a>
                </td>
                <td>
                  {p.accessTags.length === 0
                    ? "None"
                    : p.accessTags.map((t) => TAG_LABELS[t] ?? t).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
