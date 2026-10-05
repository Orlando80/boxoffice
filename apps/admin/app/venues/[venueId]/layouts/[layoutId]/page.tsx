import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiUnavailable, getLayout } from "../../../../../src/api";
import { SeatMap, buildModel } from "../../../../../src/seat-map/SeatMap";
import { SeatTable } from "../../../../../src/seat-map/SeatTable";
import { ServiceUnavailable } from "../../../../../src/ServiceUnavailable";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ venueId: string; layoutId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { venueId, layoutId } = await params;
  try {
    const layout = await getLayout(venueId, layoutId);
    return { title: layout ? `${layout.name} - Boxoffice admin` : "Layout not found" };
  } catch {
    return { title: "Venue data unavailable · Boxoffice admin" };
  }
}

export default async function Page({ params }: Props) {
  const { venueId, layoutId } = await params;
  let layout;
  try {
    layout = await getLayout(venueId, layoutId);
  } catch (e) {
    if (e instanceof ApiUnavailable) {
      return (
        <ServiceUnavailable
          retryHref={`/venues/${encodeURIComponent(venueId)}/layouts/${encodeURIComponent(layoutId)}`}
        />
      );
    }
    throw e;
  }
  if (layout === null) notFound();
  const model = buildModel(layout);
  return (
    <>
      <h1>{model.name}</h1>
      <p>
        <a href={`/venues/${encodeURIComponent(venueId)}`}>Back to venue</a>
      </p>
      <SeatMap model={model} />
      <SeatTable model={model} />
    </>
  );
}
