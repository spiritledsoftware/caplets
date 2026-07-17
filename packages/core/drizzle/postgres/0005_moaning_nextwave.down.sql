DROP TABLE "caplets"."cp_snapshot_envelope";--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_canary" DROP CONSTRAINT "cp_key_canary_state_check";--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_inventory" DROP CONSTRAINT "cp_key_inventory_state_check";--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_canary" ADD CONSTRAINT "cp_key_canary_state_check" CHECK ("caplets"."cp_key_canary"."state" = 'active');--> statement-breakpoint
ALTER TABLE "caplets"."cp_key_inventory" ADD CONSTRAINT "cp_key_inventory_state_check" CHECK ("caplets"."cp_key_inventory"."state" IN ('active', 'decrypt-only', 'retired', 'destruction-intended', 'destroyed'));