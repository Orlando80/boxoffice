import { expireHoldIfDue, getHoldExpiry, type Db } from "@boxoffice/db";
import type { HoldActivities } from "./workflows.js";

export function createActivities(
  db: Db,
  log: (line: string) => void = (l) => console.log(l),
): HoldActivities {
  return {
    async getHoldExpiry(venueId, holdId) {
      const row = await getHoldExpiry(db, venueId, holdId);
      return row === null ? null : { status: row.status, expiresAt: row.expiresAt.toISOString() };
    },
    async expireHoldIfDue(venueId, holdId) {
      const r = await expireHoldIfDue(db, venueId, holdId);
      if (r.ended) {
        log(JSON.stringify({ event: "hold.expired", holdId, venueId, lag_ms: r.lagMs }));
        return { ended: true, expiresAt: null };
      }
      return { ended: false, expiresAt: r.expiresAt === null ? null : r.expiresAt.toISOString() };
    },
  } satisfies HoldActivities;
}
