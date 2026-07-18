ALTER TABLE "vault_access_grants" ADD COLUMN "subject_kind" text;--> statement-breakpoint
ALTER TABLE "vault_access_grants" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "vault_access_grants" ADD COLUMN "caplet_id" text;--> statement-breakpoint
UPDATE "vault_access_grants" SET "subject_kind" = 'record', "subject_key" = "record_key";--> statement-breakpoint
ALTER TABLE "vault_access_grants" ALTER COLUMN "subject_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_access_grants" ALTER COLUMN "subject_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_access_grants" DROP CONSTRAINT "vault_access_grants_record_key_reference_name_pk";--> statement-breakpoint
ALTER TABLE "vault_access_grants" ALTER COLUMN "record_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "vault_access_grants" ADD CONSTRAINT "vault_access_grants_subject_kind_subject_key_reference_name_pk" PRIMARY KEY("subject_kind","subject_key","reference_name");