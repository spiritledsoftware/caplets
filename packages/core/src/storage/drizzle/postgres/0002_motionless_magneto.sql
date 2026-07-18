CREATE TABLE "host_state_records" (
	"namespace" text NOT NULL,
	"state_key" text NOT NULL,
	"generation" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "host_state_records_namespace_state_key_pk" PRIMARY KEY("namespace","state_key")
);
