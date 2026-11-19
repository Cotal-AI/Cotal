---
"@cotal-ai/connector-claude-code": patch
"@cotal-ai/pi": patch
"@cotal-ai/connector-core": patch
---

Claude Code and Pi seats return to `idle` after their user interrupts a turn, and the run ends as an interrupt on the event plane. Claude Code fires no hook on an interrupt, so the connector now watches the open turn's transcript for the interrupt record Claude Code writes. That record sets presence to `idle`, clears any approval or input condition, and closes the run with `RUN_FINISHED` carrying an `interrupt` outcome. A Pi turn without a Cotal batch now publishes `idle` when it ends after an abort or an error. An aborted Pi turn, including one stopped during a tool call, ends with an `interrupt` outcome instead of `RUN_ERROR`.
