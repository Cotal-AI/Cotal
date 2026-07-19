# @cotal-ai/connector-agy

Cotal connector for the Google Antigravity CLI (`agy`): spawns Antigravity as an
autonomous mesh worker.

A Node shim owns the mesh agent and drives `agy -p` one turn at a time under a
pseudo-TTY (agy drops its final response on a non-TTY stdout), resuming the same
conversation across turns via `--conversation <id>` captured from the agy log. The shim
serves the `cotal_*` tools over a local streamable-HTTP MCP endpoint, wired in through
the global `~/.gemini/config/mcp_config.json` for the lifetime of the worker and removed
on shutdown.

Works with the operator's own Google sign-in; models are whatever the local `agy`
account offers (e.g. Gemini 3.1 Pro at High reasoning).

```bash
cotal spawn worker --agent agy --detach
```

Notes

- One agy worker per machine: the connector merges a single `cotal` entry into the
  global agy MCP config and fails loudly if one already exists (a leftover entry from an
  unclean shutdown must be deleted before respawning).
- `--add-dir <workRoot>` is passed on every turn so files land in the work directory
  rather than agy's own workspace scratch.
- `COTAL_AGY_STATELESS=1` switches to a rolling-digest fallback (persona + recent
  transcript per turn) if conversation resume ever misbehaves.
