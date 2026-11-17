---
"@cotal-ai/cli": patch
---

Name the space's folder when `cotal mcp` finds the local space stopped.

The refusal said to start the space with `cotal up`, which starts a new space named after the current folder unless it is run in the space's own folder. It now names the command that starts this space from anywhere, `cotal up --root <the space's folder>`.
