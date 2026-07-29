#!/usr/bin/env bash
set -euo pipefail

pnpm --filter @caplets/core build >/dev/null
pnpm --filter @caplets/benchmarks exec tsx run-token-efficiency.ts
