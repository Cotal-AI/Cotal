---
"cotal-ai": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

Add `cotal space` and `cotal space show [<name>]`, and put `cotal use` on the structured output contract. `space` lists the registered spaces with each broker's state, server, mode, origin and root, and never dials a discovered space; `space show` gives one in full, the selected one by default, without its credential paths. Both take `--json` and `--plain`, and their rows match `cotal status --json`.

- `cotal use <space>` selects any registered space without checking its broker, refuses a name that is not registered with `TARGET_NOT_FOUND` (exit 2), reports a repeat as a `no-op`, and bare `cotal use` reports the selection. A selection that names no registration is reported with a `SELECTION_NOT_REGISTERED` warning.
- A command run without `--space` targets the selection: when its broker is down it refuses with `TARGET_UNAVAILABLE`, and a selection that names a space no longer registered refuses with `TARGET_NOT_FOUND`. Neither falls back to another mesh.
- `@cotal-ai/workspace` exports `brokerAnswers`, and a `MeshTargetError` for a dangling selection carries `selected: true`.
