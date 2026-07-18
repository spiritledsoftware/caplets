CREATE TABLE `caplet_asset_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`payload` blob,
	`object_key` text,
	`verification_status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `caplet_bundle_entries` (
	`revision_key` text NOT NULL,
	`path` text NOT NULL,
	`blob_hash` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`executable` integer NOT NULL,
	PRIMARY KEY(`revision_key`, `path`),
	FOREIGN KEY (`revision_key`) REFERENCES `caplet_revisions`(`revision_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_hash`) REFERENCES `caplet_asset_blobs`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `caplet_records` (
	`record_key` text PRIMARY KEY NOT NULL,
	`caplet_id` text NOT NULL,
	`current_revision_key` text,
	`head_generation` integer NOT NULL,
	`history_limit` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `caplet_records_caplet_id_unique` ON `caplet_records` (`caplet_id`);--> statement-breakpoint
CREATE TABLE `caplet_revision_backends` (
	`revision_key` text NOT NULL,
	`position` integer NOT NULL,
	`family` text NOT NULL,
	`child_id` text,
	`config` text NOT NULL,
	PRIMARY KEY(`revision_key`, `position`),
	FOREIGN KEY (`revision_key`) REFERENCES `caplet_revisions`(`revision_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `caplet_revision_tags` (
	`revision_key` text NOT NULL,
	`position` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`revision_key`, `position`),
	FOREIGN KEY (`revision_key`) REFERENCES `caplet_revisions`(`revision_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `caplet_revisions` (
	`revision_key` text PRIMARY KEY NOT NULL,
	`record_key` text NOT NULL,
	`sequence` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`schema_url` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`source_revision` text,
	`source_content_hash` text,
	`created_at` text NOT NULL,
	`actor` text NOT NULL,
	FOREIGN KEY (`record_key`) REFERENCES `caplet_records`(`record_key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `caplet_revisions_record_sequence_unique` ON `caplet_revisions` (`record_key`,`sequence`);--> statement-breakpoint
CREATE TABLE `caplets_schema` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`applied_at` text NOT NULL
);
