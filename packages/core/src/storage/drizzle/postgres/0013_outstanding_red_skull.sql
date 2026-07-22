CREATE TABLE "idempotency_records" (
	"principal_client_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"owner_token" text,
	"reconciliation_links" text NOT NULL,
	"response_status" integer,
	"response_content_type" text,
	"response_body" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"heartbeat_at" text,
	"terminal_at" text,
	"expires_at" text NOT NULL,
	CONSTRAINT "idempotency_records_principal_client_id_operation_id_idempotency_key_pk" PRIMARY KEY("principal_client_id","operation_id","idempotency_key")
);
--> statement-breakpoint
CREATE INDEX "idempotency_records_principal_created_idx" ON "idempotency_records" USING btree ("principal_client_id","created_at");--> statement-breakpoint
CREATE INDEX "idempotency_records_state_heartbeat_idx" ON "idempotency_records" USING btree ("state","heartbeat_at");--> statement-breakpoint
CREATE INDEX "idempotency_records_state_expiry_idx" ON "idempotency_records" USING btree ("state","expires_at");