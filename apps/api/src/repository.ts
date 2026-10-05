import * as queries from "@boxoffice/db";
import type { Db } from "@boxoffice/db";
import type { VenueRepository } from "./routes/venues.js";

/** Wires the venue repository to the database queries. */
export function createRepository(db: Db): VenueRepository {
  return {
    listVenues: () => queries.listVenues(db),
    getVenue: (v) => queries.getVenue(db, v),
    listLayouts: (v) => queries.listLayouts(db, v),
    listEvents: (v) => queries.listEvents(db, v),
    getEvent: (v, e) => queries.getEvent(db, v, e),
    getLayoutView: (v, l) => queries.getLayoutView(db, v, l),
  };
}
