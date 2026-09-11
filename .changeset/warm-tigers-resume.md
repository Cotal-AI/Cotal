---
"cotal-ai": patch
---

Resume an interrupted built-in connector refresh automatically when the durable seed stamp proves
that the running CLI is advancing the store to a newer generation and no reconcile or seed child is
still live. The manager now reaches readiness after that safe upgrade repair, while same-generation
and unattributable interruption markers still fail closed and report the recorded package, phase,
store generation, running generation, and absence of a live writer.
