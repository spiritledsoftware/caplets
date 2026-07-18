CREATE TABLE "remote_client_superseded_refresh_tokens" (
	"family_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"superseded_at" text NOT NULL,
	CONSTRAINT "remote_client_superseded_refresh_tokens_family_id_token_hash_pk" PRIMARY KEY("family_id","token_hash")
);
--> statement-breakpoint
CREATE TABLE "remote_client_token_families" (
	"family_id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "remote_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_label" text NOT NULL,
	"role" text NOT NULL,
	"host_url" text NOT NULL,
	"access_token_hash" text NOT NULL,
	"access_expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "remote_pairing_codes" (
	"code_id" text PRIMARY KEY NOT NULL,
	"host_url" text NOT NULL,
	"secret_hash" text NOT NULL,
	"client_label" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"attempts" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"used_at" text
);
--> statement-breakpoint
CREATE TABLE "remote_pending_logins" (
	"flow_id" text PRIMARY KEY NOT NULL,
	"host_url" text NOT NULL,
	"host_identity" text,
	"operator_code_hash" text NOT NULL,
	"pending_refresh_hash" text NOT NULL,
	"pending_refresh_replay" jsonb,
	"pending_completion_hash" text NOT NULL,
	"completion_replay" jsonb,
	"client_label" text NOT NULL,
	"requested_role" text NOT NULL,
	"granted_role" text,
	"client_fingerprint" text,
	"source_hint" text,
	"created_at" text NOT NULL,
	"code_expires_at" text NOT NULL,
	"flow_expires_at" text NOT NULL,
	"status" text NOT NULL,
	"operator_code_fingerprint" text,
	"approved_at" text,
	"denied_at" text,
	"cancelled_at" text,
	"exchanged_at" text
);
--> statement-breakpoint
CREATE TABLE "remote_pending_superseded_refresh_tokens" (
	"flow_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"superseded_at" text NOT NULL,
	CONSTRAINT "remote_pending_superseded_refresh_tokens_flow_id_token_hash_pk" PRIMARY KEY("flow_id","token_hash")
);
--> statement-breakpoint
ALTER TABLE "remote_client_superseded_refresh_tokens" ADD CONSTRAINT "remote_client_superseded_refresh_tokens_family_id_remote_client_token_families_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "remote_client_token_families"("family_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_client_token_families" ADD CONSTRAINT "remote_client_token_families_client_id_remote_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "remote_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_pending_superseded_refresh_tokens" ADD CONSTRAINT "remote_pending_superseded_refresh_tokens_flow_id_remote_pending_logins_flow_id_fk" FOREIGN KEY ("flow_id") REFERENCES "remote_pending_logins"("flow_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "remote_client_superseded_refresh_hash_unique" ON "remote_client_superseded_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_client_token_families_client_unique" ON "remote_client_token_families" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_client_token_families_refresh_hash_unique" ON "remote_client_token_families" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_clients_access_token_hash_unique" ON "remote_clients" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_pending_logins_operator_code_hash_unique" ON "remote_pending_logins" USING btree ("operator_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_pending_logins_refresh_hash_unique" ON "remote_pending_logins" USING btree ("pending_refresh_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_pending_logins_completion_hash_unique" ON "remote_pending_logins" USING btree ("pending_completion_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_pending_superseded_refresh_hash_unique" ON "remote_pending_superseded_refresh_tokens" USING btree ("token_hash");