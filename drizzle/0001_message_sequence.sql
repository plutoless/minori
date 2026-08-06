DROP INDEX "messages_conversation_created_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sequence" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_sequence_idx" ON "messages" USING btree ("conversation_id","sequence");