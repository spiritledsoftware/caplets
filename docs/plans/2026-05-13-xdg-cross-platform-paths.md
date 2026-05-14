# XDG and Cross-Platform Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Caplets user config to XDG/standard platform config locations and OAuth state to XDG/standard platform state locations.

**Architecture:** Centralize all default user paths in `src/config/paths.ts`, then consume those shared defaults from config loading, CLI inspection, installation, runtime, and auth storage. Project-local `./.caplets` behavior stays unchanged because it is project state, not user state. `CAPLETS_CONFIG` remains the explicit config override, and internal/test `authDir` overrides remain supported.

**Tech Stack:** Node.js 22, TypeScript, Vitest, Commander, Caplets existing config/auth modules.

---

## Target Paths

| Platform         | Config                                              | State/Auth                                                     |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Linux/macOS/Unix | `${XDG_CONFIG_HOME:-~/.config}/caplets/config.json` | `${XDG_STATE_HOME:-~/.local/state}/caplets/auth/<server>.json` |
| Windows          | `%APPDATA%\\caplets\\config.json`                   | `%LOCALAPPDATA%\\caplets\\auth\\<server>.json`                 |
| Override         | `CAPLETS_CONFIG=/custom/config.json` wins           | Existing `authDir` option wins                                 |

XDG environment variables must be absolute. Relative `XDG_CONFIG_HOME` and `XDG_STATE_HOME` values are ignored.

## File Structure

- Modify: `src/config/paths.ts` - own all platform-specific default path resolution.
- Modify: `src/auth/store.ts` - use the shared default auth directory instead of hard-coding `~/.caplets/auth`.
- Modify: `src/cli/inspection.ts` - expose the split config and state roots in `caplets config paths`.
- Modify: `test/config.test.ts` or create `test/config-paths.test.ts` - cover path helper behavior.
- Modify: `test/cli.test.ts` - update path inspection expectations.
- Modify: `README.md` - document XDG and Windows paths.
- Modify: `docs/product/caplets-progressive-mcp-disclosure-prd.md` - update product/default path references.
- Create: `.changeset/<name>.md` - note the pre-1.0 default location change.

### Task 1: Platform-Aware Path Helpers

**Files:**

- Modify: `src/config/paths.ts`
- Test: `test/config-paths.test.ts`

- [ ] **Step 1: Write path helper tests**

Add tests that call injectable helper functions with explicit environment, home, and platform inputs. Cover Unix defaults, Unix XDG overrides, ignored relative XDG overrides, Windows environment defaults, and Windows homedir fallbacks.

- [ ] **Step 2: Run path helper tests to verify they fail**

Run: `pnpm vitest run test/config-paths.test.ts`

Expected: FAIL because the injectable helpers do not exist yet.

- [ ] **Step 3: Implement path helpers**

In `src/config/paths.ts`, add exported helpers equivalent to:

```ts
type Platform = NodeJS.Platform;
type PathEnv = NodeJS.ProcessEnv;

export function defaultConfigBaseDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  if (platform === "win32") {
    return env.APPDATA && isAbsolute(env.APPDATA) ? env.APPDATA : join(home, "AppData", "Roaming");
  }
  return env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : join(home, ".config");
}

export function defaultStateBaseDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  if (platform === "win32") {
    return env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : join(home, "AppData", "Local");
  }
  return env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : join(home, ".local", "state");
}

export function defaultConfigPath(...): string {
  return join(defaultConfigBaseDir(...), "caplets", "config.json");
}

export function defaultAuthDir(...): string {
  return join(defaultStateBaseDir(...), "caplets", "auth");
}
```

Keep exported `DEFAULT_CONFIG_PATH` and `DEFAULT_AUTH_DIR`, but define them from the new functions.

- [ ] **Step 4: Run path helper tests to verify they pass**

Run: `pnpm vitest run test/config-paths.test.ts`

Expected: PASS.

### Task 2: Auth Store Uses State Directory

**Files:**

- Modify: `src/auth/store.ts`
- Test: `test/auth.test.ts`

- [ ] **Step 1: Write or update auth default tests**

Add coverage proving `authStorePath("remote")` resolves under the shared default auth dir. Keep traversal rejection coverage intact.

- [ ] **Step 2: Run auth tests to verify they fail before implementation**

Run: `pnpm vitest run test/auth.test.ts`

Expected: FAIL if the test expects the new default while the auth store still hard-codes `~/.caplets/auth`.

- [ ] **Step 3: Update auth store default**

Import `DEFAULT_AUTH_DIR` from `../config/paths.js`, remove direct `homedir()` usage, and use `DEFAULT_AUTH_DIR` in `authStorePath` and `listTokenBundles` defaults.

- [ ] **Step 4: Run auth tests to verify they pass**

Run: `pnpm vitest run test/auth.test.ts`

Expected: PASS.

### Task 3: CLI Path Inspection

**Files:**

- Modify: `src/cli/inspection.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Update CLI path inspection tests**

Update `caplets config paths --json` expectations to include `stateRoot`, and verify `authDir` can still be overridden by the internal test `authDir` option.

- [ ] **Step 2: Run CLI tests to verify they fail before implementation**

Run: `pnpm vitest run test/cli.test.ts`

Expected: FAIL because `stateRoot` is not present yet.

- [ ] **Step 3: Update inspection output**

Import `defaultStateBaseDir` if needed, add `stateRoot: dirname(authDir ?? DEFAULT_AUTH_DIR)` or equivalent root reporting, and update human `formatConfigPaths` output.

- [ ] **Step 4: Run CLI tests to verify they pass**

Run: `pnpm vitest run test/cli.test.ts`

Expected: PASS.

### Task 4: Documentation and Changeset

**Files:**

- Modify: `README.md`
- Modify: `docs/product/caplets-progressive-mcp-disclosure-prd.md`
- Create: `.changeset/<name>.md`

- [ ] **Step 1: Update README paths**

Replace default user config references with `~/.config/caplets/config.json`, auth state references with `~/.local/state/caplets/auth/<server>.json`, and include Windows `%APPDATA%\\caplets\\config.json` and `%LOCALAPPDATA%\\caplets\\auth` equivalents.

- [ ] **Step 2: Update PRD path references**

Update all user-level path references from `~/.caplets` to the new split config/state locations. Keep project `./.caplets` references unchanged.

- [ ] **Step 3: Add changeset**

Create a minor changeset explaining that default config and OAuth token state locations now follow XDG and Windows platform conventions.

- [ ] **Step 4: Check docs for stale user path references**

Run a content search for `~/.caplets` and `.caplets/auth` and update stale default-user references only. Existing historical plans may remain unchanged if they describe already-completed old work.

### Task 5: Full Verification and Review

**Files:**

- Verify all modified files.

- [ ] **Step 1: Run targeted tests**

Run: `pnpm vitest run test/config-paths.test.ts test/config.test.ts test/cli.test.ts test/auth.test.ts`

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run: `pnpm verify`

Expected: PASS.

- [ ] **Step 3: Review changed diff**

Inspect the final diff for accidental compatibility fallback to `~/.caplets`, stale docs, or unrelated changes.
