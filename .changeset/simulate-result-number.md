---
"@cotal-ai/lang": patch
---

When a simulation script's list of results for a step is too short, the L6001 failure now says which
result the step needs, counted from 1, as in "step /turn:build#1 needs result 2". It used to say
"this is occurrence 1" for the second occurrence.
