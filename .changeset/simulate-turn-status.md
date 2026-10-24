---
"@cotal-ai/runtime": patch
---

`cotal run simulate --handler` now refuses a scripted turn result whose `status` is not `done`,
`blocked` or `handoff`, or that scripts `at`, an unknown field or a `note` that is not a string, with
`SCHEMA_INVALID`, as it refuses a malformed checkpoint result. It used to hand that result to the
program, which then ran on a status no live turn returns.
