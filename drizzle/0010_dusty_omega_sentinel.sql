ALTER TABLE "scheduled_runs" ADD COLUMN "prepared_result_text" text;--> statement-breakpoint
ALTER TABLE "scheduled_runs" ADD COLUMN "fallback_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_runs" ADD COLUMN "fallback_message_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_runs" ADD COLUMN "fallback_outcome_category" text;