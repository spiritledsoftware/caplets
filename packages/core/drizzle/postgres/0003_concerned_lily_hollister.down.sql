DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "caplets"."cp_recovery_checkpoint" WHERE "state_document" IS NOT NULL
    UNION ALL
    SELECT 1 FROM "caplets"."cp_recovery" WHERE "state_document" IS NOT NULL
    UNION ALL
    SELECT 1 FROM "caplets"."cp_migration" WHERE "state_document" IS NOT NULL
    UNION ALL
    SELECT 1 FROM "caplets"."cp_backup" WHERE "state_document" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'refusing U7 rollback while durable state documents exist';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "caplets"."cp_recovery_checkpoint" DROP COLUMN "state_document";--> statement-breakpoint
ALTER TABLE "caplets"."cp_recovery" DROP COLUMN "state_document";--> statement-breakpoint
ALTER TABLE "caplets"."cp_migration" DROP COLUMN "state_document";--> statement-breakpoint
ALTER TABLE "caplets"."cp_backup" DROP COLUMN "state_document";
