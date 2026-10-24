---
"@cotal-ai/workspace": patch
---

`cotal doctor auth` no longer refuses the whole diagnosis with "the saved local record is not owned and private", naming no file, when one of the space's own store credentials, such as `membership-observer.creds`, is readable by other accounts. That file is a finding like any other credential file: it names the mode and gives `chmod 600 <file>` as the repair, and every other file is still checked.
