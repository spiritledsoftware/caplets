CREATE TEMP TABLE `__caplets_u8_rollback_guard` (`state_absent` INTEGER NOT NULL);--> statement-breakpoint
INSERT INTO `__caplets_u8_rollback_guard` (`state_absent`)
SELECT NULL
WHERE EXISTS (
  SELECT 1 FROM `cp_host_setting` WHERE `key` <> 'native.daemon-url'
);--> statement-breakpoint
DROP TABLE `__caplets_u8_rollback_guard`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cp_host_setting` (
	`model_version` integer NOT NULL,
	`id` text NOT NULL,
	`logical_host_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`aggregate_version` integer NOT NULL,
	`authority_version` integer NOT NULL,
	`effective_version` integer NOT NULL,
	`security_version` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`ownership` text NOT NULL,
	`activation` text NOT NULL,
	`effective` integer NOT NULL,
	`provenance_id` text NOT NULL,
	`provenance_source_kind` text NOT NULL,
	`provenance_source` text NOT NULL,
	`provenance_content_hash` text NOT NULL,
	`provenance_runtime_fingerprint` text,
	`provenance_installed_at` text,
	`provenance_resolved_revision` text,
	`provenance_risk_summary` text,
	`provenance_owner_id` text,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_host_setting_model_version_version_check" CHECK("__new_cp_host_setting"."model_version" >= 0),
	CONSTRAINT "cp_host_setting_id_nonempty_check" CHECK(length("__new_cp_host_setting"."id") > 0),
	CONSTRAINT "cp_host_setting_logical_host_id_nonempty_check" CHECK(length("__new_cp_host_setting"."logical_host_id") > 0),
	CONSTRAINT "cp_host_setting_store_id_nonempty_check" CHECK(length("__new_cp_host_setting"."store_id") > 0),
	CONSTRAINT "cp_host_setting_created_at_nonempty_check" CHECK(length("__new_cp_host_setting"."created_at") > 0),
	CONSTRAINT "cp_host_setting_updated_at_nonempty_check" CHECK(length("__new_cp_host_setting"."updated_at") > 0),
	CONSTRAINT "cp_host_setting_aggregate_version_version_check" CHECK("__new_cp_host_setting"."aggregate_version" >= 0),
	CONSTRAINT "cp_host_setting_authority_version_version_check" CHECK("__new_cp_host_setting"."authority_version" >= 0),
	CONSTRAINT "cp_host_setting_effective_version_version_check" CHECK("__new_cp_host_setting"."effective_version" >= 0),
	CONSTRAINT "cp_host_setting_security_version_version_check" CHECK("__new_cp_host_setting"."security_version" >= 0),
	CONSTRAINT "cp_host_setting_key_nonempty_check" CHECK(length("__new_cp_host_setting"."key") > 0),
	CONSTRAINT "cp_host_setting_value_json_check" CHECK(json_valid("__new_cp_host_setting"."value")),
	CONSTRAINT "cp_host_setting_ownership_nonempty_check" CHECK(length("__new_cp_host_setting"."ownership") > 0),
	CONSTRAINT "cp_host_setting_activation_nonempty_check" CHECK(length("__new_cp_host_setting"."activation") > 0),
	CONSTRAINT "cp_host_setting_effective_boolean_check" CHECK("__new_cp_host_setting"."effective" IN (0, 1)),
	CONSTRAINT "cp_host_setting_provenance_id_nonempty_check" CHECK(length("__new_cp_host_setting"."provenance_id") > 0),
	CONSTRAINT "cp_host_setting_provenance_source_kind_nonempty_check" CHECK(length("__new_cp_host_setting"."provenance_source_kind") > 0),
	CONSTRAINT "cp_host_setting_provenance_source_json_check" CHECK(json_valid("__new_cp_host_setting"."provenance_source")),
	CONSTRAINT "cp_host_setting_provenance_content_hash_hash_check" CHECK(length("__new_cp_host_setting"."provenance_content_hash") = 64 AND NOT "__new_cp_host_setting"."provenance_content_hash" GLOB '*[^0-9a-f]*'),
	CONSTRAINT "cp_host_setting_provenance_runtime_fingerprint_hash_check" CHECK(length("__new_cp_host_setting"."provenance_runtime_fingerprint") = 64 AND NOT "__new_cp_host_setting"."provenance_runtime_fingerprint" GLOB '*[^0-9a-f]*'),
	CONSTRAINT "cp_host_setting_provenance_installed_at_nonempty_check" CHECK(length("__new_cp_host_setting"."provenance_installed_at") > 0),
	CONSTRAINT "cp_host_setting_provenance_resolved_revision_nonempty_check" CHECK(length("__new_cp_host_setting"."provenance_resolved_revision") > 0),
	CONSTRAINT "cp_host_setting_provenance_risk_summary_json_check" CHECK(json_valid("__new_cp_host_setting"."provenance_risk_summary")),
	CONSTRAINT "cp_host_setting_provenance_owner_id_nonempty_check" CHECK(length("__new_cp_host_setting"."provenance_owner_id") > 0),
	CONSTRAINT "cp_host_setting_model_version_check" CHECK("__new_cp_host_setting"."model_version" = 1),
	CONSTRAINT "cp_host_setting_typed_value_check" CHECK("__new_cp_host_setting"."key" = 'native.daemon-url' AND json_extract("__new_cp_host_setting"."value", '$.source') = 'setup' AND json_type("__new_cp_host_setting"."value", '$.url') = 'text')
);
--> statement-breakpoint
INSERT INTO `__new_cp_host_setting`("model_version", "id", "logical_host_id", "store_id", "created_at", "updated_at", "aggregate_version", "authority_version", "effective_version", "security_version", "key", "value", "ownership", "activation", "effective", "provenance_id", "provenance_source_kind", "provenance_source", "provenance_content_hash", "provenance_runtime_fingerprint", "provenance_installed_at", "provenance_resolved_revision", "provenance_risk_summary", "provenance_owner_id") SELECT "model_version", "id", "logical_host_id", "store_id", "created_at", "updated_at", "aggregate_version", "authority_version", "effective_version", "security_version", "key", "value", "ownership", "activation", "effective", "provenance_id", "provenance_source_kind", "provenance_source", "provenance_content_hash", "provenance_runtime_fingerprint", "provenance_installed_at", "provenance_resolved_revision", "provenance_risk_summary", "provenance_owner_id" FROM `cp_host_setting`;--> statement-breakpoint
DROP TABLE `cp_host_setting`;--> statement-breakpoint
ALTER TABLE `__new_cp_host_setting` RENAME TO `cp_host_setting`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_host_setting_semantic_uq` ON `cp_host_setting` (`logical_host_id`,`key`);--> statement-breakpoint
CREATE INDEX `cp_host_setting_query_1_idx` ON `cp_host_setting` (`logical_host_id`,`effective`);