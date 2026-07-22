CREATE TABLE `backend_auth_flows` (
	`flow_id` text PRIMARY KEY NOT NULL,
	`server` text NOT NULL,
	`status` text NOT NULL,
	`envelope_version` integer NOT NULL,
	`encrypted_payload` text,
	`starting_backend_auth_generation` integer,
	`completion_correlation` text,
	`completed_backend_auth_generation` integer,
	`claim_token` text,
	`claimed_at` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`terminal_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backend_auth_flows_claim_token_unique` ON `backend_auth_flows` (`claim_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `backend_auth_flows_completion_correlation_unique` ON `backend_auth_flows` (`completion_correlation`);--> statement-breakpoint
CREATE INDEX `backend_auth_flows_server_created_at_idx` ON `backend_auth_flows` (`server`,`created_at`);--> statement-breakpoint
CREATE INDEX `backend_auth_flows_status_expires_at_idx` ON `backend_auth_flows` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `backend_auth_flows_status_terminal_at_idx` ON `backend_auth_flows` (`status`,`terminal_at`);