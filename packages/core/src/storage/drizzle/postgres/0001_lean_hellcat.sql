CREATE TABLE "caplet_installation_observations" (
	"observation_key" text PRIMARY KEY NOT NULL,
	"installation_key" text NOT NULL,
	"resolved_revision" text,
	"content_hash" text,
	"risk" jsonb,
	"status" text NOT NULL,
	"observed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caplet_installations" (
	"installation_key" text PRIMARY KEY NOT NULL,
	"record_key" text NOT NULL,
	"generation" integer NOT NULL,
	"status" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_identity" text NOT NULL,
	"channel" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"detached_at" text,
	"detached_by" text
);
--> statement-breakpoint
CREATE TABLE "host_config_generations" (
	"generation" integer PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_identity" (
	"singleton" integer PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "host_identity_host_id_unique" UNIQUE("host_id")
);
--> statement-breakpoint
CREATE TABLE "host_nodes" (
	"node_id" text PRIMARY KEY NOT NULL,
	"started_at" text NOT NULL,
	"heartbeat_at" text NOT NULL,
	"global_file_manifest" text NOT NULL,
	"runtime_fingerprint" text NOT NULL,
	"ready" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_cursors" (
	"job_name" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_leases" (
	"lease_name" text PRIMARY KEY NOT NULL,
	"owner_node_id" text NOT NULL,
	"fencing_token" integer NOT NULL,
	"expires_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_activity" (
	"activity_key" text PRIMARY KEY NOT NULL,
	"operator_client_id" text NOT NULL,
	"action" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_key" text NOT NULL,
	"outcome" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_access_grants" (
	"record_key" text NOT NULL,
	"vault_key" text NOT NULL,
	"origin_kind" text NOT NULL,
	"origin_path" text,
	"created_at" text NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "vault_access_grants_record_key_vault_key_pk" PRIMARY KEY("record_key","vault_key")
);
--> statement-breakpoint
ALTER TABLE "caplet_installation_observations" ADD CONSTRAINT "caplet_installation_observations_installation_key_caplet_installations_installation_key_fk" FOREIGN KEY ("installation_key") REFERENCES "caplet_installations"("installation_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caplet_installations" ADD CONSTRAINT "caplet_installations_record_key_caplet_records_record_key_fk" FOREIGN KEY ("record_key") REFERENCES "caplet_records"("record_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access_grants" ADD CONSTRAINT "vault_access_grants_record_key_caplet_records_record_key_fk" FOREIGN KEY ("record_key") REFERENCES "caplet_records"("record_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "caplet_installation_observations_installation_idx" ON "caplet_installation_observations" USING btree ("installation_key","observed_at");--> statement-breakpoint
CREATE INDEX "caplet_installations_record_status_idx" ON "caplet_installations" USING btree ("record_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "caplet_installations_key_generation_unique" ON "caplet_installations" USING btree ("installation_key","generation");--> statement-breakpoint
CREATE INDEX "operator_activity_created_idx" ON "operator_activity" USING btree ("created_at");