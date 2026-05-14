# OpenCode Live Benchmark Config

`benchmarks/lib/opencode-runner.mjs` generates OpenCode MCP config files into a per-run temp directory, then writes the selected mode to `opencode.json` inside the copied benchmark workspace passed through `--dir`. Committed files here are documentation/templates only; generated configs should not be committed.

Assumptions, pending local verification against an installed OpenCode CLI:

- OpenCode accepts non-interactive execution as `opencode run --format json --model <model> --dir <workspace> <prompt>`.
- OpenCode reads project-local `opencode.json` from the `--dir` workspace using an `{ "mcp": { ... } }` shape with local MCP server entries.
- OpenCode local MCP entries accept absolute command arrays such as `["node", "/absolute/server.mjs", "--server", "policy"]`.
- `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` are redirected to the benchmark temp directory for best-effort isolation. If a local OpenCode build reads additional state paths, those are not currently guaranteed isolated.
- `OPENCODE_BENCH_COMMAND` can override the executable, and `OPENCODE_BENCH_ARGS` can append extra CLI flags if a local OpenCode version uses different option names.
- Secret-looking values supplied through `OPENCODE_BENCH_ARGS` are passed to OpenCode but redacted from recorded benchmark metadata.

Generated modes:

- `direct-flat`: exposes each mock benchmark MCP server directly.
- `caplets`: exposes the Caplets CLI as one MCP server for progressive disclosure, with downstream mock servers written to an absolute-path Caplets config file.

The OpenCode runner intentionally does not implement the Pi-only `pi-proxy` mode.

`caplets` mode requires a built local CLI at `dist/index.js`; run `pnpm build` before live benchmarks. The runner checks this build artifact before checking whether the `opencode` CLI is available, so a missing build is reported as a harness/configuration error rather than a skipped agent result.

Actual live execution is gated by `CAPLETS_BENCH_LIVE=1` so normal tests only exercise detection and dry-run config creation. If the `opencode` CLI is unavailable even when live mode is enabled, the runner returns a structured skipped/unavailable result instead of spawning OpenCode.
