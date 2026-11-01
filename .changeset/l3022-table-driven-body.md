---
"@cotal-ai/lang": patch
---

L3022 now reads a scope's body from the scope table, as the captured-write check does, instead of naming `parallel`, `race` and `fanOut`. A new scope primitive is judged without being added to the check, and a single-body scope that runs its function once (`once`, `conclave`) is left alone.
