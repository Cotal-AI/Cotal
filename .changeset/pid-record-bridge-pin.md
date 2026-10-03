---
"@cotal-ai/workspace": patch
---

Close the pid record publish window. A launcher that died between removing the old identity pin and publishing the new pidfile left the old pid with no pin, which teardown signalled with only a legacy warning, even when the removed pin had been refusing a reused pid. The publish now renames a bridge pin holding the old and the new record's lines before the pidfile commit, and teardown checks the pidfile's pid against its own line, so every crash point leaves the old or the new complete record. Publishes of one pidfile are serialized by a lock, so a launcher and the daemon it starts can no longer overwrite each other's bridge or settled pin. A publish that cannot read a start token for the new process gives it a `-` pin line, so a crash after the commit reads the legacy record it was publishing, never the new pid beside the old pin.
