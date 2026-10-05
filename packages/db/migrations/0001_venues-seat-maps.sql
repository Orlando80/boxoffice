CREATE TYPE "public"."access_feature" AS ENUM('wheelchair_space', 'transfer_seat', 'step_free', 'aisle', 'extra_legroom', 'hearing_loop', 'near_exit');--> statement-breakpoint
CREATE TYPE "public"."performance_access_tag" AS ENUM('relaxed', 'captioned', 'bsl_interpreted', 'audio_described');--> statement-breakpoint
CREATE TYPE "public"."section_kind" AS ENUM('reserved', 'ga');--> statement-breakpoint
CREATE TABLE "companion_link" (
	"venue_id" uuid NOT NULL,
	"access_seat_id" uuid NOT NULL,
	"companion_seat_id" uuid NOT NULL,
	CONSTRAINT "companion_link_access_seat_id_unique" UNIQUE("access_seat_id"),
	CONSTRAINT "companion_link_companion_seat_id_unique" UNIQUE("companion_seat_id"),
	CONSTRAINT "companion_link_distinct_ck" CHECK ("companion_link"."access_seat_id" <> "companion_link"."companion_seat_id")
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"running_time_minutes" integer,
	"age_guidance" text,
	CONSTRAINT "event_venue_id_id_uq" UNIQUE("venue_id","id"),
	CONSTRAINT "event_venue_slug_uq" UNIQUE("venue_id","slug")
);
--> statement-breakpoint
CREATE TABLE "layout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "layout_venue_id_id_uq" UNIQUE("venue_id","id")
);
--> statement-breakpoint
CREATE TABLE "performance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"layout_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"access_tags" "performance_access_tag"[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seat" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"row_label" text NOT NULL,
	"seat_label" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	CONSTRAINT "seat_venue_id_id_uq" UNIQUE("venue_id","id"),
	CONSTRAINT "seat_section_row_seat_uq" UNIQUE("section_id","row_label","seat_label")
);
--> statement-breakpoint
CREATE TABLE "seat_access_feature" (
	"venue_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"feature" "access_feature" NOT NULL,
	CONSTRAINT "seat_access_feature_uq" UNIQUE("seat_id","feature")
);
--> statement-breakpoint
CREATE TABLE "section" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"layout_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "section_kind" NOT NULL,
	"ga_capacity" integer,
	CONSTRAINT "section_venue_id_id_uq" UNIQUE("venue_id","id"),
	CONSTRAINT "section_ga_capacity_ck" CHECK (("section"."kind" = 'ga') = ("section"."ga_capacity" IS NOT NULL) AND ("section"."ga_capacity" IS NULL OR "section"."ga_capacity" >= 1))
);
--> statement-breakpoint
CREATE TABLE "venue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"time_zone" text NOT NULL,
	CONSTRAINT "venue_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "companion_link" ADD CONSTRAINT "companion_link_access_seat_fk" FOREIGN KEY ("venue_id","access_seat_id") REFERENCES "public"."seat"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_link" ADD CONSTRAINT "companion_link_companion_seat_fk" FOREIGN KEY ("venue_id","companion_seat_id") REFERENCES "public"."seat"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_venue_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layout" ADD CONSTRAINT "layout_venue_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance" ADD CONSTRAINT "performance_event_fk" FOREIGN KEY ("venue_id","event_id") REFERENCES "public"."event"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance" ADD CONSTRAINT "performance_layout_fk" FOREIGN KEY ("venue_id","layout_id") REFERENCES "public"."layout"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat" ADD CONSTRAINT "seat_section_fk" FOREIGN KEY ("venue_id","section_id") REFERENCES "public"."section"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_access_feature" ADD CONSTRAINT "seat_access_feature_seat_fk" FOREIGN KEY ("venue_id","seat_id") REFERENCES "public"."seat"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section" ADD CONSTRAINT "section_layout_fk" FOREIGN KEY ("venue_id","layout_id") REFERENCES "public"."layout"("venue_id","id") ON DELETE no action ON UPDATE no action;