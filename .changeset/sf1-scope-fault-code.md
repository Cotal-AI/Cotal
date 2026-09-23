---
"@cotal-ai/lang": patch
---

A scope's failure record keeps a catalog code the language itself raised. A `RuntimeFault` thrown inside `parallel`, `race`, `fanOut` or `conclave` used to settle the scope's entry as the generic `L4000` `scope-fault` with its own sentence still inside the message, so the record disagreed with the rethrow: the program caught its own `L3021` (a `fanOut` with no stable key) live while every resume replayed `L4000` off the entry. The settle ladder now records a `RuntimeFault` under its own code with kind `runtime`, the kind both engines' catch binding already gives this class. A plain non-`EffectError` throw inside a scope still records `L4000` `scope-fault`, a handler's `EffectError` still keeps its code and kind, and the raw rethrow is unchanged. Refs #1519.
