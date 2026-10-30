---
"@cotal-ai/cli": patch
---

Fail a channel or role completion when the target space's persona catalog folder cannot be read or a
persona file in it does not parse, as persona name completion already did, instead of offering
nothing as a success. `COTAL_COMPLETE_DEBUG=1` names the folder or file. The legacy `personas list`
refuses an unreadable catalog folder with `PERMISSION_DENIED`, as `persona` does, instead of
reporting no personas. A space that does not resolve, or a catalog folder that does not exist, still
offers or lists nothing.
