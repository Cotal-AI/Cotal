---
"@cotal-ai/lang": patch
---

A workflow can no longer reach host state through a name the method tables inherit. `[].constructor()`, `"a".constructor()` and `(5).constructor()` returned the interpreter's own execution frame, which a program could read and use to rewrite its clock. Both engines now refuse any member outside the array, string and number method tables with L4014, as spec §4.2 says. The simulator also reads only a script's own entries, so a checkpoint named `constructor` with an empty `checkpoints` table is L6001 instead of a resolved answer.
