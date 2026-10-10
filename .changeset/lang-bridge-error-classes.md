---
"@cotal-ai/lang": patch
---

A failure a bridged host handler throws now crosses into the engine thread as the class it was raised as, with that class's own fields, and is rebuilt with nothing defaulted. Before, an `EffectError` missing its `code` or `kind` was journaled as `L4000` / `handler-fault`, and an `EffectRefused` missing its `code` as `L5016`, while the in-process walker recorded the same failure with those fields absent. A bridged failure now journals the same as an in-process one.
