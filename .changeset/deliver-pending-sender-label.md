---
"@cotal-ai/delivery": patch
---

`cotal deliver pending` now names each held message's sender as `from=<label>  principal=<owner>.<actor>`. It printed `from=[object Object]` before. The principal is read from the message subject, which the broker pins to the sender's credential.
