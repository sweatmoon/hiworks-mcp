ALTER TABLE "daily_worklogs" DROP CONSTRAINT "daily_worklogs_work_date_unique";--> statement-breakpoint
ALTER TABLE "email_sync_state" DROP CONSTRAINT "email_sync_state_source_unique";--> statement-breakpoint
DROP INDEX "emails_dedup_key_uq";--> statement-breakpoint
DROP INDEX "emails_source_uid_uq";--> statement-breakpoint
DROP INDEX "emails_direction_sent_at_idx";--> statement-breakpoint
DROP INDEX "sync_runs_source_started_idx";--> statement-breakpoint
DROP INDEX "tasks_status_due_idx";--> statement-breakpoint
DROP INDEX "work_activities_date_idx";--> statement-breakpoint
ALTER TABLE "daily_worklogs" ADD COLUMN "account" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_sync_state" ADD COLUMN "account" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "account" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "account" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "account" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_activities" ADD COLUMN "account" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "daily_worklogs_account_work_date_uq" ON "daily_worklogs" USING btree ("account","work_date");--> statement-breakpoint
CREATE UNIQUE INDEX "email_sync_state_account_source_uq" ON "email_sync_state" USING btree ("account","source");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_account_dedup_key_uq" ON "emails" USING btree ("account","dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "emails_account_source_uid_uq" ON "emails" USING btree ("account","source","source_uid") WHERE "emails"."source_uid" is not null;--> statement-breakpoint
CREATE INDEX "emails_account_direction_sent_at_idx" ON "emails" USING btree ("account","direction","sent_at");--> statement-breakpoint
CREATE INDEX "sync_runs_account_source_started_idx" ON "sync_runs" USING btree ("account","source","started_at");--> statement-breakpoint
CREATE INDEX "tasks_account_status_due_idx" ON "tasks" USING btree ("account","status","due_date");--> statement-breakpoint
CREATE INDEX "work_activities_account_date_idx" ON "work_activities" USING btree ("account","activity_date");