---
"@cotal-ai/connector-claude-code": patch
---

A Claude Code seat whose run turn passed a permission or input prompt now yields `done` when the turn ends. The plugin registers `PostToolBatch`, and when the batch resolves while the seat reads `waiting`, the connector sets it back to `working` and clears the condition. Before this the turn ended `waiting` to `idle`, which is not a turn boundary, so the run step stayed pending until the seat was reaped and presence kept the `approval` condition while idle.
