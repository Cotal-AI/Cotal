---
"@cotal-ai/runtime": patch
---

A committed migration now ends the pauses an orphaned step still holds before it files the record. A pending `sleep`, `wait`, `ask` or `waitUntil` that the new source no longer reaches keeps its pause armed until something claims it, and a `wait` also keeps its chat consumer. The row said nothing outlives the step, which was true of a settled step only. The commit claims each waiting pause and deletes a `wait`'s consumer, so the row is true of a pending orphan as well. A commit of such a report with no journal and no plane is refused, and nothing is written.
