# Caplets Vault

Caplets Vault is a runtime-owned encrypted string store for secret-like config values. It replaces
fragile process environment propagation when an agent harness does not pass environment variables to
the Caplets runtime.

## Config Syntax

Use Vault references anywhere normal config interpolation applies:

```json
{
  "mcpServers": {
    "github": {
      "name": "GitHub",
      "description": "GitHub tools",
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp",
      "auth": { "type": "bearer", "token": "$vault:GH_TOKEN" }
    }
  }
}
```

Both `$vault:NAME` and `${vault:NAME}` are supported. Public metadata fields such as `name`,
`description`, `tags`, and Markdown body text preserve the literal reference text.

## Local Vault

Local/global is the default target:

```sh
caplets vault set GH_TOKEN
caplets vault access grant GH_TOKEN github
```

For common one-key setup, set and grant atomically:

```sh
caplets vault set GH_TOKEN --grant github
```

`caplets vault get NAME` prints metadata only. Use `--show` for an explicit human reveal.

## Remote Vault

Use `--remote` when the Caplet executes in a generic remote Current Host:

```sh
caplets vault set GH_TOKEN --remote --grant github
caplets vault access grant GH_TOKEN github --remote
```

Remote Vault values are owned by the selected Current Host. Local Caplets do not read, mirror, or
forward remote Vault values.

Remote CLI and generated Caplets SDK clients can read metadata but cannot reveal raw values. Raw
Vault Reveal remains the same-origin dashboard-private ceremony at
`/dashboard/api/private/vault-reveals`; it requires the Dashboard Session Credential, current CSRF
value, and exact confirmation, and returns `Cache-Control: no-store`.

## Grants And Remapping

Vault resolution requires an access grant for the stored key, Caplet ID, referenced key name, and
config origin. Use `--as` when the stored key and config reference differ:

```sh
caplets vault access grant GH_TOKEN_PERSONAL github-personal --as GH_TOKEN
caplets vault access grant GH_TOKEN_WORK github-work --as GH_TOKEN
```

## Diagnostics

Unset, unavailable, invalid, or ungranted Vault references quarantine only the affected Caplet.
`caplets doctor` reports the key, Caplet, target, config path, and repair command without printing
raw values.
