---
"cotal-ai": patch
"@cotal-ai/runtime": patch
---

The full `cotal run` list answers from a manager that reaches its broker over a slow link. Before, the manager read every run's record, revocation marker and program one broker round trip at a time. With about 90 runs and 60 ms round trips, that ran past the 25 s budget, and the list failed with `deadline-exceeded`. Rows are now read eight at a time, and each run's marker and program are read together. The same list answers in about 9 s and carries the same rows.
