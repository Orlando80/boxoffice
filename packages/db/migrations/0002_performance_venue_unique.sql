CREATE TYPE "public"."hold_status" AS ENUM('active', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."seat_role" AS ENUM('standard', 'access', 'companion');--> statement-breakpoint
ALTER TABLE "performance" ADD CONSTRAINT "performance_venue_id_id_uq" UNIQUE("venue_id","id");