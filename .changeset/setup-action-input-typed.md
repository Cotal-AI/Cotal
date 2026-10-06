---
"@cotal-ai/cli": patch
---

`cotal setup` now builds each connector setup step with the input that action's type declares, so the compiler checks which input reaches the `connector`, `skills` and `mcpServers` actions. The step builder used to pick the input by action name behind two casts, which let a swapped or missing input compile and reach the provider only when someone ran `cotal setup`.
