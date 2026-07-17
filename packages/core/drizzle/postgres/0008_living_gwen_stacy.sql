ALTER TABLE "caplets"."cp_vault_grant" DROP CONSTRAINT "cp_vault_grant_relation_1_fk";--> statement-breakpoint
CREATE INDEX "cp_operation_outcome_query_1_idx" ON "caplets"."cp_operation_outcome" USING btree ("logical_host_id","store_id","convergence_class","operation_id");
