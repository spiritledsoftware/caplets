# Troubleshooting Caplets Daemon Setup

Use this reference for local daemon-first failures: daemon install/start/status, health checks, port conflicts, and daemon sections in `caplets doctor`.

## Diagnose

```sh
caplets doctor --format json 2>/dev/null || caplets doctor
caplets daemon status 2>/dev/null || true
caplets daemon logs 2>/dev/null || true
```

If doctor reports a health URL, check it without exposing unrelated network data:

```sh
curl -fsS <health-url> 2>/dev/null || true
```

## Fix patterns

- **Daemon not running:** retry the already-approved daemon start/setup command once. This is a safe auto-fix when the user already approved local setup.
- **Port conflict:** do not kill processes automatically. Identify the conflict and propose either changing Caplets serve defaults or freeing the port.
- **Config invalid:** keep the last known-good behavior in mind. Show the relevant Caplets config path and error, then propose the smallest edit.
- **Permission/cache issue:** diagnose the Caplets-owned cache/config path. Ask before deleting or changing ownership.
- **Health fails after start:** collect daemon logs and doctor output, then propose one fix plan.

## Success check

Local setup is not verified until `caplets doctor` reports a healthy daemon or setup output confirms the daemon URL and the selected agent is configured to run `caplets attach <local-daemon-url>` or native daemon defaults.
