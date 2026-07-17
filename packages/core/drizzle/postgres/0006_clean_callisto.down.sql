DO $$ BEGIN IF EXISTS (SELECT 1 FROM "caplets"."cp_setup_approval") OR EXISTS (SELECT 1 FROM "caplets"."cp_setup_attempt") THEN RAISE EXCEPTION 'refusing U10 rollback while durable setup records exist'; END IF; END $$;--> statement-breakpoint
DROP TABLE "caplets"."cp_setup_attempt";--> statement-breakpoint
DROP TABLE "caplets"."cp_setup_approval";
