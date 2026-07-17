CREATE TEMP TABLE `__caplets_setup_rollback_guard` (`ok` integer);--> statement-breakpoint
CREATE TEMP TRIGGER `__caplets_setup_rollback_guard_trigger` BEFORE INSERT ON `__caplets_setup_rollback_guard` BEGIN SELECT CASE WHEN EXISTS (SELECT 1 FROM `cp_setup_approval`) OR EXISTS (SELECT 1 FROM `cp_setup_attempt`) THEN RAISE(ABORT, 'refusing U10 rollback while durable setup records exist') END; END;--> statement-breakpoint
INSERT INTO `__caplets_setup_rollback_guard` (`ok`) VALUES (1);--> statement-breakpoint
DROP TRIGGER `__caplets_setup_rollback_guard_trigger`;--> statement-breakpoint
DROP TABLE `__caplets_setup_rollback_guard`;--> statement-breakpoint
DROP TABLE `cp_setup_attempt`;--> statement-breakpoint
DROP TABLE `cp_setup_approval`;
