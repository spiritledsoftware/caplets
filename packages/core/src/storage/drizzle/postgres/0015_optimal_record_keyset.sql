CREATE INDEX "caplet_records_updated_key_idx" ON "caplet_records" USING btree ("updated_at","record_key");
