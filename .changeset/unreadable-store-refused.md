---
"@cotal-ai/cli": patch
---

`cotal up` on a stack whose broker store folder this account cannot open, such as one at mode 000, crashed with a raw Node EACCES stack trace and wrote nothing to stdout for `--json`, while `status` told the user to run `cotal up`. It now refuses `PERMISSION_DENIED` (exit 2), naming the folder and `chmod -R u+rwX`, which restores the read and search access that `chmod -R u+w` leaves out, and `status` names the same step.
