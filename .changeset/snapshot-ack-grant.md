---
"@cotal-ai/core": patch
---

The `backup` snapshot credential and the `issued-store-recreate` credential that `cotal up --recreate-issued-stores` mints now ACK snapshot chunks through one publish grant per stream they snapshot, `$JS.SNAPSHOT.ACK.<stream>.>`, and no longer hold a response permission. In 0.113.0 and earlier, that permission let the holder answer any reply subject a message to its inbox carried, so a message whose reply was another stream's `$JS.API.STREAM.DELETE` would have deleted that stream through a credential that cannot delete it directly. `cotal backup`, the sanitizing re-snapshot behind `up --restore` and `--recreate-issued-stores` work as before.

`--recreate-issued-stores` also reads both selected stores again just before it deletes them, and refuses with nothing deleted when either changed after its backup. It now fsyncs the backup directory's parent as well.
