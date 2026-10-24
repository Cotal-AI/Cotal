---
"@cotal-ai/cli": patch
---

`backup create` now refuses a destination inside the preserved store with `USAGE_INVALID`, and one in
a folder this account cannot write with `PERMISSION_DENIED` naming that folder and `chmod u+w`,
both before it claims the cut. They were reported as an ineligible cut and as an `OPERATION_FAILED`
attempt, with the cause only in the native detail.
