# Pi Live Benchmark Config

`benchmarks/lib/pi-runner.mjs` generates Pi MCP config files into a per-run temp directory. Committed files here are documentation/templates only; generated configs should not be committed.

Assumptions, pending local verification against an installed Pi CLI:

- Pi accepts print mode as `pi -p "query"`.
- Pi accepts JSON output mode as `--mode json`.
- Pi accepts an MCP config path through `--mcp-config <path>` using the common `{ "settings": { ... }, "mcpServers": { ... } }` shape. If a local Pi build expects discovery from project files only, run from the generated mode directory or pass equivalent local flags with `PI_BENCH_ARGS`.
- `PI_CODING_AGENT_DIR` isolates Pi agent state per benchmark run.
- `PI_BENCH_COMMAND` can override the executable, and `PI_BENCH_ARGS` can append extra CLI flags if a local Pi version uses different option names.
- Secret-looking values supplied through `PI_BENCH_ARGS` are passed to Pi but redacted from recorded benchmark metadata.

Generated modes:

- `direct-flat`: exposes each mock benchmark MCP server directly with `directTools: true`.
- `pi-proxy`: uses Pi's documented MCP adapter proxy mode by setting global and per-server `directTools: false`, and writes a project-local `.mcp.json` alongside the Pi-specific config. No fake proxy executable is configured.
- `caplets`: exposes the Caplets CLI as one MCP server for progressive disclosure, with downstream mock servers written to an absolute-path Caplets config file.

`caplets` mode requires a built local CLI at `dist/index.js`; run `pnpm build` before live benchmarks. The runner checks this build artifact before checking whether the `pi` CLI is available, so a missing build is reported as a harness/configuration error rather than a skipped agent result.

Actual live execution is gated by `CAPLETS_BENCH_LIVE=1` so normal tests only exercise detection and dry-run config creation.

If the `pi` CLI is unavailable even when live mode is enabled, the runner returns a structured skipped/unavailable result instead of spawning Pi.
