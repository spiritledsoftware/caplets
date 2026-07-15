PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__old_cp_operator_activity` (
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
	`activity_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`target` text NOT NULL,
	`redacted_detail` text,
	`occurred_at` text NOT NULL,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_operator_activity_model_version_version_check" CHECK("__old_cp_operator_activity"."model_version" >= 0),
	CONSTRAINT "cp_operator_activity_id_nonempty_check" CHECK(length("__old_cp_operator_activity"."id") > 0),
	CONSTRAINT "cp_operator_activity_logical_host_id_nonempty_check" CHECK(length("__old_cp_operator_activity"."logical_host_id") > 0),
	CONSTRAINT "cp_operator_activity_store_id_nonempty_check" CHECK(length("__old_cp_operator_activity"."store_id") > 0),
	CONSTRAINT "cp_operator_activity_created_at_nonempty_check" CHECK(length("__old_cp_operator_activity"."created_at") > 0),
	CONSTRAINT "cp_operator_activity_updated_at_nonempty_check" CHECK(length("__old_cp_operator_activity"."updated_at") > 0),
	CONSTRAINT "cp_operator_activity_aggregate_version_version_check" CHECK("__old_cp_operator_activity"."aggregate_version" >= 0),
	CONSTRAINT "cp_operator_activity_authority_version_version_check" CHECK("__old_cp_operator_activity"."authority_version" >= 0),
	CONSTRAINT "cp_operator_activity_effective_version_version_check" CHECK("__old_cp_operator_activity"."effective_version" >= 0),
	CONSTRAINT "cp_operator_activity_security_version_version_check" CHECK("__old_cp_operator_activity"."security_version" >= 0),
	CONSTRAINT "cp_operator_activity_activity_id_nonempty_check" CHECK(length("__old_cp_operator_activity"."activity_id") > 0),
	CONSTRAINT "cp_operator_activity_actor_id_nonempty_check" CHECK(length("__old_cp_operator_activity"."actor_id") > 0),
	CONSTRAINT "cp_operator_activity_action_nonempty_check" CHECK(length("__old_cp_operator_activity"."action") > 0),
	CONSTRAINT "cp_operator_activity_outcome_nonempty_check" CHECK(length("__old_cp_operator_activity"."outcome") > 0),
	CONSTRAINT "cp_operator_activity_target_json_check" CHECK(json_valid("__old_cp_operator_activity"."target")),
	CONSTRAINT "cp_operator_activity_redacted_detail_json_check" CHECK(json_valid("__old_cp_operator_activity"."redacted_detail")),
	CONSTRAINT "cp_operator_activity_occurred_at_nonempty_check" CHECK(length("__old_cp_operator_activity"."occurred_at") > 0),
	CONSTRAINT "cp_operator_activity_model_version_check" CHECK("__old_cp_operator_activity"."model_version" = 1)
);--> statement-breakpoint
INSERT INTO `__old_cp_operator_activity`(`model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `activity_id`, `actor_id`, `action`, `outcome`, `target`, `redacted_detail`, `occurred_at`) SELECT `model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `activity_id`, `actor_id`, `action`, `outcome`, `target`, `redacted_detail`, `occurred_at` FROM `cp_operator_activity`;--> statement-breakpoint
DROP TABLE `cp_operator_activity`;--> statement-breakpoint
ALTER TABLE `__old_cp_operator_activity` RENAME TO `cp_operator_activity`;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_operator_activity_semantic_uq` ON `cp_operator_activity` (`logical_host_id`,`activity_id`);--> statement-breakpoint
CREATE INDEX `cp_operator_activity_query_1_idx` ON `cp_operator_activity` (`logical_host_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cp_operator_activity_query_2_idx` ON `cp_operator_activity` (`logical_host_id`,`action`);--> statement-breakpoint
CREATE TABLE `__old_cp_backup` (
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
	`backup_id` text NOT NULL,
	`provider_identity` text NOT NULL,
	`source_identity` text NOT NULL,
	`source_profile` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`key_version` integer NOT NULL,
	`unwrap_identity` text NOT NULL,
	`retention_until` text NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_backup_model_version_version_check" CHECK("__old_cp_backup"."model_version" >= 0),
	CONSTRAINT "cp_backup_id_nonempty_check" CHECK(length("__old_cp_backup"."id") > 0),
	CONSTRAINT "cp_backup_logical_host_id_nonempty_check" CHECK(length("__old_cp_backup"."logical_host_id") > 0),
	CONSTRAINT "cp_backup_store_id_nonempty_check" CHECK(length("__old_cp_backup"."store_id") > 0),
	CONSTRAINT "cp_backup_created_at_nonempty_check" CHECK(length("__old_cp_backup"."created_at") > 0),
	CONSTRAINT "cp_backup_updated_at_nonempty_check" CHECK(length("__old_cp_backup"."updated_at") > 0),
	CONSTRAINT "cp_backup_aggregate_version_version_check" CHECK("__old_cp_backup"."aggregate_version" >= 0),
	CONSTRAINT "cp_backup_authority_version_version_check" CHECK("__old_cp_backup"."authority_version" >= 0),
	CONSTRAINT "cp_backup_effective_version_version_check" CHECK("__old_cp_backup"."effective_version" >= 0),
	CONSTRAINT "cp_backup_security_version_version_check" CHECK("__old_cp_backup"."security_version" >= 0),
	CONSTRAINT "cp_backup_backup_id_nonempty_check" CHECK(length("__old_cp_backup"."backup_id") > 0),
	CONSTRAINT "cp_backup_provider_identity_nonempty_check" CHECK(length("__old_cp_backup"."provider_identity") > 0),
	CONSTRAINT "cp_backup_source_identity_nonempty_check" CHECK(length("__old_cp_backup"."source_identity") > 0),
	CONSTRAINT "cp_backup_source_profile_nonempty_check" CHECK(length("__old_cp_backup"."source_profile") > 0),
	CONSTRAINT "cp_backup_manifest_hash_hash_check" CHECK(length("__old_cp_backup"."manifest_hash") = 64 AND NOT "__old_cp_backup"."manifest_hash" GLOB '*[^0-9a-f]*'),
	CONSTRAINT "cp_backup_key_version_version_check" CHECK("__old_cp_backup"."key_version" >= 0),
	CONSTRAINT "cp_backup_unwrap_identity_nonempty_check" CHECK(length("__old_cp_backup"."unwrap_identity") > 0),
	CONSTRAINT "cp_backup_retention_until_nonempty_check" CHECK(length("__old_cp_backup"."retention_until") > 0),
	CONSTRAINT "cp_backup_state_nonempty_check" CHECK(length("__old_cp_backup"."state") > 0),
	CONSTRAINT "cp_backup_model_version_check" CHECK("__old_cp_backup"."model_version" = 1)
);--> statement-breakpoint
INSERT INTO `__old_cp_backup`(`model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `backup_id`, `provider_identity`, `source_identity`, `source_profile`, `manifest_hash`, `key_version`, `unwrap_identity`, `retention_until`, `state`) SELECT `model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `backup_id`, `provider_identity`, `source_identity`, `source_profile`, `manifest_hash`, `key_version`, `unwrap_identity`, `retention_until`, `state` FROM `cp_backup`;--> statement-breakpoint
DROP TABLE `cp_backup`;--> statement-breakpoint
ALTER TABLE `__old_cp_backup` RENAME TO `cp_backup`;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_backup_semantic_uq` ON `cp_backup` (`logical_host_id`,`backup_id`);--> statement-breakpoint
CREATE INDEX `cp_backup_query_1_idx` ON `cp_backup` (`logical_host_id`,`retention_until`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `cp_backup_relation_target_uq` ON `cp_backup` (`logical_host_id`,`backup_id`);--> statement-breakpoint
CREATE TABLE `__old_cp_client` (
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
	`client_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`owner_id` text,
	`last_authenticated_at` text,
	`revoked_at` text,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_client_model_version_version_check" CHECK("__old_cp_client"."model_version" >= 0),
	CONSTRAINT "cp_client_id_nonempty_check" CHECK(length("__old_cp_client"."id") > 0),
	CONSTRAINT "cp_client_logical_host_id_nonempty_check" CHECK(length("__old_cp_client"."logical_host_id") > 0),
	CONSTRAINT "cp_client_store_id_nonempty_check" CHECK(length("__old_cp_client"."store_id") > 0),
	CONSTRAINT "cp_client_created_at_nonempty_check" CHECK(length("__old_cp_client"."created_at") > 0),
	CONSTRAINT "cp_client_updated_at_nonempty_check" CHECK(length("__old_cp_client"."updated_at") > 0),
	CONSTRAINT "cp_client_aggregate_version_version_check" CHECK("__old_cp_client"."aggregate_version" >= 0),
	CONSTRAINT "cp_client_authority_version_version_check" CHECK("__old_cp_client"."authority_version" >= 0),
	CONSTRAINT "cp_client_effective_version_version_check" CHECK("__old_cp_client"."effective_version" >= 0),
	CONSTRAINT "cp_client_security_version_version_check" CHECK("__old_cp_client"."security_version" >= 0),
	CONSTRAINT "cp_client_client_id_nonempty_check" CHECK(length("__old_cp_client"."client_id") > 0),
	CONSTRAINT "cp_client_role_nonempty_check" CHECK(length("__old_cp_client"."role") > 0),
	CONSTRAINT "cp_client_status_nonempty_check" CHECK(length("__old_cp_client"."status") > 0),
	CONSTRAINT "cp_client_owner_id_nonempty_check" CHECK(length("__old_cp_client"."owner_id") > 0),
	CONSTRAINT "cp_client_last_authenticated_at_nonempty_check" CHECK(length("__old_cp_client"."last_authenticated_at") > 0),
	CONSTRAINT "cp_client_revoked_at_nonempty_check" CHECK(length("__old_cp_client"."revoked_at") > 0),
	CONSTRAINT "cp_client_model_version_check" CHECK("__old_cp_client"."model_version" = 1)
);--> statement-breakpoint
INSERT INTO `__old_cp_client`(`model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `client_id`, `role`, `status`, `owner_id`, `last_authenticated_at`, `revoked_at`) SELECT `model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `client_id`, `role`, `status`, `owner_id`, `last_authenticated_at`, `revoked_at` FROM `cp_client`;--> statement-breakpoint
DROP TABLE `cp_client`;--> statement-breakpoint
ALTER TABLE `__old_cp_client` RENAME TO `cp_client`;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_client_semantic_uq` ON `cp_client` (`logical_host_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `cp_client_query_1_idx` ON `cp_client` (`logical_host_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `cp_client_relation_target_uq` ON `cp_client` (`logical_host_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `__old_cp_credential` (
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
	`credential_id` text NOT NULL,
	`client_id` text,
	`purpose` text NOT NULL,
	`protection` text NOT NULL,
	`verifier_or_ciphertext` blob NOT NULL,
	`access_ciphertext` blob,
	`refresh_ciphertext` blob,
	`workspace` text,
	`record_version` integer,
	`owner_id` text,
	`key_version` integer NOT NULL,
	`expires_at` text,
	`refresh_family_id` text,
	`consumed_at` text,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`logical_host_id`,`client_id`) REFERENCES `cp_client`(`logical_host_id`,`client_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_credential_model_version_version_check" CHECK("__old_cp_credential"."model_version" >= 0),
	CONSTRAINT "cp_credential_id_nonempty_check" CHECK(length("__old_cp_credential"."id") > 0),
	CONSTRAINT "cp_credential_logical_host_id_nonempty_check" CHECK(length("__old_cp_credential"."logical_host_id") > 0),
	CONSTRAINT "cp_credential_store_id_nonempty_check" CHECK(length("__old_cp_credential"."store_id") > 0),
	CONSTRAINT "cp_credential_created_at_nonempty_check" CHECK(length("__old_cp_credential"."created_at") > 0),
	CONSTRAINT "cp_credential_updated_at_nonempty_check" CHECK(length("__old_cp_credential"."updated_at") > 0),
	CONSTRAINT "cp_credential_aggregate_version_version_check" CHECK("__old_cp_credential"."aggregate_version" >= 0),
	CONSTRAINT "cp_credential_authority_version_version_check" CHECK("__old_cp_credential"."authority_version" >= 0),
	CONSTRAINT "cp_credential_effective_version_version_check" CHECK("__old_cp_credential"."effective_version" >= 0),
	CONSTRAINT "cp_credential_security_version_version_check" CHECK("__old_cp_credential"."security_version" >= 0),
	CONSTRAINT "cp_credential_credential_id_nonempty_check" CHECK(length("__old_cp_credential"."credential_id") > 0),
	CONSTRAINT "cp_credential_client_id_nonempty_check" CHECK(length("__old_cp_credential"."client_id") > 0),
	CONSTRAINT "cp_credential_purpose_nonempty_check" CHECK(length("__old_cp_credential"."purpose") > 0),
	CONSTRAINT "cp_credential_protection_nonempty_check" CHECK(length("__old_cp_credential"."protection") > 0),
	CONSTRAINT "cp_credential_verifier_or_ciphertext_bytes_check" CHECK(length("__old_cp_credential"."verifier_or_ciphertext") > 0),
	CONSTRAINT "cp_credential_access_ciphertext_bytes_check" CHECK(length("__old_cp_credential"."access_ciphertext") > 0),
	CONSTRAINT "cp_credential_refresh_ciphertext_bytes_check" CHECK(length("__old_cp_credential"."refresh_ciphertext") > 0),
	CONSTRAINT "cp_credential_workspace_nonempty_check" CHECK(length("__old_cp_credential"."workspace") > 0),
	CONSTRAINT "cp_credential_record_version_version_check" CHECK("__old_cp_credential"."record_version" >= 0),
	CONSTRAINT "cp_credential_owner_id_nonempty_check" CHECK(length("__old_cp_credential"."owner_id") > 0),
	CONSTRAINT "cp_credential_key_version_version_check" CHECK("__old_cp_credential"."key_version" >= 0),
	CONSTRAINT "cp_credential_expires_at_nonempty_check" CHECK(length("__old_cp_credential"."expires_at") > 0),
	CONSTRAINT "cp_credential_refresh_family_id_nonempty_check" CHECK(length("__old_cp_credential"."refresh_family_id") > 0),
	CONSTRAINT "cp_credential_consumed_at_nonempty_check" CHECK(length("__old_cp_credential"."consumed_at") > 0),
	CONSTRAINT "cp_credential_model_version_check" CHECK("__old_cp_credential"."model_version" = 1)
);--> statement-breakpoint
INSERT INTO `__old_cp_credential`(`model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `credential_id`, `client_id`, `purpose`, `protection`, `verifier_or_ciphertext`, `access_ciphertext`, `refresh_ciphertext`, `workspace`, `record_version`, `owner_id`, `key_version`, `expires_at`, `refresh_family_id`, `consumed_at`) SELECT `model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `credential_id`, `client_id`, `purpose`, `protection`, `verifier_or_ciphertext`, `access_ciphertext`, `refresh_ciphertext`, `workspace`, `record_version`, `owner_id`, `key_version`, `expires_at`, `refresh_family_id`, `consumed_at` FROM `cp_credential`;--> statement-breakpoint
DROP TABLE `cp_credential`;--> statement-breakpoint
ALTER TABLE `__old_cp_credential` RENAME TO `cp_credential`;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_credential_semantic_uq` ON `cp_credential` (`logical_host_id`,`credential_id`);--> statement-breakpoint
CREATE INDEX `cp_credential_query_1_idx` ON `cp_credential` (`logical_host_id`,`client_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `__old_cp_dashboard_session` (
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
	`session_id` text NOT NULL,
	`client_id` text NOT NULL,
	`verifier` blob NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text,
	`revoked_at` text,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`logical_host_id`,`client_id`) REFERENCES `cp_client`(`logical_host_id`,`client_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_dashboard_session_model_version_version_check" CHECK("__old_cp_dashboard_session"."model_version" >= 0),
	CONSTRAINT "cp_dashboard_session_id_nonempty_check" CHECK(length("__old_cp_dashboard_session"."id") > 0),
	CONSTRAINT "cp_dashboard_session_logical_host_id_nonempty_check" CHECK(length("__old_cp_dashboard_session"."logical_host_id") > 0),
	CONSTRAINT "cp_dashboard_session_store_id_nonempty_check" CHECK(length("__old_cp_dashboard_session"."store_id") > 0),
	CONSTRAINT "cp_dashboard_session_created_at_nonempty_check" CHECK(length("__old_cp_dashboard_session"."created_at") > 0),
	CONSTRAINT "cp_dashboard_session_updated_at_nonempty_check" CHECK(length("__old_cp_dashboard_session"."updated_at") > 0),
	CONSTRAINT "cp_dashboard_session_aggregate_version_version_check" CHECK("__old_cp_dashboard_session"."aggregate_version" >= 0),
	CONSTRAINT "cp_dashboard_session_authority_version_version_check" CHECK("__old_cp_dashboard_session"."authority_version" >= 0),
	CONSTRAINT "cp_dashboard_session_effective_version_version_check" CHECK("__old_cp_dashboard_session"."effective_version" >= 0),
	CONSTRAINT "cp_dashboard_session_security_version_version_check" CHECK("__old_cp_dashboard_session"."security_version" >= 0),
	CONSTRAINT "cp_dashboard_session_session_id_nonempty_check" CHECK(length("__old_cp_dashboard_session"."session_id") > 0),
	CONSTRAINT "cp_dashboard_session_client_id_nonempty_check" CHECK(length("__old_cp_dashboard_session"."client_id") > 0),
	CONSTRAINT "cp_dashboard_session_verifier_bytes_check" CHECK(length("__old_cp_dashboard_session"."verifier") > 0),
	CONSTRAINT "cp_dashboard_session_expires_at_nonempty_check" CHECK(length("__old_cp_dashboard_session"."expires_at") > 0),
	CONSTRAINT "cp_dashboard_session_last_seen_at_nonempty_check" CHECK(length("__old_cp_dashboard_session"."last_seen_at") > 0),
	CONSTRAINT "cp_dashboard_session_revoked_at_nonempty_check" CHECK(length("__old_cp_dashboard_session"."revoked_at") > 0),
	CONSTRAINT "cp_dashboard_session_model_version_check" CHECK("__old_cp_dashboard_session"."model_version" = 1)
);--> statement-breakpoint
INSERT INTO `__old_cp_dashboard_session`(`model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `session_id`, `client_id`, `verifier`, `expires_at`, `last_seen_at`, `revoked_at`) SELECT `model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `session_id`, `client_id`, `verifier`, `expires_at`, `last_seen_at`, `revoked_at` FROM `cp_dashboard_session`;--> statement-breakpoint
DROP TABLE `cp_dashboard_session`;--> statement-breakpoint
ALTER TABLE `__old_cp_dashboard_session` RENAME TO `cp_dashboard_session`;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_dashboard_session_semantic_uq` ON `cp_dashboard_session` (`logical_host_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `cp_dashboard_session_query_1_idx` ON `cp_dashboard_session` (`logical_host_id`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `__old_cp_oauth_token` (
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
	`server_name` text NOT NULL,
	`owner_id` text,
	`access_ciphertext` blob NOT NULL,
	`refresh_ciphertext` blob,
	`auth_type` text,
	`id_token_ciphertext` blob,
	`issuer` text,
	`subject` text,
	`client_id` text,
	`client_secret_ciphertext` blob,
	`protected_resource_origin` text,
	`metadata` text,
	`token_type` text,
	`scope` text,
	`expires_at` text,
	`key_version` integer NOT NULL,
	`record_version` integer NOT NULL,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_oauth_token_model_version_version_check" CHECK("__old_cp_oauth_token"."model_version" >= 0),
	CONSTRAINT "cp_oauth_token_id_nonempty_check" CHECK(length("__old_cp_oauth_token"."id") > 0),
	CONSTRAINT "cp_oauth_token_logical_host_id_nonempty_check" CHECK(length("__old_cp_oauth_token"."logical_host_id") > 0),
	CONSTRAINT "cp_oauth_token_store_id_nonempty_check" CHECK(length("__old_cp_oauth_token"."store_id") > 0),
	CONSTRAINT "cp_oauth_token_created_at_nonempty_check" CHECK(length("__old_cp_oauth_token"."created_at") > 0),
	CONSTRAINT "cp_oauth_token_updated_at_nonempty_check" CHECK(length("__old_cp_oauth_token"."updated_at") > 0),
	CONSTRAINT "cp_oauth_token_aggregate_version_version_check" CHECK("__old_cp_oauth_token"."aggregate_version" >= 0),
	CONSTRAINT "cp_oauth_token_authority_version_version_check" CHECK("__old_cp_oauth_token"."authority_version" >= 0),
	CONSTRAINT "cp_oauth_token_effective_version_version_check" CHECK("__old_cp_oauth_token"."effective_version" >= 0),
	CONSTRAINT "cp_oauth_token_security_version_version_check" CHECK("__old_cp_oauth_token"."security_version" >= 0),
	CONSTRAINT "cp_oauth_token_server_name_nonempty_check" CHECK(length("__old_cp_oauth_token"."server_name") > 0),
	CONSTRAINT "cp_oauth_token_owner_id_nonempty_check" CHECK(length("__old_cp_oauth_token"."owner_id") > 0),
	CONSTRAINT "cp_oauth_token_access_ciphertext_bytes_check" CHECK(length("__old_cp_oauth_token"."access_ciphertext") > 0),
	CONSTRAINT "cp_oauth_token_refresh_ciphertext_bytes_check" CHECK(length("__old_cp_oauth_token"."refresh_ciphertext") > 0),
	CONSTRAINT "cp_oauth_token_auth_type_nonempty_check" CHECK(length("__old_cp_oauth_token"."auth_type") > 0),
	CONSTRAINT "cp_oauth_token_id_token_ciphertext_bytes_check" CHECK(length("__old_cp_oauth_token"."id_token_ciphertext") > 0),
	CONSTRAINT "cp_oauth_token_issuer_nonempty_check" CHECK(length("__old_cp_oauth_token"."issuer") > 0),
	CONSTRAINT "cp_oauth_token_subject_nonempty_check" CHECK(length("__old_cp_oauth_token"."subject") > 0),
	CONSTRAINT "cp_oauth_token_client_id_nonempty_check" CHECK(length("__old_cp_oauth_token"."client_id") > 0),
	CONSTRAINT "cp_oauth_token_client_secret_ciphertext_bytes_check" CHECK(length("__old_cp_oauth_token"."client_secret_ciphertext") > 0),
	CONSTRAINT "cp_oauth_token_protected_resource_origin_nonempty_check" CHECK(length("__old_cp_oauth_token"."protected_resource_origin") > 0),
	CONSTRAINT "cp_oauth_token_metadata_json_check" CHECK(json_valid("__old_cp_oauth_token"."metadata")),
	CONSTRAINT "cp_oauth_token_token_type_nonempty_check" CHECK(length("__old_cp_oauth_token"."token_type") > 0),
	CONSTRAINT "cp_oauth_token_scope_json_check" CHECK(json_valid("__old_cp_oauth_token"."scope")),
	CONSTRAINT "cp_oauth_token_expires_at_nonempty_check" CHECK(length("__old_cp_oauth_token"."expires_at") > 0),
	CONSTRAINT "cp_oauth_token_key_version_version_check" CHECK("__old_cp_oauth_token"."key_version" >= 0),
	CONSTRAINT "cp_oauth_token_record_version_version_check" CHECK("__old_cp_oauth_token"."record_version" >= 0),
	CONSTRAINT "cp_oauth_token_model_version_check" CHECK("__old_cp_oauth_token"."model_version" = 1)
);--> statement-breakpoint
INSERT INTO `__old_cp_oauth_token`(`model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `server_name`, `owner_id`, `access_ciphertext`, `refresh_ciphertext`, `auth_type`, `id_token_ciphertext`, `issuer`, `subject`, `client_id`, `client_secret_ciphertext`, `protected_resource_origin`, `metadata`, `token_type`, `scope`, `expires_at`, `key_version`, `record_version`) SELECT `model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `server_name`, `owner_id`, `access_ciphertext`, `refresh_ciphertext`, `auth_type`, `id_token_ciphertext`, `issuer`, `subject`, `client_id`, `client_secret_ciphertext`, `protected_resource_origin`, `metadata`, `token_type`, `scope`, `expires_at`, `key_version`, `record_version` FROM `cp_oauth_token`;--> statement-breakpoint
DROP TABLE `cp_oauth_token`;--> statement-breakpoint
ALTER TABLE `__old_cp_oauth_token` RENAME TO `cp_oauth_token`;--> statement-breakpoint
CREATE INDEX `cp_oauth_token_query_1_idx` ON `cp_oauth_token` (`logical_host_id`,`server_name`,`owner_id`);--> statement-breakpoint
CREATE INDEX `cp_oauth_token_query_2_idx` ON `cp_oauth_token` (`logical_host_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `__old_cp_pending_approval` (
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
	`approval_id` text NOT NULL,
	`client_id` text,
	`verifier` blob NOT NULL,
	`actor_id` text,
	`state` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	PRIMARY KEY(`logical_host_id`, `id`),
	FOREIGN KEY (`logical_host_id`,`store_id`) REFERENCES `__caplets_storage_identity_v1`(`logical_host_id`,`store_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`logical_host_id`,`client_id`) REFERENCES `cp_client`(`logical_host_id`,`client_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cp_pending_approval_model_version_version_check" CHECK("__old_cp_pending_approval"."model_version" >= 0),
	CONSTRAINT "cp_pending_approval_id_nonempty_check" CHECK(length("__old_cp_pending_approval"."id") > 0),
	CONSTRAINT "cp_pending_approval_logical_host_id_nonempty_check" CHECK(length("__old_cp_pending_approval"."logical_host_id") > 0),
	CONSTRAINT "cp_pending_approval_store_id_nonempty_check" CHECK(length("__old_cp_pending_approval"."store_id") > 0),
	CONSTRAINT "cp_pending_approval_created_at_nonempty_check" CHECK(length("__old_cp_pending_approval"."created_at") > 0),
	CONSTRAINT "cp_pending_approval_updated_at_nonempty_check" CHECK(length("__old_cp_pending_approval"."updated_at") > 0),
	CONSTRAINT "cp_pending_approval_aggregate_version_version_check" CHECK("__old_cp_pending_approval"."aggregate_version" >= 0),
	CONSTRAINT "cp_pending_approval_authority_version_version_check" CHECK("__old_cp_pending_approval"."authority_version" >= 0),
	CONSTRAINT "cp_pending_approval_effective_version_version_check" CHECK("__old_cp_pending_approval"."effective_version" >= 0),
	CONSTRAINT "cp_pending_approval_security_version_version_check" CHECK("__old_cp_pending_approval"."security_version" >= 0),
	CONSTRAINT "cp_pending_approval_approval_id_nonempty_check" CHECK(length("__old_cp_pending_approval"."approval_id") > 0),
	CONSTRAINT "cp_pending_approval_client_id_nonempty_check" CHECK(length("__old_cp_pending_approval"."client_id") > 0),
	CONSTRAINT "cp_pending_approval_verifier_bytes_check" CHECK(length("__old_cp_pending_approval"."verifier") > 0),
	CONSTRAINT "cp_pending_approval_actor_id_nonempty_check" CHECK(length("__old_cp_pending_approval"."actor_id") > 0),
	CONSTRAINT "cp_pending_approval_state_nonempty_check" CHECK(length("__old_cp_pending_approval"."state") > 0),
	CONSTRAINT "cp_pending_approval_expires_at_nonempty_check" CHECK(length("__old_cp_pending_approval"."expires_at") > 0),
	CONSTRAINT "cp_pending_approval_consumed_at_nonempty_check" CHECK(length("__old_cp_pending_approval"."consumed_at") > 0),
	CONSTRAINT "cp_pending_approval_model_version_check" CHECK("__old_cp_pending_approval"."model_version" = 1)
);--> statement-breakpoint
INSERT INTO `__old_cp_pending_approval`(`model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `approval_id`, `client_id`, `verifier`, `actor_id`, `state`, `expires_at`, `consumed_at`) SELECT `model_version`, `id`, `logical_host_id`, `store_id`, `created_at`, `updated_at`, `aggregate_version`, `authority_version`, `effective_version`, `security_version`, `approval_id`, `client_id`, `verifier`, `actor_id`, `state`, `expires_at`, `consumed_at` FROM `cp_pending_approval`;--> statement-breakpoint
DROP TABLE `cp_pending_approval`;--> statement-breakpoint
ALTER TABLE `__old_cp_pending_approval` RENAME TO `cp_pending_approval`;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_pending_approval_semantic_uq` ON `cp_pending_approval` (`logical_host_id`,`approval_id`);--> statement-breakpoint
CREATE INDEX `cp_pending_approval_query_1_idx` ON `cp_pending_approval` (`logical_host_id`,`state`,`expires_at`);--> statement-breakpoint
DROP INDEX `cp_vault_grant_semantic_uq`;--> statement-breakpoint
CREATE TEMP TABLE `__cp_vault_grant_downgrade_guard` (`value` integer UNIQUE);--> statement-breakpoint
INSERT INTO `__cp_vault_grant_downgrade_guard` (`value`) VALUES (1);--> statement-breakpoint
INSERT INTO `__cp_vault_grant_downgrade_guard` (`value`)
SELECT 1
FROM `cp_vault_grant`
GROUP BY `logical_host_id`, `reference_name`, `caplet_id`
HAVING COUNT(*) > 1;--> statement-breakpoint
DROP TABLE `__cp_vault_grant_downgrade_guard`;--> statement-breakpoint
CREATE UNIQUE INDEX `cp_vault_grant_semantic_uq` ON `cp_vault_grant` (`logical_host_id`,`reference_name`,`caplet_id`);--> statement-breakpoint
DROP TABLE `cp_key_canary`;--> statement-breakpoint
DROP TABLE `cp_key_inventory`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
