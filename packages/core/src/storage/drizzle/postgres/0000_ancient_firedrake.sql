CREATE TABLE "caplet_asset_blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"size" integer NOT NULL,
	"payload" "bytea",
	"object_key" text,
	"verification_status" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caplet_bundle_entries" (
	"revision_key" text NOT NULL,
	"path" text NOT NULL,
	"blob_hash" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"executable" boolean NOT NULL,
	CONSTRAINT "caplet_bundle_entries_revision_key_path_pk" PRIMARY KEY("revision_key","path")
);
--> statement-breakpoint
CREATE TABLE "caplet_records" (
	"record_key" text PRIMARY KEY NOT NULL,
	"caplet_id" text NOT NULL,
	"current_revision_key" text,
	"head_generation" integer NOT NULL,
	"history_limit" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caplet_revision_backends" (
	"revision_key" text NOT NULL,
	"position" integer NOT NULL,
	"family" text NOT NULL,
	"child_id" text,
	"config" jsonb NOT NULL,
	CONSTRAINT "caplet_revision_backends_revision_key_position_pk" PRIMARY KEY("revision_key","position")
);
--> statement-breakpoint
CREATE TABLE "caplet_revision_tags" (
	"revision_key" text NOT NULL,
	"position" integer NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "caplet_revision_tags_revision_key_position_pk" PRIMARY KEY("revision_key","position")
);
--> statement-breakpoint
CREATE TABLE "caplet_revisions" (
	"revision_key" text PRIMARY KEY NOT NULL,
	"record_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"schema_url" text,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"source_revision" text,
	"source_content_hash" text,
	"created_at" text NOT NULL,
	"actor" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caplets_schema" (
	"singleton" integer PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"applied_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "caplet_bundle_entries" ADD CONSTRAINT "caplet_bundle_entries_revision_key_caplet_revisions_revision_key_fk" FOREIGN KEY ("revision_key") REFERENCES "caplet_revisions"("revision_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caplet_bundle_entries" ADD CONSTRAINT "caplet_bundle_entries_blob_hash_caplet_asset_blobs_hash_fk" FOREIGN KEY ("blob_hash") REFERENCES "caplet_asset_blobs"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caplet_revision_backends" ADD CONSTRAINT "caplet_revision_backends_revision_key_caplet_revisions_revision_key_fk" FOREIGN KEY ("revision_key") REFERENCES "caplet_revisions"("revision_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caplet_revision_tags" ADD CONSTRAINT "caplet_revision_tags_revision_key_caplet_revisions_revision_key_fk" FOREIGN KEY ("revision_key") REFERENCES "caplet_revisions"("revision_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caplet_revisions" ADD CONSTRAINT "caplet_revisions_record_key_caplet_records_record_key_fk" FOREIGN KEY ("record_key") REFERENCES "caplet_records"("record_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "caplet_records_caplet_id_unique" ON "caplet_records" USING btree ("caplet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "caplet_revisions_record_sequence_unique" ON "caplet_revisions" USING btree ("record_key","sequence");