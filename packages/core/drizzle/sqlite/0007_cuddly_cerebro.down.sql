CREATE TEMP TABLE `__caplets_setup_execution_rollback_guard` (`ok` integer);
--> statement-breakpoint
CREATE TEMP TRIGGER `__caplets_setup_execution_rollback_guard_trigger` BEFORE INSERT ON `__caplets_setup_execution_rollback_guard` BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM `cp_setup_execution`) THEN RAISE(ABORT, 'refusing U10 rollback while setup execution leases exist') END; END;
--> statement-breakpoint
INSERT INTO `__caplets_setup_execution_rollback_guard` (`ok`) VALUES (1);
--> statement-breakpoint
DROP TRIGGER `__caplets_setup_execution_rollback_guard_trigger`;
--> statement-breakpoint
DROP TABLE `__caplets_setup_execution_rollback_guard`;
--> statement-breakpoint
DROP TABLE `cp_setup_execution`;
