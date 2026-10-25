---
"@cotal-ai/cli": patch
---

`service logs --follow` on a log this account cannot read now ends with a `PERMISSION_DENIED` error
record that names the log, the cause and a `chmod u+rw` step, and exits 2. It used to end
`OPERATION_FAILED` with exit 5 and no path, cause or step.
