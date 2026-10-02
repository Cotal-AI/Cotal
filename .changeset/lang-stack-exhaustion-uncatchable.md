---
"@cotal-ai/lang": patch
---

A host stack overflow in a cotal-lang run is no longer catchable. A builtin that ran out of stack (for example `json.stringify` on an array nested a few thousand deep) used to raise a catchable L4016, so a program could branch on how much stack its host had, and a journal recorded on one host was refused with L5001 when resumed on a host with a larger stack. Both the tree-walker and the compiled engine now unwind the run through it, the same as the other faults a program cannot catch.
