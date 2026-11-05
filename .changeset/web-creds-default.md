---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/web": minor
---

`cotal up` mints a read-only dashboard credential for a static space, its `web.creds`, and the `web` service preset uses it as the `--creds` default, so `cotal service start web` starts with no flags. `doctor auth` reports the file, and `clean` and a space reset remove it.
