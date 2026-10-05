import { ACCESS_FEATURES, PERFORMANCE_ACCESS_TAGS } from "@boxoffice/domain";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const accessFeatureEnum = pgEnum("access_feature", ACCESS_FEATURES);
export const performanceAccessTagEnum = pgEnum("performance_access_tag", [
  ...PERFORMANCE_ACCESS_TAGS,
] as [string, ...string[]]);
export const sectionKindEnum = pgEnum("section_kind", ["reserved", "ga"]);

export const venue = pgTable("venue", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  timeZone: text("time_zone").notNull(),
});

export const layout = pgTable(
  "layout",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [
    unique("layout_venue_id_id_uq").on(t.venueId, t.id),
    foreignKey({
      name: "layout_venue_fk",
      columns: [t.venueId],
      foreignColumns: [venue.id],
    }),
  ],
);

export const section = pgTable(
  "section",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id").notNull(),
    layoutId: uuid("layout_id").notNull(),
    name: text("name").notNull(),
    kind: sectionKindEnum("kind").notNull(),
    gaCapacity: integer("ga_capacity"),
  },
  (t) => [
    unique("section_venue_id_id_uq").on(t.venueId, t.id),
    foreignKey({
      name: "section_layout_fk",
      columns: [t.venueId, t.layoutId],
      foreignColumns: [layout.venueId, layout.id],
    }),
    check(
      "section_ga_capacity_ck",
      sql`(${t.kind} = 'ga') = (${t.gaCapacity} IS NOT NULL) AND (${t.gaCapacity} IS NULL OR ${t.gaCapacity} >= 1)`,
    ),
  ],
);

export const seat = pgTable(
  "seat",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    rowLabel: text("row_label").notNull(),
    seatLabel: text("seat_label").notNull(),
    x: integer("x").notNull(),
    y: integer("y").notNull(),
  },
  (t) => [
    unique("seat_venue_id_id_uq").on(t.venueId, t.id),
    unique("seat_section_row_seat_uq").on(t.sectionId, t.rowLabel, t.seatLabel),
    foreignKey({
      name: "seat_section_fk",
      columns: [t.venueId, t.sectionId],
      foreignColumns: [section.venueId, section.id],
    }),
  ],
);

export const seatAccessFeature = pgTable(
  "seat_access_feature",
  {
    venueId: uuid("venue_id").notNull(),
    seatId: uuid("seat_id").notNull(),
    feature: accessFeatureEnum("feature").notNull(),
  },
  (t) => [
    unique("seat_access_feature_uq").on(t.seatId, t.feature),
    foreignKey({
      name: "seat_access_feature_seat_fk",
      columns: [t.venueId, t.seatId],
      foreignColumns: [seat.venueId, seat.id],
    }),
  ],
);

export const companionLink = pgTable(
  "companion_link",
  {
    venueId: uuid("venue_id").notNull(),
    accessSeatId: uuid("access_seat_id").notNull().unique(),
    companionSeatId: uuid("companion_seat_id").notNull().unique(),
  },
  (t) => [
    foreignKey({
      name: "companion_link_access_seat_fk",
      columns: [t.venueId, t.accessSeatId],
      foreignColumns: [seat.venueId, seat.id],
    }),
    foreignKey({
      name: "companion_link_companion_seat_fk",
      columns: [t.venueId, t.companionSeatId],
      foreignColumns: [seat.venueId, seat.id],
    }),
    check("companion_link_distinct_ck", sql`${t.accessSeatId} <> ${t.companionSeatId}`),
  ],
);

export const event = pgTable(
  "event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    runningTimeMinutes: integer("running_time_minutes"),
    ageGuidance: text("age_guidance"),
  },
  (t) => [
    unique("event_venue_id_id_uq").on(t.venueId, t.id),
    unique("event_venue_slug_uq").on(t.venueId, t.slug),
    foreignKey({
      name: "event_venue_fk",
      columns: [t.venueId],
      foreignColumns: [venue.id],
    }),
  ],
);

export const performance = pgTable(
  "performance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id").notNull(),
    eventId: uuid("event_id").notNull(),
    layoutId: uuid("layout_id").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    accessTags: performanceAccessTagEnum("access_tags").array().notNull().default(sql`'{}'`),
  },
  (t) => [
    foreignKey({
      name: "performance_event_fk",
      columns: [t.venueId, t.eventId],
      foreignColumns: [event.venueId, event.id],
    }),
    foreignKey({
      name: "performance_layout_fk",
      columns: [t.venueId, t.layoutId],
      foreignColumns: [layout.venueId, layout.id],
    }),
  ],
);
