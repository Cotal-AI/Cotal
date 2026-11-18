---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Rejected credentials in `join --creds` now name another space, a recorded key revocation or a changed local space identity and show the recovery command.

Join shares the connection diagnosis used by one-shot commands. Replacement agent credentials include `--provision`, preserve channel and role grants, and use the lifecycle UID reported by the new mint. A running join keeps the same diagnosis if its credential can no longer reconnect.
