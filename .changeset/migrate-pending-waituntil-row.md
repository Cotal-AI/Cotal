---
"@cotal-ai/runtime": patch
---

`cotal run migrate` no longer says a pending orphaned `waitUntil`'s cadence timer "is released with the run's other timers". Nothing releases that pause, so the row now says only that the edit stops the wait and its recorded observations stay in the journal, as the §11.2 orphan table does. A single observation now reads "1 recorded observation stays".
