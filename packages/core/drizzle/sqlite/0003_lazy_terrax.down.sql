CREATE TEMP TABLE `__caplets_u7_rollback_guard` (`state_absent` INTEGER NOT NULL);--> statement-breakpoint
INSERT INTO `__caplets_u7_rollback_guard` (`state_absent`)
SELECT NULL
WHERE EXISTS (
  SELECT 1 FROM `cp_recovery_checkpoint` WHERE `state_document` IS NOT NULL
  UNION ALL
  SELECT 1 FROM `cp_recovery` WHERE `state_document` IS NOT NULL
  UNION ALL
  SELECT 1 FROM `cp_migration` WHERE `state_document` IS NOT NULL
  UNION ALL
  SELECT 1 FROM `cp_backup` WHERE `state_document` IS NOT NULL
);--> statement-breakpoint
DROP TABLE `__caplets_u7_rollback_guard`;--> statement-breakpoint
ALTER TABLE `cp_recovery_checkpoint` DROP COLUMN `state_document`;--> statement-breakpoint
ALTER TABLE `cp_recovery` DROP COLUMN `state_document`;--> statement-breakpoint
ALTER TABLE `cp_migration` DROP COLUMN `state_document`;--> statement-breakpoint
ALTER TABLE `cp_backup` DROP COLUMN `state_document`;
