---
"cotal-ai": patch
---

Desktop service installation and setup now allow up to 30 seconds to read the account's application PATH and report when that read timed out. On Windows, timed-out PATH reads advise waiting a moment and choosing Try again, and non-timeout PATH read failures point to retrying or running `cotal daemon install` rather than checking a login shell.
