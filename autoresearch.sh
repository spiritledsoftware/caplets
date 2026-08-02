#!/usr/bin/env bash
set -euo pipefail

output_base_dir="${HOME}/.omp/caplets-autoresearch-live"
mkdir -p "$output_base_dir"
output_dir="$(mktemp -d "$output_base_dir/run-XXXXXX")"
wrapper_dir="$(mktemp -d)"
trap 'rm -rf "$output_dir" "$wrapper_dir"' EXIT
constraint_spec="mcp<2"
constraint_path="$wrapper_dir/uv-constraints.txt"
printf '%s\n' "$constraint_spec" >"$constraint_path"

real_executor="$(command -v executor)"
executor_wrapper="$wrapper_dir/executor"
cat >"$executor_wrapper" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail

stop_task_daemon() {
  "$REAL_EXECUTOR" daemon stop >/dev/null 2>&1 || true
}

if [[ "$#" -ge 1 && "$1" == "mcp" ]]; then
  trap stop_task_daemon EXIT
  set +e
  "$REAL_EXECUTOR" "$@"
  command_status=$?
  set -e
  exit "$command_status"
fi

is_add_server=false
is_connection_setup=false
if [[ "$#" -ge 5 && "$1" == "call" && "$2" == "executor" && "$3" == "mcp" && "$4" == "addServer" ]]; then
  is_add_server=true
elif [[ "$#" -ge 6 && "$1" == "call" && "$2" == "executor" && "$3" == "coreTools" && "$4" == "connections" && ( "$5" == "create" || "$5" == "refresh" ) ]]; then
  is_connection_setup=true
fi

if [[ "$is_add_server" == false && "$is_connection_setup" == false ]]; then
  exec "$REAL_EXECUTOR" "$@"
fi

call_args=("$@")
if [[ "$is_add_server" == true ]]; then
  normalized_payload="$(PAYLOAD="$5" node -e '
    const input = JSON.parse(process.env.PAYLOAD);
    if (input.command === "uvx" && input.args?.includes("mcp-server-git")) {
      input.args = ["--with", process.env.MCP_CONSTRAINT, ...input.args];
      input.env = { ...input.env, UV_CONSTRAINT: process.env.UV_CONSTRAINT };
    }
    process.stdout.write(JSON.stringify(input));
  ')"
  call_args[4]="$normalized_payload"
elif [[ "$is_connection_setup" == true && "$5" == "create" ]]; then
  normalized_payload="$(PAYLOAD="$6" node -e '
    const input = JSON.parse(process.env.PAYLOAD);
    if (input.template === "none" && input.from?.provider === "file" && input.from?.id === "empty") {
      delete input.from;
    }
    process.stdout.write(JSON.stringify(input));
  ')"
  call_args[5]="$normalized_payload"
fi

set +e
call_output="$("$REAL_EXECUTOR" "${call_args[@]}" 2>&1)"
call_status=$?
set -e
if [[ "$call_status" -ne 0 ]]; then
  printf '%s\n' "$call_output" >&2
  exit "$call_status"
fi
if [[ ! "$call_output" =~ executionId:[[:space:]]*([^[:space:]]+) ]]; then
  printf '%s\n' "$call_output"
  exit 0
fi

execution_id="${BASH_REMATCH[1]}"
if [[ ! "$call_output" =~ (https?://localhost:[0-9]+)/resume/ ]]; then
  printf '%s\n' "$call_output" >&2
  exit 1
fi
base_url="${BASH_REMATCH[1]}"

set +e
resume_output="$("$REAL_EXECUTOR" resume \
  --execution-id "$execution_id" \
  --base-url "$base_url" \
  --action accept \
  --content '{}' 2>&1)"
resume_status=$?
set -e
if [[ "$resume_status" -ne 0 ]]; then
  printf '%s\n' "$resume_output" >&2
  exit "$resume_status"
fi

if [[ "$is_connection_setup" == true ]]; then
  printf '%s\n' "$resume_output"
  exit 0
fi

if RESUME_OUTPUT="$resume_output" node -e '
  const result = JSON.parse(process.env.RESUME_OUTPUT);
  if (result?.ok !== true || typeof result.data?.slug !== "string") process.exit(1);
' 2>/dev/null; then
  printf '%s\n' "$resume_output"
  exit 0
fi

if [[ ! "$5" =~ \"slug\":\"([^\"]+)\" ]]; then
  printf '%s\n' "$resume_output" >&2
  exit 1
fi
slug="${BASH_REMATCH[1]}"
set +e
verify_output="$("$REAL_EXECUTOR" call executor mcp getServer "{\"slug\":\"$slug\"}" 2>&1)"
verify_status=$?
set -e
if [[ "$verify_status" -ne 0 ]]; then
  printf '%s\n' "$verify_output" >&2
  exit "$verify_status"
fi
VERIFY_OUTPUT="$verify_output" SLUG="$slug" node -e '
  const result = JSON.parse(process.env.VERIFY_OUTPUT);
  const integration = result.ok === true ? result.data?.integration : result.integration;
  if (integration?.slug !== process.env.SLUG) process.exit(1);
'
SLUG="$slug" node -e 'console.log(JSON.stringify({ ok: true, data: { slug: process.env.SLUG } }))'
WRAPPER
chmod +x "$executor_wrapper"

pnpm --filter @caplets/core build >/dev/null
REAL_EXECUTOR="$real_executor" MCP_CONSTRAINT="$constraint_spec" UV_CONSTRAINT="$constraint_path" CAPLETS_BENCH_LIVE=1 \
  pnpm --filter @caplets/benchmarks exec tsx run-pi-eval.ts \
  --task-suite mcp-real-world-large \
  --mode caplets-code-mode,executor-mcp,vanilla-mcp \
  --runs 1 \
  --timeout-ms 600000 \
  --concurrency 1 \
  --output-dir "$output_dir" \
  --executor-command "$executor_wrapper" \
  --model openai-codex/gpt-5.6-sol:high \
  --judge-model openai-codex/gpt-5.6-sol:low

reports=("$output_dir"/*.json)
report_path="${reports[${#reports[@]}-1]}"
REPORT_PATH="$report_path" node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";

const report = JSON.parse(await readFile(process.env.REPORT_PATH, "utf8"));
const requiredModes = ["caplets-code-mode", "executor-mcp", "vanilla-mcp"];
const rows = new Map(report.summary.byMode.map((row) => [row.mode, row]));

for (const mode of requiredModes) {
  const row = rows.get(mode);
  if (!row || row.total !== 5 || row.passRate !== 1) {
    throw new Error(`${mode} must pass all five tasks`);
  }
}

const caplets = rows.get("caplets-code-mode");
const executor = rows.get("executor-mcp");
const vanilla = rows.get("vanilla-mcp");
const totalTokens = caplets.averageRequestPlusOutputEstimatedTokens;
const executorTokens = executor.averageRequestPlusOutputEstimatedTokens;
const vanillaTokens = vanilla.averageRequestPlusOutputEstimatedTokens;

console.log(`METRIC total_tokens=${totalTokens}`);
console.log(`METRIC success_rate=${caplets.passRate}`);
console.log(`METRIC executor_total_tokens=${executorTokens}`);
console.log(`METRIC vanilla_total_tokens=${vanillaTokens}`);
console.log(`METRIC executor_ratio=${totalTokens / executorTokens}`);
console.log(`METRIC vanilla_ratio=${totalTokens / vanillaTokens}`);
console.log(`METRIC average_tool_calls=${caplets.averageToolCalls}`);
console.log(`ASI report=${process.env.REPORT_PATH}`);

if (totalTokens >= executorTokens || totalTokens >= vanillaTokens) {
  throw new Error(
    `caplets-code-mode (${totalTokens}) must beat executor-mcp (${executorTokens}) and vanilla-mcp (${vanillaTokens})`,
  );
}
NODE
