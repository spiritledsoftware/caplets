PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_backend_auth_states` (
	`server` text PRIMARY KEY NOT NULL,
	`generation` integer NOT NULL,
	`token_bundle` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_backend_auth_states`("server", "generation", "token_bundle", "created_at", "updated_at") SELECT "server", "generation", "token_bundle", "created_at", "updated_at" FROM `backend_auth_states`;--> statement-breakpoint
DROP TABLE `backend_auth_states`;--> statement-breakpoint
ALTER TABLE `__new_backend_auth_states` RENAME TO `backend_auth_states`;--> statement-breakpoint
PRAGMA foreign_keys=ON;