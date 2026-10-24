---
"@cotal-ai/cli": patch
---

`cotal join --creds` with a credential minted without `--provision` now says the space has no inbox for that credential's lifecycle, and that the owner mints it with `cotal auth mint <name> --provision`. It used to say to run `cotal up`, which cannot make that inbox.
