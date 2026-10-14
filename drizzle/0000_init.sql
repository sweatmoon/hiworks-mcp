CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."email_direction" AS ENUM('sent', 'received');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('idle', 'running', 'ok', 'error');--> statement-breakpoint
CREATE TABLE "daily_worklogs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"work_date" date NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_worklogs_work_date_unique" UNIQUE("work_date")
);
--> statement-breakpoint
CREATE TABLE "email_attachments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email_id" bigint NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sync_state" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_uid" text,
	"status" "sync_status" DEFAULT 'idle' NOT NULL,
	"error_message" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_sync_state_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" text,
	"dedup_key" text NOT NULL,
	"direction" "email_direction" NOT NULL,
	"source" text NOT NULL,
	"source_uid" text,
	"sender" text DEFAULT '' NOT NULL,
	"sender_email" text DEFAULT '' NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipient_emails" text[] DEFAULT '{}' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"body_html" text,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"size_bytes" integer,
	"thread_key" text DEFAULT '' NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"project_name" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce(subject, '')), 'A') || setweight(to_tsvector('simple', left(coalesce(body_text, ''), 100000)), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_activities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email_id" bigint,
	"activity_date" date NOT NULL,
	"project_name" text,
	"activity_type" text DEFAULT 'other' NOT NULL,
	"description" text NOT NULL,
	"evidence_email_ids" bigint[] DEFAULT '{}' NOT NULL,
	"thread_key" text,
	"needs_review" boolean DEFAULT false NOT NULL,
	"confidence" real,
	"extractor" text DEFAULT 'llm' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_activities" ADD CONSTRAINT "work_activities_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_attachments_email_id_idx" ON "email_attachments" USING btree ("email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_dedup_key_uq" ON "emails" USING btree ("dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_source_uid_uq" ON "emails" USING btree ("source","source_uid") WHERE "emails"."source_uid" is not null;--> statement-breakpoint
CREATE INDEX "emails_message_id_idx" ON "emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "emails_direction_sent_at_idx" ON "emails" USING btree ("direction","sent_at");--> statement-breakpoint
CREATE INDEX "emails_sender_email_idx" ON "emails" USING btree ("sender_email");--> statement-breakpoint
CREATE INDEX "emails_thread_key_idx" ON "emails" USING btree ("thread_key");--> statement-breakpoint
CREATE INDEX "emails_project_idx" ON "emails" USING btree ("project_name");--> statement-breakpoint
CREATE INDEX "emails_search_vector_idx" ON "emails" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "emails_subject_trgm_idx" ON "emails" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "emails_body_trgm_idx" ON "emails" USING gin ("body_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "emails_recipient_emails_idx" ON "emails" USING gin ("recipient_emails");--> statement-breakpoint
CREATE INDEX "sync_runs_source_started_idx" ON "sync_runs" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "work_activities_date_idx" ON "work_activities" USING btree ("activity_date");--> statement-breakpoint
CREATE INDEX "work_activities_project_idx" ON "work_activities" USING btree ("project_name");