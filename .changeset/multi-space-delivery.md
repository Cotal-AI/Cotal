---
"@cotal-ai/delivery": minor
"@cotal-ai/workspace": minor
"@cotal-ai/auth": patch
---

Serve several spaces from one delivery process. `cotal deliver --spaces <manifest> --server <url>` holds one delivery lane per space the manifest names, so a host runs one delivery process instead of one per space. A lane is the daemon `deliver --space` runs, held by the host: it reads its own space's credential from the root, dials on its own connections into that space's account, and holds its own lease, broker watchdog, timer writer and membership feed. One space losing the broker, its credential or its lease closes that lane alone, and the host reopens it every 5 seconds while it fails. A lane writes no pidfile, and its lines carry a `[<space>]` prefix.

The host serves every space in the manifest or none, and names the space it could not serve. It rereads the manifest when it changes on disk, on `SIGHUP`, and on a backstop interval, opening or closing the difference; a manifest that does not read or parse whole is reported and the open lanes are kept. `--space` and `--spaces` are alternatives, `--spaces` requires `--server`, and `--creds`, `--dev-mint`, `--shard`, `--shards` and `deliver pending` refuse with it. `deliver --space` is unchanged. The `deliver` deprecation warning now says to keep `cotal deliver` for `--spaces`, which the `delivery` service preset has no form for.

The manifest grammar and the reconcile loop move to `@cotal-ai/workspace` as `parseSpaceManifest` and `runSpaceHost`, and the auth callout host runs on them. Its behavior and lines are unchanged, except that a signalled callout host now closes its lanes at once rather than one after another, and closes the lanes it opened before refusing on a manifest directory it cannot watch.
