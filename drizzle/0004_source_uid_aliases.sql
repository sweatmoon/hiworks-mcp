CREATE TABLE "source_uid_aliases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account" text DEFAULT 'main' NOT NULL,
	"source" text NOT NULL,
	"source_uid" text NOT NULL,
	"email_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_uid_aliases" ADD CONSTRAINT "source_uid_aliases_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_uid_aliases_account_source_uid_uq" ON "source_uid_aliases" USING btree ("account","source","source_uid");--> statement-breakpoint
CREATE INDEX "source_uid_aliases_email_id_idx" ON "source_uid_aliases" USING btree ("email_id");