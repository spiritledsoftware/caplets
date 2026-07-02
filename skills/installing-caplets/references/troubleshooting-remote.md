# Troubleshooting Self-Hosted Remote Setup

Use this reference for self-hosted remote attach, `caplets remote login <url>`, approval flows, Remote Profiles, and remote URL health failures. Caplets Cloud is hidden until it is available.

## Diagnose

```sh
caplets remote status 2>/dev/null || true
caplets doctor --format json 2>/dev/null || caplets doctor
```

Check only the non-secret remote URL and profile status. Do not ask the user to paste credentials or tokens.

## Fix patterns

- **No Remote Profile:** run `caplets remote login <url>` only after the user approved the remote setup plan.
- **Approval pending:** tell the user to approve from the self-hosted server/operator side using the instructions printed by the CLI. Do not ask them to paste possession secrets into chat.
- **Wrong URL/base path:** verify the URL the user provided and use the same URL in `caplets remote login <url>` and `caplets setup <target> --remote-url <url>`.
- **Remote MCP client config before login:** login first, then write agent config. A config pointing at an untrusted remote will look broken.
- **Generic remote MCP client:** if the CLI refuses to guess a client storage path, write an output config and have the user import it:
  ```sh
  caplets setup mcp-client --remote-url <url> --output ./caplets.mcp.json --yes --format json
  ```
- **Credential leak risk:** Remote credentials belong in Caplets Remote Profiles, not environment variables, settings files, source code, or chat.

## Success check

Remote setup is verified only after Remote Login succeeds, `caplets remote status` or `caplets doctor` shows the profile, and the selected agent config points to `caplets attach <url>` or native remote settings using that same URL.
