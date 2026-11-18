---
"@cotal-ai/cli": patch
---

A mistyped `--on` on `stop`, `attach`, `status`, `input`, `endpoint describe`, `endpoint invoke`, `spawn`, `ps` and `models` now names a command to rerun that keeps the agent, endpoint, command, text, persona, `-d` and `--harness` it was given, quoted for a shell, and its `--space` and `--server`. Several of those refusals kept only the verb, such as `cotal describe --on <instance>`, and `input` printed a `<text>` that a shell reads as a redirection.
