---
"@cotal-ai/connector-claude-code": minor
---

Claude Code agents can now be launched at a chosen effort level, and the Claude model list tells its aliases apart. `--variant <level>` renders Claude's `--effort` flag, an unknown level is refused before launch, and `cotal models --harness claude` lists each model's effort levels as variants and names an alias with the model it resolves to, such as `Opus 5.5 (claude-opus-5-5)`.
