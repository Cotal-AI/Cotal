---
"@cotal-ai/auth": patch
---

`cotal actor list` and `cotal auth grants` now show each row's role, label and parent in their
tables, and `--json` carries the parent too, so a re-grant can spell the whole row again. The grant
receipt names the role, label and parent it stored. `cotal actor list`, `actor grant` and `actor
revoke` take `--json` and `--plain` as the `auth` forms do.
