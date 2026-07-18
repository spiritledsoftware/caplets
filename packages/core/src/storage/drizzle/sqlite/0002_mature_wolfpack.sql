CREATE TABLE `host_state_records` (
	`namespace` text NOT NULL,
	`state_key` text NOT NULL,
	`generation` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`namespace`, `state_key`)
);
