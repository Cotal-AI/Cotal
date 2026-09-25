---
"@cotal-ai/cli": minor
---

`cotal mint` can bound a credential's lifetime and re-mint for an existing identity. `--expires-in <seconds>` (or `--expires-at <unix-seconds>`) threads the lifetime the core mint seam already takes, so an out-of-band credential can satisfy a standing-renewal consumer that requires an `exp`; the two flags are mutually exclusive and an invalid value is refused before anything is written. `--identity <creds>` re-mints for the nkey the file carries (read by core's own creds loader), keeping the principal so every durable keyed to it survives. Fixes #1256
