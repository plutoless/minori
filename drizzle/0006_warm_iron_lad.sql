CREATE TABLE "team_context_snapshots" (
	"document_token" text PRIMARY KEY NOT NULL,
	"source_revision" integer,
	"normalized_content" text,
	"estimated_tokens" integer,
	"fetched_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_category" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
