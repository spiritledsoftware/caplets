# OpenCode Live Benchmark Config

`benchmarks/lib/opencode-runner.mjs` generates OpenCode MCP config files into a per-run temp directory, then injects the selected mode through `OPENCODE_CONFIG_CONTENT` while running against the copied benchmark workspace passed through `--dir`. Committed files here are documentation/templates only; generated configs should not be committed.

Assumptions, pending local verification against an installed OpenCode CLI:

- OpenCode accepts non-interactive execution as `opencode run --format json --pure --dangerously-skip-permissions --model <model> --dir <workspace> <prompt>`.
- `--pure` is used to avoid loading external plugins from the caller's OpenCode environment.
- `--dangerously-skip-permissions` is used only against the throwaway copied benchmark workspace so non-interactive runs can edit files under `/tmp`.
- OpenCode reads inline config from `OPENCODE_CONFIG_CONTENT` using an `{ "mcp": { ... } }` shape with local MCP server entries.
- OpenCode local MCP entries accept absolute command arrays such as `["node", "/absolute/server.mjs", "--server", "policy"]`.
- `OPENCODE_CONFIG_DIR` is redirected to a benchmark temp directory to suppress user-global MCP servers while preserving user OpenCode provider credentials and subscription-backed model access.
- `XDG_CONFIG_HOME` is redirected under the benchmark temp directory; `HOME`, XDG data, XDG state, and XDG cache are preserved because OpenCode provider/model access may depend on them.
- Parent `OPENCODE*` and Playwright MCP environment variables are stripped before spawning nested OpenCode so the benchmark does not inherit the caller's OpenCode session tools.
- `OPENCODE_BENCH_COMMAND` can override the executable, and `OPENCODE_BENCH_ARGS` can append extra CLI flags if a local OpenCode version uses different option names.
- Secret-looking values supplied through `OPENCODE_BENCH_ARGS` are passed to OpenCode but redacted from recorded benchmark metadata.

Generated modes:

- `direct-flat`: exposes each mock benchmark MCP server directly.
- `caplets`: exposes the Caplets CLI as one MCP server for progressive disclosure, with downstream mock servers written to an absolute-path Caplets config file.

The OpenCode runner intentionally does not implement the Pi-only `pi-proxy` mode.

`caplets` mode requires a built local CLI at `dist/index.js`; run `pnpm build` before live benchmarks. The runner checks whether the `opencode` CLI is available first, then validates the Caplets build artifact, so a missing CLI is reported as a skipped agent result while a missing build is reported later as a harness/configuration error.

Actual live execution is gated by `CAPLETS_BENCH_LIVE=1` so normal tests only exercise detection and dry-run config creation. If the `opencode` CLI is unavailable even when live mode is enabled, the runner returns a structured skipped/unavailable result instead of spawning OpenCode.
