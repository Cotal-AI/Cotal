---
"@cotal-ai/connector-core": patch
"@cotal-ai/manager": patch
---

Document capability handles as a distinct cost of default environment inheritance, and make two env-boundary suites real gates.

The configuration guide told operators that `spawn.env` protects secrets living only in the environment, and reassured them that a shell reads `~/.ssh` either way. That understates what inheritance forwards. `SSH_AUTH_SOCK` names a live `ssh-agent` rather than holding a secret, so an inheriting child can ask that agent to sign for any key it holds, and it keeps that power when no private-key file exists on disk at all. The guide now names capability handles as their own class, states the `ssh-agent` case, and records that model-catalog discovery in the `codex` and `opencode` connectors runs the harness with the operator environment and does not consult `spawn.env`.

The environment-boundary suite asserted that an unenumerated `COTAL_*` sentinel was absent from a spawned child, but never set it in the parent, so the assertion could not fail. The sentinel is now injected, which makes the cell prove the reset is driven by the prefix rather than by the enumerated per-session list. `smoke:hermes-launch-env` and `smoke:env-isolate` are both added to the sharded CI suite list; the hermes suite carries the connector's inherit, reset and both-containment-mode coverage and was previously reachable only through a package-local command.
