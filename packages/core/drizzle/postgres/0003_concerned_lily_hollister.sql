ALTER TABLE "caplets"."cp_backup" ADD COLUMN "state_document" jsonb;--> statement-breakpoint
ALTER TABLE "caplets"."cp_migration" ADD COLUMN "state_document" jsonb;--> statement-breakpoint
ALTER TABLE "caplets"."cp_recovery" ADD COLUMN "state_document" jsonb;--> statement-breakpoint
ALTER TABLE "caplets"."cp_recovery_checkpoint" ADD COLUMN "state_document" jsonb;