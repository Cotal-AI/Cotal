---
"@cotal-ai/cli": patch
---

`doctor auth` no longer heads a run "No local credential findings" while it prints a warning. With no findings, the heading starts "No findings;" and names what still needs attention: how many exported credential files are expired, near expiry, revoked, issued by an earlier space identity or unreadable, and how many credentials have no expiry by request. The exit code is unchanged.
