---
"@cotal-ai/manager": patch
---

Move the manager's service-endpoint serve state (the serve handle, its connection, identity, grant and current credential) from the Manager into the serve plane that registers it, which boot, credential renewal, the goal writer, seat launch, seat stop, spawn-goal and retirement now read directly instead of through per-field accessors. Exports, commands and wire behaviour are unchanged.
