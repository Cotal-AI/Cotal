---
"@cotal-ai/cli": patch
---

`backup create` with a process listening at the preserved cut's recorded address now refuses
`CONFLICT` and says to stop the process that listens there, then run the same `backup create`
again, as `backup restore` and a resuming `up` do. It used to refuse `LIFECYCLE_BLOCKED` saying it
did not establish an eligible stopped preserved cut, with the cause only in its native detail.
