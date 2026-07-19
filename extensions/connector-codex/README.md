# @cotal-ai/connector-codex

Cotal connector for the OpenAI Codex CLI: spawns Codex as an autonomous mesh worker.

A thin Node shim owns the mesh agent and drives Codex headlessly, turn by turn:
`codex exec` starts a thread, and every later turn resumes it with
`codex exec resume <threadId>`, so the worker keeps its conversation state across
messages while the shim serves the `cotal_*` tools to Codex over MCP. Push delegation:
the mesh wakes the worker — the worker does not poll.

Works with whatever auth the local `codex` binary already has (ChatGPT subscription
login, or an API-key provider from `~/.codex/config.toml`), under the operator's own
account.

```bash
cotal spawn worker --agent codex --detach
```

Notes

- Codex MCP tool calls require `--dangerously-bypass-approvals-and-sandbox`; the shim
  passes it (the default approval policy auto-cancels mesh tool calls otherwise).
- `codex exec` reads stdin when it is an open pipe; the shim always closes it.
