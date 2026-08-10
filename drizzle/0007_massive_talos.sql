ALTER TABLE "agent_runs" ADD COLUMN "team_context_status" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "team_context_revision" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "team_context_token_count" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "team_context_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "team_context_error_category" text;