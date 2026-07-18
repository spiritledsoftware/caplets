CREATE TABLE "backend_auth_states" (
	"server" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"token_bundle" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "backend_auth_states" ("server", "generation", "token_bundle", "created_at", "updated_at")
SELECT "state_key", "generation", "payload", "created_at", "updated_at"
FROM "host_state_records"
WHERE "namespace" = 'backend-auth';
--> statement-breakpoint
DELETE FROM "host_state_records" WHERE "namespace" = 'backend-auth';
