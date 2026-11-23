---
"@cotal-ai/manager": patch
---

Remove nine private Manager forwarders that only the Manager itself called (boot's start and execution-record claim, the stop path's goal-writer, session-plane, chat-session and reconcile-drain steps, the release of managed agents and a stopped seat's goal cancel), so the Manager calls the owning part directly. Exports, commands and wire behaviour are unchanged.
