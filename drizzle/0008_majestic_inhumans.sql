CREATE TABLE "scheduled_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"task_version" integer NOT NULL,
	"instruction" text NOT NULL,
	"result_chat_id" text NOT NULL,
	"result_display_name" text NOT NULL,
	"result_chat_type" text NOT NULL,
	"context_chat_id" text,
	"context_display_name" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"claim_attempt" integer DEFAULT 0 NOT NULL,
	"leased_until" timestamp with time zone,
	"write_started_at" timestamp with time zone,
	"delivery_idempotency_key" text,
	"delivery_attempted_at" timestamp with time zone,
	"delivery_message_id" text,
	"outcome_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_task_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"actor_open_id" text NOT NULL,
	"instruction" text,
	"schedule_kind" text NOT NULL,
	"once_at" timestamp with time zone,
	"cron_expression" text,
	"timezone" text NOT NULL,
	"result_chat_id" text NOT NULL,
	"result_display_name" text NOT NULL,
	"result_chat_type" text NOT NULL,
	"context_chat_id" text,
	"context_display_name" text,
	"body_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"creator_open_id" text NOT NULL,
	"origin_chat_id" text NOT NULL,
	"origin_display_name" text NOT NULL,
	"origin_chat_type" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"schedule_kind" text NOT NULL,
	"once_at" timestamp with time zone,
	"cron_expression" text,
	"timezone" text NOT NULL,
	"result_chat_id" text NOT NULL,
	"result_display_name" text NOT NULL,
	"result_chat_type" text NOT NULL,
	"context_chat_id" text,
	"context_display_name" text,
	"state" text DEFAULT 'active' NOT NULL,
	"name_reserved" boolean DEFAULT true NOT NULL,
	"next_due_at" timestamp with time zone,
	"latest_missed_at" timestamp with time zone,
	"latest_run_status" text,
	"completed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"body_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_runs" ADD CONSTRAINT "scheduled_runs_schedule_id_scheduled_tasks_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_task_revisions" ADD CONSTRAINT "scheduled_task_revisions_schedule_id_scheduled_tasks_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."scheduled_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_runs_schedule_occurrence_unique" ON "scheduled_runs" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_runs_one_active_per_task" ON "scheduled_runs" USING btree ("schedule_id") WHERE "scheduled_runs"."status" in ('queued', 'processing');--> statement-breakpoint
CREATE INDEX "scheduled_runs_ready_idx" ON "scheduled_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_task_revisions_schedule_version_unique" ON "scheduled_task_revisions" USING btree ("schedule_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_tasks_reserved_name_unique" ON "scheduled_tasks" USING btree (lower("name")) WHERE "scheduled_tasks"."name_reserved" = true;--> statement-breakpoint
CREATE INDEX "scheduled_tasks_due_idx" ON "scheduled_tasks" USING btree ("state","next_due_at");