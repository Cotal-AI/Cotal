---
"@cotal-ai/runtime": patch
---

A `wait`'s outer timeout token and a `waitUntil` observation's pause token are now each derived in one named function, which both the arm site and the pause-ownership table call. Before, the purpose strings were spelled by hand at every arm site and again in the ownership table, so renaming one side still typechecked and the run authority then refused the pause at run time with L4000. Behavior is unchanged.
