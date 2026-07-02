# Troubleshooting Caplets CLI Installation

Use this reference when `caplets` is missing, package installation fails, Node/package-manager checks fail, or the CLI installs but is not on PATH.

## Diagnose

Run read-only checks first:

```sh
command -v caplets node npm pnpm bun npx 2>/dev/null || true
node --version 2>/dev/null || true
npm --version 2>/dev/null || true
pnpm --version 2>/dev/null || true
bun --version 2>/dev/null || true
npm config get prefix 2>/dev/null || true
npm bin -g 2>/dev/null || true
```

If `caplets` exists, verify it before reinstalling:

```sh
caplets --version
caplets doctor --format json 2>/dev/null || caplets doctor
```

## Fix patterns

- **No Node/npm:** explain that Caplets is distributed as an npm CLI. Ask before installing Node or changing system package managers.
- **Old Node:** Caplets requires modern Node. Ask the user how they manage Node (`nvm`, `fnm`, `volta`, system package manager) before changing it.
- **Global install rejected by permissions:** prefer a user-owned Node prefix or the user’s version manager. Do not use `sudo npm install -g` unless the user explicitly asks.
- **CLI installed but not found:** identify the global bin path and propose the exact shell profile edit. Ask before editing dotfiles.
- **User prefers no global mutation:** use `npx -y caplets ...` for the approved commands, then ask whether to install persistently later.

## Approval boundary

Package installation, Node installation, and shell profile edits require an exact plan and user approval. Retrying a failed read-only command does not.
