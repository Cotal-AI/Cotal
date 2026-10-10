---
"@cotal-ai/workspace": patch
"@cotal-ai/web": patch
"@cotal-ai/cli": patch
---

The web dashboard's pidfile name is now one `WEB_PIDFILE` constant in `@cotal-ai/workspace`. The dashboard declares its record with it, and the `cotal status` `Web process` row, `cotal status --components`, the `cotal setup` card and the `cotal clean all` crash-residue sweep read it from there. They used to spell `web.pid` by hand, so renaming the dashboard's record would still typecheck while those readers reported a running dashboard as down or absent and `clean all` left its pidfile behind. The file is still `.cotal/web.pid`.
