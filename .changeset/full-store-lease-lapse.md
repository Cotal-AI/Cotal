---
"@cotal-ai/delivery": patch
"@cotal-ai/cli": patch
---

A delivery daemon whose lease lapsed on a store over its `--max-file-store` cap no longer says another daemon took its shard. It quotes the broker's refusal of the new lease and exits, as a daemon without its lease does. `cotal up` then names the full store and the line the daemon logged, with `history clear` or a larger cap as the way out, and `status` says the full store refuses the lease. An owned service that exits before readiness now has its error quote the last line it logged during that launch.
