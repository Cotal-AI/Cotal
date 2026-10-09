---
"@cotal-ai/workspace": patch
---

The pid contract smoke now writes its malformed auth-pidfile fixture at the path the auth stop reads, derived from the stop's own record descriptor. It used to read `PID_PATH`, which the CLI's auth module does not export, so every run fell back to a hand-spelled name, and moving the auth record would have failed the cell for the wrong reason.
