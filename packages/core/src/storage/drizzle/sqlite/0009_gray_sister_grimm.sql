CREATE TABLE `vault_values` (
	`vault_key` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`version` integer NOT NULL,
	`algorithm` text NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`auth_tag` text NOT NULL,
	`value_bytes` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `vault_values` (`vault_key`, `generation`, `version`, `algorithm`, `nonce`, `ciphertext`, `auth_tag`, `value_bytes`, `created_at`, `updated_at`)
SELECT `state_key`, `generation`, json_extract(`payload`, '$.version'), json_extract(`payload`, '$.algorithm'), json_extract(`payload`, '$.nonce'), json_extract(`payload`, '$.ciphertext'), json_extract(`payload`, '$.authTag'), json_extract(`payload`, '$.valueBytes'), json_extract(`payload`, '$.createdAt'), json_extract(`payload`, '$.updatedAt')
FROM `host_state_records`
WHERE `namespace` = 'vault-values';--> statement-breakpoint
DELETE FROM `host_state_records` WHERE `namespace` = 'vault-values';
