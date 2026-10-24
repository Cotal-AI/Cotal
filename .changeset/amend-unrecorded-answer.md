---
"@cotal-ai/lang": patch
"@cotal-ai/runtime": patch
"@cotal-ai/connector-core": patch
---

`cotal run amend` sent right after an accepted answer, before the run has recorded it, now says the answer was accepted and is not recorded yet, and to amend once the step lists it. Before, it said the step was "still open, so answer it instead", which sent the caller to a pause that had already taken their answer.
