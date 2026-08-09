ALTER TABLE "agent_runs" ADD COLUMN "group_history_status" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "group_history_message_count" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "group_history_page_count" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "group_history_cutoff" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "group_history_error_category" text;