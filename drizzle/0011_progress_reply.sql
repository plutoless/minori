ALTER TABLE "processed_events" ADD COLUMN "progress_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN "progress_message_id" text;