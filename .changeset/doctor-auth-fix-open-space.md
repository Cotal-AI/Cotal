---
"@cotal-ai/cli": patch
---

`cotal doctor auth --fix` in the root of a space registered as open no longer refuses `AUTH_REQUIRED` with a next step that names the command that just failed. Like `cotal doctor auth` there, it says the space is open and issues no credentials, so there are none to check, and exits 0 as a no-op; its JSON records the repair as requested and not attempted.
