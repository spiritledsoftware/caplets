ALTER TABLE `cp_backup` ADD COLUMN `state_document` text CHECK (`state_document` IS NULL OR json_valid(`state_document`));--> statement-breakpoint
ALTER TABLE `cp_migration` ADD COLUMN `state_document` text CHECK (`state_document` IS NULL OR json_valid(`state_document`));--> statement-breakpoint
ALTER TABLE `cp_recovery` ADD COLUMN `state_document` text CHECK (`state_document` IS NULL OR json_valid(`state_document`));--> statement-breakpoint
ALTER TABLE `cp_recovery_checkpoint` ADD COLUMN `state_document` text CHECK (`state_document` IS NULL OR json_valid(`state_document`));
