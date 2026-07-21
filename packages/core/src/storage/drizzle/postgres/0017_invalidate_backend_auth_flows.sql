WITH "migration_clock" ("terminal_at") AS (
	SELECT to_char(
		transaction_timestamp() AT TIME ZONE 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
	)
)
UPDATE "backend_auth_flows" AS "flow"
SET
	"status" = CASE
		WHEN "flow"."status" = 'pending' THEN 'failed'
		ELSE 'unknown'
	END,
	"starting_backend_auth_generation" = NULL,
	"completion_correlation" = NULL,
	"completed_backend_auth_generation" = NULL,
	"claim_token" = NULL,
	"claimed_at" = NULL,
	"terminal_at" = "migration_clock"."terminal_at",
	"updated_at" = "migration_clock"."terminal_at"
FROM "migration_clock"
WHERE "flow"."status" IN ('pending', 'completing');