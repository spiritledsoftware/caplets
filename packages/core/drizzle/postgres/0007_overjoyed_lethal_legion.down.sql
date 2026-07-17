DO $$ BEGIN IF EXISTS (SELECT 1 FROM "caplets"."cp_setup_execution") THEN RAISE EXCEPTION 'refusing U10 rollback while setup execution leases exist'; END IF; END $$;
--> statement-breakpoint
DROP TABLE "caplets"."cp_setup_execution";
