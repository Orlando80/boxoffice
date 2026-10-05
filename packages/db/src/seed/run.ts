import { resolve } from "node:path";
import { validateVenueGraph, type Violation, type VenueGraph } from "@boxoffice/domain";
import { sql } from "drizzle-orm";
import { createDb, type Db } from "../client.js";
import { PLACEHOLDER_URL, parseEnv } from "../env.js";
import { runMigrations } from "../migrate.js";
import {
  companionLink,
  event,
  layout,
  performance,
  seat,
  seatAccessFeature,
  section,
  venue,
} from "../schema.js";
import { buildSeed } from "./data.js";

const BATCH = 1000;

/** Maps each "kind:id" item a violation can name to its venue's name. */
function venueNameByItem(graph: VenueGraph): Map<string, string> {
  const names = new Map<string, string>();
  const venueName = new Map(graph.venues.map((v) => [v.id, v.name] as const));
  for (const v of graph.venues) names.set(`venue:${v.id}`, v.name);
  for (const l of graph.layouts) {
    const name = venueName.get(l.venueId) ?? l.venueId;
    for (const s of l.sections) {
      names.set(`section:${s.id}`, name);
      for (const st of s.seats) names.set(`seat:${st.id}`, name);
    }
  }
  for (const e of graph.events) {
    const name = venueName.get(e.venueId) ?? e.venueId;
    for (const p of e.performances) names.set(`performance:${p.id}`, name);
  }
  return names;
}

/** Returns one line per violation, naming the venue and the rule. Empty when valid. */
export function validateSeed(graph: VenueGraph): string[] {
  const result = validateVenueGraph(graph);
  if (result.ok) return [];
  const names = venueNameByItem(graph);
  return result.error.map(
    (v: Violation) =>
      `venue "${names.get(v.item) ?? "unknown"}": rule ${v.rule} on ${v.item}: ${v.message}`,
  );
}

async function insertBatched<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await insert(rows.slice(i, i + BATCH));
}

/** Upserts the whole graph by (deterministic, natural-key-derived) ids in one transaction. */
export async function writeSeed(db: Db, graph: VenueGraph): Promise<void> {
  await db.transaction(async (tx) => {
    await insertBatched(
      graph.venues.map((v) => ({ id: v.id, name: v.name, slug: v.slug, timeZone: v.timeZone })),
      (rows) =>
        tx
          .insert(venue)
          .values(rows)
          .onConflictDoUpdate({
            target: venue.id,
            set: {
              name: sql`excluded.name`,
              slug: sql`excluded.slug`,
              timeZone: sql`excluded.time_zone`,
            },
          }),
    );
    await insertBatched(
      graph.layouts.map((l) => ({ id: l.id, venueId: l.venueId, name: l.name })),
      (rows) =>
        tx
          .insert(layout)
          .values(rows)
          .onConflictDoUpdate({ target: layout.id, set: { name: sql`excluded.name` } }),
    );

    const sections = graph.layouts.flatMap((l) =>
      l.sections.map((s) => ({
        id: s.id,
        venueId: l.venueId,
        layoutId: l.id,
        name: s.name,
        kind: s.kind,
        gaCapacity: s.gaCapacity,
      })),
    );
    await insertBatched(sections, (rows) =>
      tx
        .insert(section)
        .values(rows)
        .onConflictDoUpdate({
          target: section.id,
          set: {
            name: sql`excluded.name`,
            kind: sql`excluded.kind`,
            gaCapacity: sql`excluded.ga_capacity`,
          },
        }),
    );

    const seats = graph.layouts.flatMap((l) =>
      l.sections.flatMap((s) =>
        s.seats.map((st) => ({
          id: st.id,
          venueId: l.venueId,
          sectionId: s.id,
          rowLabel: st.rowLabel,
          seatLabel: st.seatLabel,
          x: st.x,
          y: st.y,
        })),
      ),
    );
    await insertBatched(seats, (rows) =>
      tx
        .insert(seat)
        .values(rows)
        .onConflictDoUpdate({
          target: seat.id,
          set: {
            rowLabel: sql`excluded.row_label`,
            seatLabel: sql`excluded.seat_label`,
            x: sql`excluded.x`,
            y: sql`excluded.y`,
          },
        }),
    );

    const features = graph.layouts.flatMap((l) =>
      l.sections.flatMap((s) =>
        s.seats.flatMap((st) =>
          st.accessFeatures.map((f) => ({
            venueId: l.venueId,
            seatId: st.id,
            feature: f as (typeof seatAccessFeature.$inferInsert)["feature"],
          })),
        ),
      ),
    );
    await insertBatched(features, (rows) =>
      tx.insert(seatAccessFeature).values(rows).onConflictDoNothing(),
    );

    const links = graph.layouts.flatMap((l) =>
      l.sections.flatMap((s) =>
        s.seats.flatMap((st) =>
          st.companionOf === null
            ? []
            : [{ venueId: l.venueId, accessSeatId: st.companionOf, companionSeatId: st.id }],
        ),
      ),
    );
    await insertBatched(links, (rows) =>
      tx.insert(companionLink).values(rows).onConflictDoNothing(),
    );

    await insertBatched(
      graph.events.map((e) => ({
        id: e.id,
        venueId: e.venueId,
        name: e.name,
        slug: e.slug,
        description: e.description,
        runningTimeMinutes: e.runningTimeMinutes,
        ageGuidance: e.ageGuidance,
      })),
      (rows) =>
        tx
          .insert(event)
          .values(rows)
          .onConflictDoUpdate({
            target: event.id,
            set: {
              name: sql`excluded.name`,
              slug: sql`excluded.slug`,
              description: sql`excluded.description`,
              runningTimeMinutes: sql`excluded.running_time_minutes`,
              ageGuidance: sql`excluded.age_guidance`,
            },
          }),
    );

    await insertBatched(
      graph.events.flatMap((e) =>
        e.performances.map((p) => ({
          id: p.id,
          venueId: e.venueId,
          eventId: e.id,
          layoutId: p.layoutId,
          startsAt: p.startsAt,
          accessTags: [...p.accessTags],
        })),
      ),
      (rows) =>
        tx
          .insert(performance)
          .values(rows)
          .onConflictDoUpdate({
            target: performance.id,
            set: {
              layoutId: sql`excluded.layout_id`,
              startsAt: sql`excluded.starts_at`,
              accessTags: sql`excluded.access_tags`,
            },
          }),
    );
  });
}

/** Validates, migrates, then writes. Throws (writing nothing) if the graph breaks an invariant. */
export async function seedDatabase(url: string, graph: VenueGraph = buildSeed()): Promise<void> {
  const problems = validateSeed(graph);
  if (problems.length > 0) {
    throw new Error(`Seed data breaks domain invariants:\n${problems.join("\n")}`);
  }
  await runMigrations(url);
  const { db, close } = createDb(url);
  try {
    await writeSeed(db, graph);
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const { DATABASE_URL } = parseEnv(process.env);
  if (DATABASE_URL === PLACEHOLDER_URL) {
    throw new Error("DATABASE_URL is not set (or is the placeholder default). Refusing to seed.");
  }
  const graph = buildSeed();
  await seedDatabase(DATABASE_URL, graph);
  const seats = graph.layouts.reduce(
    (n, l) => n + l.sections.reduce((m, s) => m + s.seats.length, 0),
    0,
  );
  console.log(
    `Seeded ${graph.venues.length} venues, ${graph.layouts.length} layouts, ${seats} seats, ${graph.events.length} events.`,
  );
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Seeding failed");
    process.exit(1);
  });
}
