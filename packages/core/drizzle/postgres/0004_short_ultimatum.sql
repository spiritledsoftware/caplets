ALTER TABLE "caplets"."cp_host_setting" DROP CONSTRAINT "cp_host_setting_typed_value_check";--> statement-breakpoint
ALTER TABLE "caplets"."cp_host_setting" ADD CONSTRAINT "cp_host_setting_typed_value_check" CHECK ((
          (
            "caplets"."cp_host_setting"."key" = 'native.daemon-url'
            AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'object'
            AND "caplets"."cp_host_setting"."value" ->> 'source' = 'setup'
            AND jsonb_typeof("caplets"."cp_host_setting"."value" -> 'url') = 'string'
            AND "caplets"."cp_host_setting"."value" - ARRAY['source', 'url']::text[] = '{}'::jsonb
          )
          OR ("caplets"."cp_host_setting"."key" = 'telemetry' AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'boolean')
          OR (
            "caplets"."cp_host_setting"."key" IN (
              'options.defaultSearchLimit',
              'options.exposureDiscoveryTimeoutMs',
              'options.completion.discoveryTimeoutMs',
              'options.completion.overallTimeoutMs'
            )
            AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'number'
            AND ("caplets"."cp_host_setting"."value" #>> '{}')::numeric = trunc(("caplets"."cp_host_setting"."value" #>> '{}')::numeric)
            AND ("caplets"."cp_host_setting"."value" #>> '{}')::numeric > 0
          )
          OR (
            "caplets"."cp_host_setting"."key" = 'options.maxSearchLimit'
            AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'number'
            AND ("caplets"."cp_host_setting"."value" #>> '{}')::numeric = trunc(("caplets"."cp_host_setting"."value" #>> '{}')::numeric)
            AND ("caplets"."cp_host_setting"."value" #>> '{}')::numeric BETWEEN 1 AND 50
          )
          OR (
            "caplets"."cp_host_setting"."key" = 'options.exposureDiscoveryConcurrency'
            AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'number'
            AND ("caplets"."cp_host_setting"."value" #>> '{}')::numeric = trunc(("caplets"."cp_host_setting"."value" #>> '{}')::numeric)
            AND ("caplets"."cp_host_setting"."value" #>> '{}')::numeric BETWEEN 1 AND 32
          )
          OR (
            "caplets"."cp_host_setting"."key" IN (
              'options.completion.cacheTtlMs',
              'options.completion.negativeCacheTtlMs'
            )
            AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'number'
            AND ("caplets"."cp_host_setting"."value" #>> '{}')::numeric = trunc(("caplets"."cp_host_setting"."value" #>> '{}')::numeric)
            AND ("caplets"."cp_host_setting"."value" #>> '{}')::numeric >= 0
          )
          OR (
            "caplets"."cp_host_setting"."key" = 'options.exposure'
            AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'string'
            AND "caplets"."cp_host_setting"."value" #>> '{}' IN (
              'direct',
              'progressive',
              'code_mode',
              'direct_and_code_mode',
              'progressive_and_code_mode'
            )
          )
          OR (
            "caplets"."cp_host_setting"."key" = 'namespaceAliases'
            AND jsonb_typeof("caplets"."cp_host_setting"."value") = 'object'
            AND "caplets"."cp_host_setting"."value" ? 'upstreams'
            AND "caplets"."cp_host_setting"."value" - ARRAY['local', 'upstreams']::text[] = '{}'::jsonb
            AND jsonb_typeof("caplets"."cp_host_setting"."value" -> 'upstreams') = 'object'
            AND (
              NOT ("caplets"."cp_host_setting"."value" ? 'local')
              OR (
                jsonb_typeof("caplets"."cp_host_setting"."value" -> 'local') = 'string'
                AND "caplets"."cp_host_setting"."value" ->> 'local' ~ '^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$'
              )
            )
            AND NOT ("caplets"."cp_host_setting"."value" -> 'upstreams') @? '$.keyvalue() ? (@.key like_regex "^\s*$")'
            AND NOT ("caplets"."cp_host_setting"."value" -> 'upstreams') @? '$.* ? (@.type() != "string")'
            AND NOT ("caplets"."cp_host_setting"."value" -> 'upstreams') @? '$.* ? (!(@ like_regex "^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$"))'
          )
        ));