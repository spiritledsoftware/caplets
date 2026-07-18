PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_vault_access_grants` (
	`subject_kind` text NOT NULL,
	`subject_key` text NOT NULL,
	`record_key` text,
	`caplet_id` text,
	`vault_key` text NOT NULL,
	`reference_name` text NOT NULL,
	`origin_kind` text NOT NULL,
	`origin_path` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	PRIMARY KEY(`subject_kind`, `subject_key`, `reference_name`),
	FOREIGN KEY (`record_key`) REFERENCES `caplet_records`(`record_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_vault_access_grants`("subject_kind", "subject_key", "record_key", "caplet_id", "vault_key", "reference_name", "origin_kind", "origin_path", "created_at", "created_by") SELECT 'record', "record_key", "record_key", NULL, "vault_key", "reference_name", "origin_kind", "origin_path", "created_at", "created_by" FROM `vault_access_grants`;--> statement-breakpoint
DROP TABLE `vault_access_grants`;--> statement-breakpoint
ALTER TABLE `__new_vault_access_grants` RENAME TO `vault_access_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;