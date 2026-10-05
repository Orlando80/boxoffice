import type { Metadata } from "next";
import { ApiUnavailable, getVenues } from "../src/api";
import { ServiceUnavailable } from "../src/ServiceUnavailable";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Venues - Boxoffice admin" };

export default async function Page() {
  let venues;
  try {
    venues = await getVenues();
  } catch (e) {
    if (e instanceof ApiUnavailable) return <ServiceUnavailable retryHref="/" />;
    throw e;
  }
  return (
    <>
      <h1>Venues</h1>
      {/* Dev-only (P6): GET /venues is unscoped; the auth intent replaces this picker. */}
      <p className="note">Development venue picker — replaced by sign-in</p>
      {venues.length === 0 ? (
        <p>There are no venues yet.</p>
      ) : (
        <ul>
          {venues.map((v) => (
            <li key={v.id}>
              <a href={`/venues/${v.id}`}>{v.name}</a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
