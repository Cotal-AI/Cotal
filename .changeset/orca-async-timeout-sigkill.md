---
"@cotal-ai/orca": patch
---

The Orca runtime's exit wait now settles within its bound when the Orca CLI survives SIGTERM. The async CLI calls behind `terminal wait`, `list` and `show` sent SIGTERM on timeout and then waited for the child to exit, so a child that ignored it held the wait open. Both the sync and async paths now share one set of exec options that kills a timed-out child with SIGKILL.
