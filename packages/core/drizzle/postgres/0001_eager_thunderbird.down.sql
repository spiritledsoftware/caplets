ALTER TABLE "caplets"."cp_caplet" DROP CONSTRAINT "cp_caplet_installation_provenance_id_nonempty_check";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_provenance_id_nonempty_check";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_provenance_source_kind_nonempty_check";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_provenance_content_hash_hash_check";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_provenance_runtime_fingerprint_hash_check";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_provenance_installed_at_nonempty_check";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_provenance_resolved_revision_nonempty_check";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_provenance_owner_id_nonempty_check";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_owner_id";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_risk_summary";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_resolved_revision";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_installed_at";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_runtime_fingerprint";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_content_hash";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_source";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_source_kind";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP COLUMN "provenance_id";
--> statement-breakpoint
ALTER TABLE "caplets"."cp_caplet" DROP COLUMN "installation_provenance_id";
