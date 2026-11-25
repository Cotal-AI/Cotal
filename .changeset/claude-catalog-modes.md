---
"@cotal-ai/connector-claude-code": minor
---

Claude Code agents can now be launched with fast mode or ultracode, and the Claude model list names each model's default effort and the model Claude runs by default. `cotal models --harness claude` reads them from one headless `claude` session: each model's `get_settings` answer gives its default effort and whether it can run ultracode, and `fast` is listed on models that support it only when the login's organization allows fast mode. `--mode fast=true` and `--mode ultracode=true` render one `--settings` flag beside `--effort`, a mode set to false is written as off, and a launch with a mode refuses `--opt settings=`, because Claude keeps only the last `--settings` flag. A launch with a variant and no `--model` is now checked against the default model and starts.
