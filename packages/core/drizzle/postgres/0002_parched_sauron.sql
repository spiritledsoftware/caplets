CREATE TABLE "caplets"."cp_key_canary" (
	"model_version" bigint NOT NULL,
	"id" text NOT NULL,
	"logical_host_id" text NOT NULL,
	"store_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"authority_version" bigint NOT NULL,
	"effective_version" bigint NOT NULL,
	"security_version" bigint NOT NULL,
	"purpose" text NOT NULL,
	"algorithm" text NOT NULL,
	"key_version" bigint NOT NULL,
	"protection" text NOT NULL,
	"label_hash" text NOT NULL,
	"aad_version" bigint NOT NULL,
	"nonce" "bytea",
	"ciphertext" "bytea",
	"auth_tag" "bytea",
	"verifier" "bytea",
	"state" text NOT NULL,
	CONSTRAINT "cp_key_canary_pk" PRIMARY KEY("logical_host_id","id"),
	CONSTRAINT "cp_key_canary_model_version_version_check" CHECK ("caplets"."cp_key_canary"."model_version" >= 0),
	CONSTRAINT "cp_key_canary_id_nonempty_check" CHECK (length("caplets"."cp_key_canary"."id") > 0),
	CONSTRAINT "cp_key_canary_logical_host_id_nonempty_check" CHECK (length("caplets"."cp_key_canary"."logical_host_id") > 0),
	CONSTRAINT "cp_key_canary_store_id_nonempty_check" CHECK (length("caplets"."cp_key_canary"."store_id") > 0),
	CONSTRAINT "cp_key_canary_created_at_nonempty_check" CHECK (length("caplets"."cp_key_canary"."created_at") > 0),
	CONSTRAINT "cp_key_canary_updated_at_nonempty_check" CHECK (length("caplets"."cp_key_canary"."updated_at") > 0),
	CONSTRAINT "cp_key_canary_aggregate_version_version_check" CHECK ("caplets"."cp_key_canary"."aggregate_version" >= 0),
	CONSTRAINT "cp_key_canary_authority_version_version_check" CHECK ("caplets"."cp_key_canary"."authority_version" >= 0),
	CONSTRAINT "cp_key_canary_effective_version_version_check" CHECK ("caplets"."cp_key_canary"."effective_version" >= 0),
	CONSTRAINT "cp_key_canary_security_version_version_check" CHECK ("caplets"."cp_key_canary"."security_version" >= 0),
	CONSTRAINT "cp_key_canary_purpose_nonempty_check" CHECK (length("caplets"."cp_key_canary"."purpose") > 0),
	CONSTRAINT "cp_key_canary_algorithm_nonempty_check" CHECK (length("caplets"."cp_key_canary"."algorithm") > 0),
	CONSTRAINT "cp_key_canary_key_version_version_check" CHECK ("caplets"."cp_key_canary"."key_version" >= 0),
	CONSTRAINT "cp_key_canary_protection_nonempty_check" CHECK (length("caplets"."cp_key_canary"."protection") > 0),
	CONSTRAINT "cp_key_canary_label_hash_hash_check" CHECK ("caplets"."cp_key_canary"."label_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "cp_key_canary_aad_version_version_check" CHECK ("caplets"."cp_key_canary"."aad_version" >= 0),
	CONSTRAINT "cp_key_canary_nonce_bytes_check" CHECK (octet_length("caplets"."cp_key_canary"."nonce") > 0),
	CONSTRAINT "cp_key_canary_ciphertext_bytes_check" CHECK (octet_length("caplets"."cp_key_canary"."ciphertext") > 0),
	CONSTRAINT "cp_key_canary_auth_tag_bytes_check" CHECK (octet_length("caplets"."cp_key_canary"."auth_tag") > 0),
	CONSTRAINT "cp_key_canary_verifier_bytes_check" CHECK (octet_length("caplets"."cp_key_canary"."verifier") > 0),
	CONSTRAINT "cp_key_canary_state_nonempty_check" CHECK (length("caplets"."cp_key_canary"."state") > 0),
	CONSTRAINT "cp_key_canary_model_version_check" CHECK ("caplets"."cp_key_canary"."model_version" = 1),
	CONSTRAINT "cp_key_canary_state_check" CHECK ("caplets"."cp_key_canary"."state" = 'active'),
	CONSTRAINT "cp_key_canary_protection_check" CHECK (("caplets"."cp_key_canary"."protection" = 'aead' AND "caplets"."cp_key_canary"."nonce" IS NOT NULL AND "caplets"."cp_key_canary"."ciphertext" IS NOT NULL AND "caplets"."cp_key_canary"."auth_tag" IS NOT NULL AND "caplets"."cp_key_canary"."verifier" IS NULL) OR ("caplets"."cp_key_canary"."protection" = 'hmac' AND "caplets"."cp_key_canary"."nonce" IS NULL AND "caplets"."cp_key_canary"."ciphertext" IS NULL AND "caplets"."cp_key_canary"."auth_tag" IS NULL AND "caplets"."cp_key_canary"."verifier" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "caplets"."cp_key_inventory" (
	"model_version" bigint NOT NULL,
	"id" text NOT NULL,
	"logical_host_id" text NOT NULL,
	"store_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"aggregate_version" bigint NOT NULL,
	"authority_version" bigint NOT NULL,
	"effective_version" bigint NOT NULL,
	"security_version" bigint NOT NULL,
	"provider" text NOT NULL,
	"key_id" text NOT NULL,
	"purpose" text NOT NULL,
	"algorithm" text NOT NULL,
	"key_version" bigint NOT NULL,
	"state" text NOT NULL,
	"verified_node_ids" jsonb NOT NULL,
	"purge_watermark" bigint NOT NULL,
	"activated_at" text NOT NULL,
	"decrypt_only_at" text,
	"retired_at" text,
	"destroyed_at" text,
	"destruction_id" text,
	CONSTRAINT "cp_key_inventory_pk" PRIMARY KEY("logical_host_id","id"),
	CONSTRAINT "cp_key_inventory_relation_target_uq" UNIQUE("logical_host_id","purpose","key_version"),
	CONSTRAINT "cp_key_inventory_model_version_version_check" CHECK ("caplets"."cp_key_inventory"."model_version" >= 0),
	CONSTRAINT "cp_key_inventory_id_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."id") > 0),
	CONSTRAINT "cp_key_inventory_logical_host_id_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."logical_host_id") > 0),
	CONSTRAINT "cp_key_inventory_store_id_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."store_id") > 0),
	CONSTRAINT "cp_key_inventory_created_at_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."created_at") > 0),
	CONSTRAINT "cp_key_inventory_updated_at_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."updated_at") > 0),
	CONSTRAINT "cp_key_inventory_aggregate_version_version_check" CHECK ("caplets"."cp_key_inventory"."aggregate_version" >= 0),
	CONSTRAINT "cp_key_inventory_authority_version_version_check" CHECK ("caplets"."cp_key_inventory"."authority_version" >= 0),
	CONSTRAINT "cp_key_inventory_effective_version_version_check" CHECK ("caplets"."cp_key_inventory"."effective_version" >= 0),
	CONSTRAINT "cp_key_inventory_security_version_version_check" CHECK ("caplets"."cp_key_inventory"."security_version" >= 0),
	CONSTRAINT "cp_key_inventory_provider_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."provider") > 0),
	CONSTRAINT "cp_key_inventory_key_id_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."key_id") > 0),
	CONSTRAINT "cp_key_inventory_purpose_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."purpose") > 0),
	CONSTRAINT "cp_key_inventory_algorithm_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."algorithm") > 0),
	CONSTRAINT "cp_key_inventory_key_version_version_check" CHECK ("caplets"."cp_key_inventory"."key_version" >= 0),
	CONSTRAINT "cp_key_inventory_state_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."state") > 0),
	CONSTRAINT "cp_key_inventory_purge_watermark_version_check" CHECK ("caplets"."cp_key_inventory"."purge_watermark" >= 0),
	CONSTRAINT "cp_key_inventory_activated_at_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."activated_at") > 0),
	CONSTRAINT "cp_key_inventory_decrypt_only_at_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."decrypt_only_at") > 0),
	CONSTRAINT "cp_key_inventory_retired_at_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."retired_at") > 0),
	CONSTRAINT "cp_key_inventory_destroyed_at_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."destroyed_at") > 0),
	CONSTRAINT "cp_key_inventory_destruction_id_nonempty_check" CHECK (length("caplets"."cp_key_inventory"."destruction_id") > 0),
	CONSTRAINT "cp_key_inventory_model_version_check" CHECK ("caplets"."cp_key_inventory"."model_version" = 1),
	CONSTRAINT "cp_key_inventory_provider_check" CHECK ("caplets"."cp_key_inventory"."provider" = 'file-v1'),
	CONSTRAINT "cp_key_inventory_state_check" CHECK ("caplets"."cp_key_inventory"."state" IN ('active', 'decrypt-only', 'retired', 'destruction-intended', 'destroyed'))
);
--> statement-breakpoint
DROP INDEX "caplets"."cp_operator_activity_query_2_idx";--> statement-breakpoint
DROP INDEX "caplets"."cp_vault_grant_semantic_uq";--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ADD COLUMN "key_purpose" text DEFAULT 'backup-recovery' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ADD COLUMN "key_algorithm" text DEFAULT 'RSA-OAEP-256' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ADD COLUMN "destroyed_at" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ADD COLUMN "destruction_id" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_client" ADD COLUMN "host_url" text DEFAULT 'legacy-unbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_client" ADD COLUMN "client_label" text DEFAULT 'legacy-unbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_credential" ADD COLUMN "algorithm" text DEFAULT 'legacy-unclassified' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_credential" ADD COLUMN "verifier_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD COLUMN "algorithm" text DEFAULT 'legacy-invalidated' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD COLUMN "verifier_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD COLUMN "key_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD COLUMN "csrf_verifier" "bytea" DEFAULT '\x00' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD COLUMN "csrf_algorithm" text DEFAULT 'legacy-invalidated' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD COLUMN "csrf_key_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD COLUMN "absolute_expires_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD COLUMN "idle_expires_at" text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ADD COLUMN "nonce" "bytea" DEFAULT '\x00' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ADD COLUMN "auth_tag" "bytea" DEFAULT '\x00' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ADD COLUMN "algorithm" text DEFAULT 'legacy-invalidated' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ADD COLUMN "aad_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_operator_activity" ADD COLUMN "expires_at" text;--> statement-breakpoint
UPDATE "caplets"."cp_operator_activity" SET "expires_at" = to_char(("occurred_at"::timestamptz + interval '90 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');--> statement-breakpoint
ALTER TABLE "caplets"."cp_operator_activity" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD COLUMN "purpose" text DEFAULT 'pending-approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD COLUMN "algorithm" text DEFAULT 'legacy-invalidated' NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD COLUMN "verifier_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD COLUMN "key_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD COLUMN "requested_role" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD COLUMN "granted_role" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD COLUMN "host_url" text;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD COLUMN "client_label" text;--> statement-breakpoint
UPDATE "caplets"."cp_client" SET "client_label" = "client_id";--> statement-breakpoint
UPDATE "caplets"."cp_dashboard_session" SET "csrf_verifier" = "verifier", "absolute_expires_at" = "expires_at", "idle_expires_at" = COALESCE("last_seen_at", "created_at");--> statement-breakpoint
UPDATE "caplets"."cp_dashboard_session" SET "revoked_at" = COALESCE("revoked_at", "updated_at");--> statement-breakpoint
UPDATE "caplets"."cp_pending_approval" SET "state" = 'invalidated', "consumed_at" = COALESCE("consumed_at", "updated_at");--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ALTER COLUMN "key_purpose" DROP DEFAULT, ALTER COLUMN "key_algorithm" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "caplets"."cp_client" ALTER COLUMN "host_url" DROP DEFAULT, ALTER COLUMN "client_label" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "caplets"."cp_credential" ALTER COLUMN "algorithm" DROP DEFAULT, ALTER COLUMN "verifier_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ALTER COLUMN "algorithm" DROP DEFAULT, ALTER COLUMN "verifier_version" DROP DEFAULT, ALTER COLUMN "key_version" DROP DEFAULT, ALTER COLUMN "csrf_verifier" DROP DEFAULT, ALTER COLUMN "csrf_algorithm" DROP DEFAULT, ALTER COLUMN "csrf_key_version" DROP DEFAULT, ALTER COLUMN "absolute_expires_at" DROP DEFAULT, ALTER COLUMN "idle_expires_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ALTER COLUMN "nonce" DROP DEFAULT, ALTER COLUMN "auth_tag" DROP DEFAULT, ALTER COLUMN "algorithm" DROP DEFAULT, ALTER COLUMN "aad_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "caplets"."cp_operator_activity" ALTER COLUMN "expires_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ALTER COLUMN "purpose" DROP DEFAULT, ALTER COLUMN "algorithm" DROP DEFAULT, ALTER COLUMN "verifier_version" DROP DEFAULT, ALTER COLUMN "key_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_canary" ADD CONSTRAINT "cp_key_canary_root_fk" FOREIGN KEY ("logical_host_id","store_id") REFERENCES "caplets"."__caplets_storage_identity_v1"("logical_host_id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_canary" ADD CONSTRAINT "cp_key_canary_relation_1_fk" FOREIGN KEY ("logical_host_id","purpose","key_version") REFERENCES "caplets"."cp_key_inventory"("logical_host_id","purpose","key_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_inventory" ADD CONSTRAINT "cp_key_inventory_root_fk" FOREIGN KEY ("logical_host_id","store_id") REFERENCES "caplets"."__caplets_storage_identity_v1"("logical_host_id","store_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cp_key_canary_semantic_uq" ON "caplets"."cp_key_canary" USING btree ("logical_host_id","purpose","key_version");--> statement-breakpoint
CREATE INDEX "cp_key_canary_query_1_idx" ON "caplets"."cp_key_canary" USING btree ("logical_host_id","purpose","key_version","state");--> statement-breakpoint
CREATE UNIQUE INDEX "cp_key_inventory_semantic_uq" ON "caplets"."cp_key_inventory" USING btree ("logical_host_id","purpose","key_version");--> statement-breakpoint
CREATE INDEX "cp_key_inventory_query_1_idx" ON "caplets"."cp_key_inventory" USING btree ("logical_host_id","purpose","state");--> statement-breakpoint
CREATE INDEX "cp_key_inventory_query_2_idx" ON "caplets"."cp_key_inventory" USING btree ("logical_host_id","purge_watermark");--> statement-breakpoint
CREATE INDEX "cp_operator_activity_query_3_idx" ON "caplets"."cp_operator_activity" USING btree ("logical_host_id","action");--> statement-breakpoint
CREATE INDEX "cp_operator_activity_query_2_idx" ON "caplets"."cp_operator_activity" USING btree ("logical_host_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cp_vault_grant_semantic_uq" ON "caplets"."cp_vault_grant" USING btree ("logical_host_id","reference_name","caplet_id","origin");--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ADD CONSTRAINT "cp_backup_key_purpose_nonempty_check" CHECK (length("caplets"."cp_backup"."key_purpose") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ADD CONSTRAINT "cp_backup_key_algorithm_nonempty_check" CHECK (length("caplets"."cp_backup"."key_algorithm") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ADD CONSTRAINT "cp_backup_destroyed_at_nonempty_check" CHECK (length("caplets"."cp_backup"."destroyed_at") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" ADD CONSTRAINT "cp_backup_destruction_id_nonempty_check" CHECK (length("caplets"."cp_backup"."destruction_id") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_client" ADD CONSTRAINT "cp_client_host_url_nonempty_check" CHECK (length("caplets"."cp_client"."host_url") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_client" ADD CONSTRAINT "cp_client_client_label_nonempty_check" CHECK (length("caplets"."cp_client"."client_label") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_credential" ADD CONSTRAINT "cp_credential_algorithm_nonempty_check" CHECK (length("caplets"."cp_credential"."algorithm") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_credential" ADD CONSTRAINT "cp_credential_verifier_version_version_check" CHECK ("caplets"."cp_credential"."verifier_version" >= 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD CONSTRAINT "cp_dashboard_session_algorithm_nonempty_check" CHECK (length("caplets"."cp_dashboard_session"."algorithm") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD CONSTRAINT "cp_dashboard_session_verifier_version_version_check" CHECK ("caplets"."cp_dashboard_session"."verifier_version" >= 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD CONSTRAINT "cp_dashboard_session_key_version_version_check" CHECK ("caplets"."cp_dashboard_session"."key_version" >= 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD CONSTRAINT "cp_dashboard_session_csrf_verifier_bytes_check" CHECK (octet_length("caplets"."cp_dashboard_session"."csrf_verifier") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD CONSTRAINT "cp_dashboard_session_csrf_algorithm_nonempty_check" CHECK (length("caplets"."cp_dashboard_session"."csrf_algorithm") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD CONSTRAINT "cp_dashboard_session_csrf_key_version_version_check" CHECK ("caplets"."cp_dashboard_session"."csrf_key_version" >= 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD CONSTRAINT "cp_dashboard_session_absolute_expires_at_nonempty_check" CHECK (length("caplets"."cp_dashboard_session"."absolute_expires_at") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_dashboard_session" ADD CONSTRAINT "cp_dashboard_session_idle_expires_at_nonempty_check" CHECK (length("caplets"."cp_dashboard_session"."idle_expires_at") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ADD CONSTRAINT "cp_oauth_token_nonce_bytes_check" CHECK (octet_length("caplets"."cp_oauth_token"."nonce") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ADD CONSTRAINT "cp_oauth_token_auth_tag_bytes_check" CHECK (octet_length("caplets"."cp_oauth_token"."auth_tag") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ADD CONSTRAINT "cp_oauth_token_algorithm_nonempty_check" CHECK (length("caplets"."cp_oauth_token"."algorithm") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_oauth_token" ADD CONSTRAINT "cp_oauth_token_aad_version_version_check" CHECK ("caplets"."cp_oauth_token"."aad_version" >= 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_operator_activity" ADD CONSTRAINT "cp_operator_activity_expires_at_nonempty_check" CHECK (length("caplets"."cp_operator_activity"."expires_at") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD CONSTRAINT "cp_pending_approval_purpose_nonempty_check" CHECK (length("caplets"."cp_pending_approval"."purpose") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD CONSTRAINT "cp_pending_approval_algorithm_nonempty_check" CHECK (length("caplets"."cp_pending_approval"."algorithm") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD CONSTRAINT "cp_pending_approval_verifier_version_version_check" CHECK ("caplets"."cp_pending_approval"."verifier_version" >= 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD CONSTRAINT "cp_pending_approval_key_version_version_check" CHECK ("caplets"."cp_pending_approval"."key_version" >= 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD CONSTRAINT "cp_pending_approval_requested_role_nonempty_check" CHECK (length("caplets"."cp_pending_approval"."requested_role") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD CONSTRAINT "cp_pending_approval_granted_role_nonempty_check" CHECK (length("caplets"."cp_pending_approval"."granted_role") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD CONSTRAINT "cp_pending_approval_host_url_nonempty_check" CHECK (length("caplets"."cp_pending_approval"."host_url") > 0);--> statement-breakpoint
ALTER TABLE "caplets"."cp_pending_approval" ADD CONSTRAINT "cp_pending_approval_client_label_nonempty_check" CHECK (length("caplets"."cp_pending_approval"."client_label") > 0);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "caplets"."reject_operator_activity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, caplets
AS $$
BEGIN
	IF TG_OP = 'DELETE' AND current_user <> session_user THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'operator activity is append-only';
END;
$$;--> statement-breakpoint
CREATE FUNCTION "caplets"."cp_purge_expired_operator_activity"(
  p_logical_host_id text,
  p_store_id text,
  p_receipt_id text,
  p_watermark bigint,
  p_limit integer
) RETURNS TABLE(deleted_count bigint, occurred_at text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, caplets
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_now_text text;
  v_current_watermark bigint;
BEGIN
  IF p_watermark < 0 OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid bounded activity purge request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_logical_host_id || chr(31) || p_store_id || chr(31) || 'operator-activity-purge', 0)
  );
  SELECT COALESCE(MAX(retention.purge_watermark), 0)
    INTO v_current_watermark
    FROM caplets.cp_retention AS retention
    WHERE retention.logical_host_id = p_logical_host_id
      AND retention.store_id = p_store_id
      AND retention.resource_kind = 'operator-activity';
  IF p_watermark < v_current_watermark THEN
    RAISE EXCEPTION 'activity purge watermark cannot regress' USING ERRCODE = '22023';
  END IF;
  WITH victims AS (
    SELECT activity.ctid
      FROM caplets.cp_operator_activity AS activity
      WHERE activity.logical_host_id = p_logical_host_id
        AND activity.store_id = p_store_id
        AND activity.expires_at::timestamptz <= v_now
      ORDER BY activity.expires_at, activity.activity_id
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
  ), removed AS (
    DELETE FROM caplets.cp_operator_activity AS activity
      USING victims
      WHERE activity.ctid = victims.ctid
      RETURNING 1
  )
  SELECT COUNT(*)::bigint INTO deleted_count FROM removed;
  v_now_text := to_char(v_now AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  INSERT INTO caplets.cp_retention (
    model_version, id, logical_host_id, store_id, created_at, updated_at,
    aggregate_version, authority_version, effective_version, security_version,
    retention_id, resource_kind, resource_id, policy, purge_watermark,
    retain_until, destroyed_at
  ) VALUES (
    1, 'retention:' || p_receipt_id, p_logical_host_id, p_store_id, v_now_text, v_now_text,
    0, 0, 0, 0,
    p_receipt_id, 'operator-activity', 'expired-batch', 'bounded-expired-only',
    p_watermark, v_now_text, v_now_text
  );
  occurred_at := v_now_text;
  RETURN NEXT;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "caplets"."cp_purge_expired_operator_activity"(text, text, text, bigint, integer) FROM PUBLIC;