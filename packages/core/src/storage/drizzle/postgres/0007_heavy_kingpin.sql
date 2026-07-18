CREATE TABLE "project_bindings" (
	"binding_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"project_fingerprint" text NOT NULL,
	"project_root" text NOT NULL,
	"server_project_root" text NOT NULL,
	"owner_node_id" text NOT NULL,
	"generation" integer NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"sync_state" text NOT NULL,
	"readiness" text NOT NULL,
	"active" boolean NOT NULL,
	"last_heartbeat_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"quarantined_at" text,
	"quarantine_reason" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_approvals" (
	"project_fingerprint" text NOT NULL,
	"caplet_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"target_kind" text NOT NULL,
	"generation" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"approved_at" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "setup_approvals_project_fingerprint_caplet_id_content_hash_target_kind_pk" PRIMARY KEY("project_fingerprint","caplet_id","content_hash","target_kind")
);
--> statement-breakpoint
CREATE TABLE "setup_attempt_sets" (
	"project_fingerprint" text NOT NULL,
	"caplet_id" text NOT NULL,
	"generation" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "setup_attempt_sets_project_fingerprint_caplet_id_pk" PRIMARY KEY("project_fingerprint","caplet_id")
);
--> statement-breakpoint
CREATE INDEX "project_bindings_owner_expiry_idx" ON "project_bindings" USING btree ("owner_node_id","expires_at");--> statement-breakpoint
CREATE INDEX "project_bindings_active_expiry_idx" ON "project_bindings" USING btree ("active","expires_at");