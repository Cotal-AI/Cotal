---
"cotal-ai": patch
---

Desktop service installation and setup now allow up to 30 seconds to read the account's application PATH and report a timeout without blaming the login shell when that read takes too long. On Windows, non-timeout PATH read failures also point to retrying or running `cotal daemon install` rather than checking a login shell.
