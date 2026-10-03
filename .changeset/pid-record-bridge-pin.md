---
"@cotal-ai/workspace": patch
---

Close the pid record publish window. A launcher that died between removing the old identity pin and publishing the new pidfile left the old pid with no pin, which teardown signalled with only a legacy warning, even when the removed pin had been refusing a reused pid. The publish now renames a bridge pin holding the old and the new record's lines before the pidfile commit, and teardown checks the pidfile's pid against its own line, so every crash point leaves the old or the new complete record.
