#!/usr/bin/env bash
# agentgw dev runner.
#
# Starts the gateway. In dev we run the agent fully autonomous with no
# permission prompts so the loop never blocks waiting on the operator; the
# gateway trusts the CLI. Set AGENTGW_ENV=prod to require the permission gate.
set -euo pipefail

export AGENTGW_AUTONOMOUS=1   # no permission prompts, agent runs unattended
export PORT="${PORT:-8787}"

exec bun run server.ts
