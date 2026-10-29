---
"@cotal-ai/delivery": patch
---

A delivery daemon stopped with SIGTERM or SIGINT while its lease claim was still in flight now gives the lease back before it exits. The broker writes the lease row before the daemon reads the answer, and a signal in that moment ended the process with no handler, so the row claimed the shard for the 30-second lease TTL and the next daemon was refused with "a live lease already exists". The daemon now holds such a signal until the claim answers, then stops and releases the row as it does for a signal later in start-up.
