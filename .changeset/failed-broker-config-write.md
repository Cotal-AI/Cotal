---
"@cotal-ai/cli": patch
---

A start that fails while writing the broker configuration now names that file, and status finishes it with the same up the failed start ran.

The write failure names `.cotal/auth/server.conf` or `.cotal/auth/server-open.conf` and starts no member. Status adds `--no-manager` only when that start passed it.
