---
"@cotal-ai/cli": patch
---

`cotal status <agent>` now names the agent in the `attach` and `stop` it suggests, with the `--space` and `--server` it was given. It printed a literal `<agent>`, which a shell reads as an input redirection.
