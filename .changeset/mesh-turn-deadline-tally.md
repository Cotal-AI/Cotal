---
"@cotal-ai/runtime": patch
---

The mesh-turn smoke counts a step that misses its deadline as one failure. Its deadline helper counted a failure of its own before the check reading the result failed on the same missing value, so one stuck step showed as two failures and a run that executed every cell reported itself incomplete at 50 of 49 cells. The helper now only reports the timeout. The five turns block 12 awaited without reading now feed that block's two checks, so a turn there that never ends still fails the run. No behavior changes.
