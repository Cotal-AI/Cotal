---
"@cotal-ai/cli": patch
---

Bare `cotal down`, and Ctrl-C on a foreground `cotal up`, no longer print `left 0 managed agents running (no longer managed):` and the `cotal down --with-agents` hint when the manager had no managed agents. The spare report now prints only when the pre-stop inventory names at least one agent.
