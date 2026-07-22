ALTER TABLE "remote_clients" ADD COLUMN "generation" integer;--> statement-breakpoint
UPDATE "remote_clients" SET "generation" = 1;--> statement-breakpoint
ALTER TABLE "remote_clients" ALTER COLUMN "generation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_pending_logins" ADD COLUMN "generation" integer;--> statement-breakpoint
UPDATE "remote_pending_logins" SET "generation" = 1;--> statement-breakpoint
ALTER TABLE "remote_pending_logins" ALTER COLUMN "generation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_access_grants" ADD COLUMN "resource_version" text;--> statement-breakpoint
UPDATE "vault_access_grants"
SET "resource_version" = 'legacy-v16-' || encode(convert_to(
	char_length("subject_kind")::text || ':' || "subject_kind" ||
	char_length("subject_key")::text || ':' || "subject_key" ||
	char_length("reference_name")::text || ':' || "reference_name",
	'UTF8'
), 'hex');--> statement-breakpoint
ALTER TABLE "vault_access_grants" ALTER COLUMN "resource_version" SET NOT NULL;