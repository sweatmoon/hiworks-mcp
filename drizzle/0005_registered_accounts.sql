CREATE TABLE "registered_accounts" (
	"key" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_enc" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registered_accounts_email_unique" UNIQUE("email")
);
