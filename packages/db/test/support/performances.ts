import type postgres from "postgres";

export interface FuturePerformance {
  id: string;
  venueId: string;
  layoutId: string;
}

/**
 * Test-only. Inserts a performance on a seed event and layout that starts at
 * now() + daysAhead days (negative = already started), so no test depends on
 * the calendar date. The seed stays unchanged.
 */
export async function futurePerformance(
  sql: postgres.Sql,
  opts: { venueSlug: string; eventSlug: string; layoutName: string; daysAhead: number },
): Promise<FuturePerformance> {
  const rows = await sql<{ id: string; venue_id: string; layout_id: string }[]>`
    insert into performance (venue_id, event_id, layout_id, starts_at)
    select v.id, e.id, l.id, now() + make_interval(days => ${opts.daysAhead}::int)
    from venue v
    join event e on e.venue_id = v.id and e.slug = ${opts.eventSlug}
    join layout l on l.venue_id = v.id and l.name = ${opts.layoutName}
    where v.slug = ${opts.venueSlug}
    returning id, venue_id, layout_id`;
  const row = rows[0];
  if (!row) throw new Error("futurePerformance: venue, event or layout not found in seed");
  return { id: row.id, venueId: row.venue_id, layoutId: row.layout_id };
}
