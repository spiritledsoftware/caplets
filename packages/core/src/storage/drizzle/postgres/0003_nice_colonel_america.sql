ALTER TABLE "vault_access_grants" ADD COLUMN "reference_name" text;--> statement-breakpoint
UPDATE "vault_access_grants" SET "reference_name" = "vault_key";--> statement-breakpoint
ALTER TABLE "vault_access_grants" ALTER COLUMN "reference_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_access_grants" DROP CONSTRAINT "vault_access_grants_record_key_vault_key_pk";--> statement-breakpoint
ALTER TABLE "vault_access_grants" ADD CONSTRAINT "vault_access_grants_record_key_reference_name_pk" PRIMARY KEY("record_key","reference_name");