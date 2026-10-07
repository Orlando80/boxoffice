import * as queries from "@boxoffice/db";
import type { Db } from "@boxoffice/db";
import type { Repositories } from "./app.js";

/**
 * Wires the repositories to the database queries. `holdLengthSeconds` is used
 * for both create and extend, so an extension grants the same length.
 */
export function createRepository(db: Db, holdLengthSeconds = 600): Repositories {
  const opts = { lengthSeconds: holdLengthSeconds };
  return {
    listVenues: () => queries.listVenues(db),
    getVenue: (v) => queries.getVenue(db, v),
    listLayouts: (v) => queries.listLayouts(db, v),
    listEvents: (v) => queries.listEvents(db, v),
    getEvent: (v, e) => queries.getEvent(db, v, e),
    getLayoutView: (v, l) => queries.getLayoutView(db, v, l),
    holds: {
      getPerformance: (v, p) => queries.getPerformance(db, v, p),
      getAvailability: (v, p) => queries.getAvailability(db, v, p),
      createHold: (v, p, r) => queries.createHold(db, v, p, r, opts),
      getHold: (v, h, t) => queries.getHold(db, v, h, t),
      extendHold: (v, h, t) => queries.extendHold(db, v, h, t, opts),
      releaseHold: (v, h, t) => queries.releaseHold(db, v, h, t),
    },
  };
}
