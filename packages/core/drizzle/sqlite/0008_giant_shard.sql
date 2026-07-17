PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cp_vault_grant` (
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
	`reference_name` text NOT NULL,
	`caplet_id` text NOT NULL,
	`origin` text NOT NULL,
	`stored_key` text NOT NULL,
	`scope` text,
	`owner_id` text,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_vault_grant_model_version_version_check" CHECK("__new_cp_vault_grant"."model_version" >= 0),
	CONSTRAINT "cp_vault_grant_id_nonempty_check" CHECK(length("__new_cp_vault_grant"."id") > 0),
	CONSTRAINT "cp_vault_grant_logical_host_id_nonempty_check" CHECK(length("__new_cp_vault_grant"."logical_host_id") > 0),
	CONSTRAINT "cp_vault_grant_store_id_nonempty_check" CHECK(length("__new_cp_vault_grant"."store_id") > 0),
	CONSTRAINT "cp_vault_grant_created_at_nonempty_check" CHECK(length("__new_cp_vault_grant"."created_at") > 0),
	CONSTRAINT "cp_vault_grant_updated_at_nonempty_check" CHECK(length("__new_cp_vault_grant"."updated_at") > 0),
	CONSTRAINT "cp_vault_grant_aggregate_version_version_check" CHECK("__new_cp_vault_grant"."aggregate_version" >= 0),
	CONSTRAINT "cp_vault_grant_authority_version_version_check" CHECK("__new_cp_vault_grant"."authority_version" >= 0),
	CONSTRAINT "cp_vault_grant_effective_version_version_check" CHECK("__new_cp_vault_grant"."effective_version" >= 0),
	CONSTRAINT "cp_vault_grant_security_version_version_check" CHECK("__new_cp_vault_grant"."security_version" >= 0),
	CONSTRAINT "cp_vault_grant_reference_name_nonempty_check" CHECK(length("__new_cp_vault_grant"."reference_name") > 0),
	CONSTRAINT "cp_vault_grant_caplet_id_nonempty_check" CHECK(length("__new_cp_vault_grant"."caplet_id") > 0),
	CONSTRAINT "cp_vault_grant_origin_json_check" CHECK(json_valid("__new_cp_vault_grant"."origin")),
	CONSTRAINT "cp_vault_grant_stored_key_nonempty_check" CHECK(length("__new_cp_vault_grant"."stored_key") > 0),
	CONSTRAINT "cp_vault_grant_scope_nonempty_check" CHECK(length("__new_cp_vault_grant"."scope") > 0),
	CONSTRAINT "cp_vault_grant_owner_id_nonempty_check" CHECK(length("__new_cp_vault_grant"."owner_id") > 0),
	CONSTRAINT "cp_vault_grant_model_version_check" CHECK("__new_cp_vault_grant"."model_version" = 1)
);
--> statement-breakpoint
INSERT INTO `__new_cp_vault_grant`("model_version", "id", "logical_host_id", "store_id", "created_at", "updated_at", "aggregate_version", "authority_version", "effective_version", "security_version", "reference_name", "caplet_id", "origin", "stored_key", "scope", "owner_id") SELECT "model_version", "id", "logical_host_id", "store_id", "created_at", "updated_at", "aggregate_version", "authority_version", "effective_version", "security_version", "reference_name", "caplet_id", "origin", "stored_key", "scope", "owner_id" FROM `cp_vault_grant`;--> statement-breakpoint
DROP TABLE `cp_vault_grant`;--> statement-breakpoint
ALTER TABLE `__new_cp_vault_grant` RENAME TO `cp_vault_grant`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_vault_grant_semantic_uq` ON `cp_vault_grant` (`logical_host_id`,`reference_name`,`caplet_id`,`origin`);--> statement-breakpoint
CREATE INDEX `cp_operation_outcome_query_1_idx` ON `cp_operation_outcome` (`logical_host_id`,`store_id`,`convergence_class`,`operation_id`);