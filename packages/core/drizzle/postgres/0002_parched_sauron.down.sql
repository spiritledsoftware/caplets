DROP FUNCTION "caplets"."cp_purge_expired_operator_activity"(text, text, text, bigint, integer);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "caplets"."reject_operator_activity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, caplets
AS $$
BEGIN
	RAISE EXCEPTION 'operator activity is append-only';
END;
$$;--> statement-breakpoint
DROP INDEX "caplets"."cp_vault_grant_semantic_uq";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "caplets"."cp_vault_grant"
		GROUP BY "logical_host_id", "reference_name", "caplet_id"
		HAVING COUNT(*) > 1
	) THEN
		RAISE EXCEPTION 'schema-3 Vault grants require verified-backup restore for downgrade';
	END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "cp_vault_grant_semantic_uq" ON "caplets"."cp_vault_grant" USING btree ("logical_host_id","reference_name","caplet_id");--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" DROP COLUMN "client_label", DROP COLUMN "host_url", DROP COLUMN "granted_role", DROP COLUMN "requested_role", DROP COLUMN "key_version", DROP COLUMN "verifier_version", DROP COLUMN "algorithm", DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "caplets"."cp_operator_activity" DROP COLUMN "expires_at";--> statement-breakpoint
DROP INDEX "caplets"."cp_operator_activity_query_3_idx";--> statement-breakpoint
CREATE INDEX "cp_operator_activity_query_2_idx" ON "caplets"."cp_operator_activity" USING btree ("logical_host_id","action");--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" DROP COLUMN "aad_version", DROP COLUMN "algorithm", DROP COLUMN "auth_tag", DROP COLUMN "nonce";--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" DROP COLUMN "idle_expires_at", DROP COLUMN "absolute_expires_at", DROP COLUMN "csrf_key_version", DROP COLUMN "csrf_algorithm", DROP COLUMN "csrf_verifier", DROP COLUMN "key_version", DROP COLUMN "verifier_version", DROP COLUMN "algorithm";--> statement-breakpoint
ALTER TABLE "caplets"."cp_credential" DROP COLUMN "verifier_version", DROP COLUMN "algorithm";--> statement-breakpoint
ALTER TABLE "caplets"."cp_client" DROP COLUMN "client_label", DROP COLUMN "host_url";--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" DROP COLUMN "destruction_id", DROP COLUMN "destroyed_at", DROP COLUMN "key_algorithm", DROP COLUMN "key_purpose";--> statement-breakpoint
DROP TABLE "caplets"."cp_key_canary";--> statement-breakpoint
DROP TABLE "caplets"."cp_key_inventory";
