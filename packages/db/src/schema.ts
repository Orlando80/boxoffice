import {
  ACCESS_FEATURES,
  HOLD_STATUSES,
  MAX_EXTENSIONS,
  PERFORMANCE_ACCESS_TAGS,
  SEAT_ROLES,
} from "@boxoffice/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const accessFeatureEnum = pgEnum("access_feature", ACCESS_FEATURES);
export const performanceAccessTagEnum = pgEnum("performance_access_tag", [
  ...PERFORMANCE_ACCESS_TAGS,
] as [string, ...string[]]);
export const sectionKindEnum = pgEnum("section_kind", ["reserved", "ga"]);
export const holdStatusEnum = pgEnum("hold_status", HOLD_STATUSES);
export const seatRoleEnum = pgEnum("seat_role", SEAT_ROLES);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

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
    unique("performance_venue_id_id_uq").on(t.venueId, t.id),
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

export const hold = pgTable(
  "hold",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id").notNull(),
    performanceId: uuid("performance_id").notNull(),
    tokenHash: bytea("token_hash").notNull().unique(),
    status: holdStatusEnum("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    extensionsUsed: integer("extensions_used").notNull().default(0),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    unique("hold_venue_id_id_performance_uq").on(t.venueId, t.id, t.performanceId),
    unique("hold_venue_id_id_uq").on(t.venueId, t.id),
    foreignKey({
      name: "hold_performance_fk",
      columns: [t.venueId, t.performanceId],
      foreignColumns: [performance.venueId, performance.id],
    }),
    check("hold_status_ended_at_ck", sql`(${t.status} = 'active') = (${t.endedAt} IS NULL)`),
    check(
      "hold_extensions_used_ck",
      sql`${t.extensionsUsed} BETWEEN 0 AND ${sql.raw(String(MAX_EXTENSIONS))}`,
    ),
  ],
);

export const holdSeat = pgTable(
  "hold_seat",
  {
    venueId: uuid("venue_id").notNull(),
    holdId: uuid("hold_id").notNull(),
    performanceId: uuid("performance_id").notNull(),
    seatId: uuid("seat_id").notNull(),
    role: seatRoleEnum("role").notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("hold_seat_active_uq")
      .on(t.performanceId, t.seatId)
      .where(sql`${t.endedAt} IS NULL`),
    foreignKey({
      name: "hold_seat_hold_fk",
      columns: [t.venueId, t.holdId, t.performanceId],
      foreignColumns: [hold.venueId, hold.id, hold.performanceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "hold_seat_seat_fk",
      columns: [t.venueId, t.seatId],
      foreignColumns: [seat.venueId, seat.id],
    }),
  ],
);

export const holdGa = pgTable(
  "hold_ga",
  {
    venueId: uuid("venue_id").notNull(),
    holdId: uuid("hold_id").notNull(),
    performanceId: uuid("performance_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    quantity: integer("quantity").notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "hold_ga_hold_fk",
      columns: [t.venueId, t.holdId, t.performanceId],
      foreignColumns: [hold.venueId, hold.id, hold.performanceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "hold_ga_section_fk",
      columns: [t.venueId, t.sectionId],
      foreignColumns: [section.venueId, section.id],
    }),
    check("hold_ga_quantity_ck", sql`${t.quantity} >= 1`),
  ],
);

export const gaInventory = pgTable(
  "ga_inventory",
  {
    venueId: uuid("venue_id").notNull(),
    performanceId: uuid("performance_id").notNull(),
    sectionId: uuid("section_id").notNull(),
    capacity: integer("capacity").notNull(),
    held: integer("held").notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "ga_inventory_pk", columns: [t.performanceId, t.sectionId] }),
    foreignKey({
      name: "ga_inventory_performance_fk",
      columns: [t.venueId, t.performanceId],
      foreignColumns: [performance.venueId, performance.id],
    }),
    foreignKey({
      name: "ga_inventory_section_fk",
      columns: [t.venueId, t.sectionId],
      foreignColumns: [section.venueId, section.id],
    }),
    check("ga_inventory_capacity_ck", sql`${t.capacity} >= 1`),
    check("ga_inventory_held_ck", sql`${t.held} BETWEEN 0 AND ${t.capacity}`),
  ],
);

export const holdAccessNeed = pgTable(
  "hold_access_need",
  {
    venueId: uuid("venue_id").notNull(),
    holdId: uuid("hold_id").notNull(),
    seatId: uuid("seat_id").notNull(),
    need: accessFeatureEnum("need").notNull(),
  },
  (t) => [
    foreignKey({
      name: "hold_access_need_hold_fk",
      columns: [t.venueId, t.holdId],
      foreignColumns: [hold.venueId, hold.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "hold_access_need_seat_fk",
      columns: [t.venueId, t.seatId],
      foreignColumns: [seat.venueId, seat.id],
    }),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    venueId: uuid("venue_id").notNull(),
    type: text("type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
  },
  (t) => [
    foreignKey({
      name: "outbox_venue_fk",
      columns: [t.venueId],
      foreignColumns: [venue.id],
    }),
    index("outbox_unpublished_idx")
      .on(t.nextAttemptAt, t.id)
      .where(sql`${t.publishedAt} IS NULL`),
  ],
);
