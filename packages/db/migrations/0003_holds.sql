CREATE TABLE "ga_inventory" (
	"venue_id" uuid NOT NULL,
	"performance_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"capacity" integer NOT NULL,
	"held" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ga_inventory_pk" PRIMARY KEY("performance_id","section_id"),
	CONSTRAINT "ga_inventory_capacity_ck" CHECK ("ga_inventory"."capacity" >= 1),
	CONSTRAINT "ga_inventory_held_ck" CHECK ("ga_inventory"."held" BETWEEN 0 AND "ga_inventory"."capacity")
);
--> statement-breakpoint
CREATE TABLE "hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"performance_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"status" "hold_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"extensions_used" integer DEFAULT 0 NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "hold_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "hold_venue_id_id_performance_uq" UNIQUE("venue_id","id","performance_id"),
	CONSTRAINT "hold_venue_id_id_uq" UNIQUE("venue_id","id"),
	CONSTRAINT "hold_status_ended_at_ck" CHECK (("hold"."status" = 'active') = ("hold"."ended_at" IS NULL)),
	CONSTRAINT "hold_extensions_used_ck" CHECK ("hold"."extensions_used" BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE TABLE "hold_access_need" (
	"venue_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"need" "access_feature" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hold_ga" (
	"venue_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"performance_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "hold_ga_quantity_ck" CHECK ("hold_ga"."quantity" >= 1)
);
--> statement-breakpoint
CREATE TABLE "hold_seat" (
	"venue_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"performance_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"role" "seat_role" NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"venue_id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "ga_inventory" ADD CONSTRAINT "ga_inventory_performance_fk" FOREIGN KEY ("venue_id","performance_id") REFERENCES "public"."performance"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga_inventory" ADD CONSTRAINT "ga_inventory_section_fk" FOREIGN KEY ("venue_id","section_id") REFERENCES "public"."section"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold" ADD CONSTRAINT "hold_performance_fk" FOREIGN KEY ("venue_id","performance_id") REFERENCES "public"."performance"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_access_need" ADD CONSTRAINT "hold_access_need_hold_fk" FOREIGN KEY ("venue_id","hold_id") REFERENCES "public"."hold"("venue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_access_need" ADD CONSTRAINT "hold_access_need_seat_fk" FOREIGN KEY ("venue_id","seat_id") REFERENCES "public"."seat"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_ga" ADD CONSTRAINT "hold_ga_hold_fk" FOREIGN KEY ("venue_id","hold_id","performance_id") REFERENCES "public"."hold"("venue_id","id","performance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_ga" ADD CONSTRAINT "hold_ga_section_fk" FOREIGN KEY ("venue_id","section_id") REFERENCES "public"."section"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_seat" ADD CONSTRAINT "hold_seat_hold_fk" FOREIGN KEY ("venue_id","hold_id","performance_id") REFERENCES "public"."hold"("venue_id","id","performance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hold_seat" ADD CONSTRAINT "hold_seat_seat_fk" FOREIGN KEY ("venue_id","seat_id") REFERENCES "public"."seat"("venue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_venue_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hold_seat_active_uq" ON "hold_seat" USING btree ("performance_id","seat_id") WHERE "hold_seat"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("next_attempt_at","id") WHERE "outbox"."published_at" IS NULL;