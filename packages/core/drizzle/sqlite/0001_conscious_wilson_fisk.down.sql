PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__rollback_cp_caplet` (
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
	`name` text NOT NULL,
	`description` text NOT NULL,
	`ownership` text NOT NULL,
	`activation` text NOT NULL,
	`effective` integer NOT NULL,
	`update_state` text NOT NULL,
	`portable_aggregate_id` text NOT NULL,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_caplet_model_version_version_check" CHECK("__rollback_cp_caplet"."model_version" >= 0),
	CONSTRAINT "cp_caplet_id_nonempty_check" CHECK(length("__rollback_cp_caplet"."id") > 0),
	CONSTRAINT "cp_caplet_logical_host_id_nonempty_check" CHECK(length("__rollback_cp_caplet"."logical_host_id") > 0),
	CONSTRAINT "cp_caplet_store_id_nonempty_check" CHECK(length("__rollback_cp_caplet"."store_id") > 0),
	CONSTRAINT "cp_caplet_created_at_nonempty_check" CHECK(length("__rollback_cp_caplet"."created_at") > 0),
	CONSTRAINT "cp_caplet_updated_at_nonempty_check" CHECK(length("__rollback_cp_caplet"."updated_at") > 0),
	CONSTRAINT "cp_caplet_aggregate_version_version_check" CHECK("__rollback_cp_caplet"."aggregate_version" >= 0),
	CONSTRAINT "cp_caplet_authority_version_version_check" CHECK("__rollback_cp_caplet"."authority_version" >= 0),
	CONSTRAINT "cp_caplet_effective_version_version_check" CHECK("__rollback_cp_caplet"."effective_version" >= 0),
	CONSTRAINT "cp_caplet_security_version_version_check" CHECK("__rollback_cp_caplet"."security_version" >= 0),
	CONSTRAINT "cp_caplet_name_nonempty_check" CHECK(length("__rollback_cp_caplet"."name") > 0),
	CONSTRAINT "cp_caplet_description_nonempty_check" CHECK(length("__rollback_cp_caplet"."description") > 0),
	CONSTRAINT "cp_caplet_ownership_nonempty_check" CHECK(length("__rollback_cp_caplet"."ownership") > 0),
	CONSTRAINT "cp_caplet_activation_nonempty_check" CHECK(length("__rollback_cp_caplet"."activation") > 0),
	CONSTRAINT "cp_caplet_effective_boolean_check" CHECK("__rollback_cp_caplet"."effective" IN (0, 1)),
	CONSTRAINT "cp_caplet_update_state_nonempty_check" CHECK(length("__rollback_cp_caplet"."update_state") > 0),
	CONSTRAINT "cp_caplet_portable_aggregate_id_nonempty_check" CHECK(length("__rollback_cp_caplet"."portable_aggregate_id") > 0),
	CONSTRAINT "cp_caplet_model_version_check" CHECK("__rollback_cp_caplet"."model_version" = 1)
);
--> statement-breakpoint
INSERT INTO `__rollback_cp_caplet`("model_version", "id", "logical_host_id", "store_id", "created_at", "updated_at", "aggregate_version", "authority_version", "effective_version", "security_version", "name", "description", "ownership", "activation", "effective", "update_state", "portable_aggregate_id") SELECT "model_version", "id", "logical_host_id", "store_id", "created_at", "updated_at", "aggregate_version", "authority_version", "effective_version", "security_version", "name", "description", "ownership", "activation", "effective", "update_state", "portable_aggregate_id" FROM `cp_caplet`;
--> statement-breakpoint
DROP TABLE `cp_caplet`;
--> statement-breakpoint
ALTER TABLE `__rollback_cp_caplet` RENAME TO `cp_caplet`;
--> statement-breakpoint
CREATE UNIQUE INDEX `cp_caplet_semantic_uq` ON `cp_caplet` (`logical_host_id`,`portable_aggregate_id`);--> statement-breakpoint
CREATE INDEX `cp_caplet_query_1_idx` ON `cp_caplet` (`logical_host_id`,`name`);--> statement-breakpoint
CREATE INDEX `cp_caplet_query_2_idx` ON `cp_caplet` (`logical_host_id`,`effective`);--> statement-breakpoint
CREATE TABLE `__rollback_cp_host_setting` (
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
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_host_setting_model_version_version_check" CHECK("__rollback_cp_host_setting"."model_version" >= 0),
	CONSTRAINT "cp_host_setting_id_nonempty_check" CHECK(length("__rollback_cp_host_setting"."id") > 0),
	CONSTRAINT "cp_host_setting_logical_host_id_nonempty_check" CHECK(length("__rollback_cp_host_setting"."logical_host_id") > 0),
	CONSTRAINT "cp_host_setting_store_id_nonempty_check" CHECK(length("__rollback_cp_host_setting"."store_id") > 0),
	CONSTRAINT "cp_host_setting_created_at_nonempty_check" CHECK(length("__rollback_cp_host_setting"."created_at") > 0),
	CONSTRAINT "cp_host_setting_updated_at_nonempty_check" CHECK(length("__rollback_cp_host_setting"."updated_at") > 0),
	CONSTRAINT "cp_host_setting_aggregate_version_version_check" CHECK("__rollback_cp_host_setting"."aggregate_version" >= 0),
	CONSTRAINT "cp_host_setting_authority_version_version_check" CHECK("__rollback_cp_host_setting"."authority_version" >= 0),
	CONSTRAINT "cp_host_setting_effective_version_version_check" CHECK("__rollback_cp_host_setting"."effective_version" >= 0),
	CONSTRAINT "cp_host_setting_security_version_version_check" CHECK("__rollback_cp_host_setting"."security_version" >= 0),
	CONSTRAINT "cp_host_setting_key_nonempty_check" CHECK(length("__rollback_cp_host_setting"."key") > 0),
	CONSTRAINT "cp_host_setting_value_json_check" CHECK(json_valid("__rollback_cp_host_setting"."value")),
	CONSTRAINT "cp_host_setting_ownership_nonempty_check" CHECK(length("__rollback_cp_host_setting"."ownership") > 0),
	CONSTRAINT "cp_host_setting_activation_nonempty_check" CHECK(length("__rollback_cp_host_setting"."activation") > 0),
	CONSTRAINT "cp_host_setting_effective_boolean_check" CHECK("__rollback_cp_host_setting"."effective" IN (0, 1)),
	CONSTRAINT "cp_host_setting_model_version_check" CHECK("__rollback_cp_host_setting"."model_version" = 1),
	CONSTRAINT "cp_host_setting_typed_value_check" CHECK("__rollback_cp_host_setting"."key" = 'native.daemon-url' AND json_extract("__rollback_cp_host_setting"."value", '$.source') = 'setup' AND json_type("__rollback_cp_host_setting"."value", '$.url') = 'text')
);
--> statement-breakpoint
INSERT INTO `__rollback_cp_host_setting`("model_version", "id", "logical_host_id", "store_id", "created_at", "updated_at", "aggregate_version", "authority_version", "effective_version", "security_version", "key", "value", "ownership", "activation", "effective") SELECT "model_version", "id", "logical_host_id", "store_id", "created_at", "updated_at", "aggregate_version", "authority_version", "effective_version", "security_version", "key", "value", "ownership", "activation", "effective" FROM `cp_host_setting`;
--> statement-breakpoint
DROP TABLE `cp_host_setting`;
--> statement-breakpoint
ALTER TABLE `__rollback_cp_host_setting` RENAME TO `cp_host_setting`;
--> statement-breakpoint
CREATE UNIQUE INDEX `cp_host_setting_semantic_uq` ON `cp_host_setting` (`logical_host_id`,`key`);--> statement-breakpoint
CREATE INDEX `cp_host_setting_query_1_idx` ON `cp_host_setting` (`logical_host_id`,`effective`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
