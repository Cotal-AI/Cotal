---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

`cotal join --creds` now explains when a rejected credential belongs to another space, was revoked, or predates a local space reset. It shares the diagnosis used by one-shot commands and gives a replacement agent mint with `--provision`, the target space, and guidance to use the new lifecycle UID.
