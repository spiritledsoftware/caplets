ALTER TABLE "caplets"."cp_key_canary" DROP CONSTRAINT "cp_key_canary_state_check";--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_inventory" DROP CONSTRAINT "cp_key_inventory_state_check";--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_canary" ADD CONSTRAINT "cp_key_canary_state_check" CHECK ("caplets"."cp_key_canary"."state" IN ('staged', 'active'));--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_inventory" ADD CONSTRAINT "cp_key_inventory_state_check" CHECK ("caplets"."cp_key_inventory"."state" IN ('staged', 'active', 'decrypt-only', 'retired', 'destruction-intended', 'destroyed'));
--> statement-breakpoint
CREATE TABLE "caplets"."cp_snapshot_envelope" (
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
	"envelope_id" text NOT NULL,
	"caplet_count" bigint NOT NULL,
	"normalized_row_count" bigint NOT NULL,
	"encoded_byte_count" bigint NOT NULL,
	CONSTRAINT "cp_snapshot_envelope_pk" PRIMARY KEY("logical_host_id","id"),
	CONSTRAINT "cp_snapshot_envelope_model_version_version_check" CHECK ("caplets"."cp_snapshot_envelope"."model_version" >= 0),
	CONSTRAINT "cp_snapshot_envelope_id_nonempty_check" CHECK (length("caplets"."cp_snapshot_envelope"."id") > 0),
	CONSTRAINT "cp_snapshot_envelope_logical_host_id_nonempty_check" CHECK (length("caplets"."cp_snapshot_envelope"."logical_host_id") > 0),
	CONSTRAINT "cp_snapshot_envelope_store_id_nonempty_check" CHECK (length("caplets"."cp_snapshot_envelope"."store_id") > 0),
	CONSTRAINT "cp_snapshot_envelope_created_at_nonempty_check" CHECK (length("caplets"."cp_snapshot_envelope"."created_at") > 0),
	CONSTRAINT "cp_snapshot_envelope_updated_at_nonempty_check" CHECK (length("caplets"."cp_snapshot_envelope"."updated_at") > 0),
	CONSTRAINT "cp_snapshot_envelope_aggregate_version_version_check" CHECK ("caplets"."cp_snapshot_envelope"."aggregate_version" >= 0),
	CONSTRAINT "cp_snapshot_envelope_authority_version_version_check" CHECK ("caplets"."cp_snapshot_envelope"."authority_version" >= 0),
	CONSTRAINT "cp_snapshot_envelope_effective_version_version_check" CHECK ("caplets"."cp_snapshot_envelope"."effective_version" >= 0),
	CONSTRAINT "cp_snapshot_envelope_security_version_version_check" CHECK ("caplets"."cp_snapshot_envelope"."security_version" >= 0),
	CONSTRAINT "cp_snapshot_envelope_envelope_id_nonempty_check" CHECK (length("caplets"."cp_snapshot_envelope"."envelope_id") > 0),
	CONSTRAINT "cp_snapshot_envelope_caplet_count_version_check" CHECK ("caplets"."cp_snapshot_envelope"."caplet_count" >= 0),
	CONSTRAINT "cp_snapshot_envelope_normalized_row_count_version_check" CHECK ("caplets"."cp_snapshot_envelope"."normalized_row_count" >= 0),
	CONSTRAINT "cp_snapshot_envelope_encoded_byte_count_version_check" CHECK ("caplets"."cp_snapshot_envelope"."encoded_byte_count" >= 0),
	CONSTRAINT "cp_snapshot_envelope_model_version_check" CHECK ("caplets"."cp_snapshot_envelope"."model_version" = 1)
);
--> statement-breakpoint
ALTER TABLE "caplets"."cp_snapshot_envelope" ADD CONSTRAINT "cp_snapshot_envelope_root_fk" FOREIGN KEY ("logical_host_id","store_id") REFERENCES "caplets"."__caplets_storage_identity_v1"("logical_host_id","store_id") ON DELETE restrict ON UPDATE no action;