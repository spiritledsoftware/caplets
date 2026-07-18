CREATE TABLE `dashboard_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`secret_hash` text NOT NULL,
	`operator_client_id` text NOT NULL,
	`role` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_used_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dashboard_sessions_expires_at_idx` ON `dashboard_sessions` (`expires_at`);--> statement-breakpoint
CREATE INDEX `dashboard_sessions_last_used_at_idx` ON `dashboard_sessions` (`last_used_at`);