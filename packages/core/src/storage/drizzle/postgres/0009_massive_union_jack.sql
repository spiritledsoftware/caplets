CREATE TABLE "vault_values" (
	"vault_key" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"version" integer NOT NULL,
	"algorithm" text NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"auth_tag" text NOT NULL,
	"value_bytes" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "vault_values" ("vault_key", "generation", "version", "algorithm", "nonce", "ciphertext", "auth_tag", "value_bytes", "created_at", "updated_at")
SELECT "state_key", "generation", ("payload" ->> 'version')::integer, "payload" ->> 'algorithm', "payload" ->> 'nonce', "payload" ->> 'ciphertext', "payload" ->> 'authTag', ("payload" ->> 'valueBytes')::integer, "payload" ->> 'createdAt', "payload" ->> 'updatedAt'
FROM "host_state_records"
WHERE "namespace" = 'vault-values';--> statement-breakpoint
DELETE FROM "host_state_records" WHERE "namespace" = 'vault-values';
