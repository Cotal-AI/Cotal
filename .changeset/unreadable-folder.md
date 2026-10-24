---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal status` in a folder this account cannot read now says so, naming the folder and `chmod u+rx` on it, instead of reporting an unreadable `auth.json` that does not exist. A local record that cannot be opened for lack of permission names the folder that withholds it, so `cotal down --dry-run` there no longer says the record "could not be opened without following links".
