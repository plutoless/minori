ALTER TABLE "processed_events" ADD COLUMN "write_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_runs" ADD COLUMN "result_identifiers" jsonb;