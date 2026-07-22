ALTER TABLE `remote_clients` ADD `generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `remote_pending_logins` ADD `generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `vault_access_grants` ADD `resource_version` text DEFAULT 'pending-v16' NOT NULL;--> statement-breakpoint
UPDATE `vault_access_grants`
SET `resource_version` = 'legacy-v16-' || lower(hex(
	length(`subject_kind`) || ':' || `subject_kind` ||
	length(`subject_key`) || ':' || `subject_key` ||
	length(`reference_name`) || ':' || `reference_name`
));