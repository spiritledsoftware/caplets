ALTER TABLE "caplets"."cp_caplet" ADD COLUMN "installation_provenance_id" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_id" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_source_kind" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_source" jsonb;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_content_hash" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_runtime_fingerprint" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_installed_at" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_resolved_revision" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_risk_summary" jsonb;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD COLUMN "provenance_owner_id" text;--> statement-breakpoint
UPDATE "caplets"."cp_host_setting"
SET
  "provenance_id" = 'legacy:' || "id",
  "provenance_source_kind" = 'schema-v1',
  "provenance_source" = '{}'::jsonb,
  "provenance_content_hash" = repeat('0', 64),
  "provenance_risk_summary" = '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ALTER COLUMN "provenance_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ALTER COLUMN "provenance_source_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ALTER COLUMN "provenance_source" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ALTER COLUMN "provenance_content_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_caplet" ADD CONSTRAINT "cp_caplet_installation_provenance_id_nonempty_check" CHECK (length("caplets"."cp_caplet"."installation_provenance_id") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_provenance_id_nonempty_check" CHECK (length("caplets"."cp_host_setting"."provenance_id") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_provenance_source_kind_nonempty_check" CHECK (length("caplets"."cp_host_setting"."provenance_source_kind") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_provenance_content_hash_hash_check" CHECK ("caplets"."cp_host_setting"."provenance_content_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_provenance_runtime_fingerprint_hash_check" CHECK ("caplets"."cp_host_setting"."provenance_runtime_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_provenance_installed_at_nonempty_check" CHECK (length("caplets"."cp_host_setting"."provenance_installed_at") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_provenance_resolved_revision_nonempty_check" CHECK (length("caplets"."cp_host_setting"."provenance_resolved_revision") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_provenance_owner_id_nonempty_check" CHECK (length("caplets"."cp_host_setting"."provenance_owner_id") > 0);