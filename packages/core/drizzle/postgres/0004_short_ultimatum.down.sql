DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "caplets"."cp_host_setting" WHERE "key" <> 'native.daemon-url'
  ) THEN
    RAISE EXCEPTION 'refusing U8 rollback while mutable host settings exist';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_typed_value_check";--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_typed_value_check" CHECK ("caplets"."cp_host_setting"."key" = 'native.daemon-url' AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'object' AND "caplets"."cp_host_setting"."value" ->> 'source' = 'setup' AND jsonb_typeof("caplets"."cp_host_setting"."value" -> 'url') = 'string');
