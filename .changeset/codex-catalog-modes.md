---
"@cotal-ai/connector-codex": minor
---

Codex agents can now launch on Codex's Fast tier with `cotal spawn --mode fast=true`, and `cotal models -H codex` shows Codex's default model, each model's default effort and description, and which models run Fast by default. The catalog is read from Codex's own `model/list` answer, so a launch is checked against the efforts and modes Codex lists for the logged-in account. The connector renders the `fast` toggle as Codex's `service_tier` (`priority` on, `default` off), and an `--opt service_tier=...` launch option takes precedence.
