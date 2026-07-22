WITH `migration_clock` (`terminal_at`) AS (
	SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
UPDATE `backend_auth_flows`
SET
	`status` = CASE
		WHEN `status` = 'pending' THEN 'failed'
		ELSE 'unknown'
	END,
	`starting_backend_auth_generation` = NULL,
	`completion_correlation` = NULL,
	`completed_backend_auth_generation` = NULL,
	`claim_token` = NULL,
	`claimed_at` = NULL,
	`terminal_at` = (SELECT `terminal_at` FROM `migration_clock`),
	`updated_at` = (SELECT `terminal_at` FROM `migration_clock`)
WHERE `status` IN ('pending', 'completing');