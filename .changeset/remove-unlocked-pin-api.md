---
"@cotal-ai/workspace": minor
---

Remove the deprecated `removeIdentityPin` export. This is a breaking API change: consumers must use `removePidPair(pidfilePath, recorded)` after proving the recorded process is gone, passing the original trimmed record rather than a fresh read. The supported helper locks the record and preserves a different successor record. See `docs/UPGRADING.md` for migration guidance; no on-disk state migration is needed.
