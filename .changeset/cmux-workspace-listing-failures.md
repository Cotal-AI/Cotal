---
"@cotal-ai/cmux": patch
---

The cmux driver's `listWorkspaces` and `workspaceRefs`, and the cmux `TerminalLayout`'s `refs`, now throw when cmux cannot be queried, and the listing is bounded like the workspace exit probe. Before, an unreachable socket, a wrong `CMUX_BUNDLED_CLI_PATH` or a CLI that exited non-zero read as no tabs open, and a CLI that never answered blocked the caller.
