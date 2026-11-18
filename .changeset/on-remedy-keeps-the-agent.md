---
"@cotal-ai/cli": patch
---

A mistyped `--on` for `cotal stop`, `attach`, `input` or `status` now suggests a command that works. The remedy kept only the verb, such as `cotal stop --on <instance>`, which is refused for naming no agent. It now repeats the agent, the other arguments and any `--space` or `--server`, for example `cotal stop default_agent --on <instance>`.
