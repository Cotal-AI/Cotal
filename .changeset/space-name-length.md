---
"@cotal-ai/cli": patch
---

`space create` refuses a space name longer than 64 characters with `USAGE_INVALID`, exit 1, before
anything is written. A longer name failed with a raw `ENAMETOOLONG`, exit 3, and left an empty
`.cotal`, or was prepared and then could not be started by `cotal up`.
