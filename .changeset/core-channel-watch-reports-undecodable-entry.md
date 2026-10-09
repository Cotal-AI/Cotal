---
"@cotal-ai/core": patch
---

An endpoint watching the channel registry now reports a registry entry it cannot decode as a `warning` that names the key and the decode error, and drops that entry from its cache. It used to keep the config it held before and report nothing, so `channelDeliveryClass`, the join backstop request and the leave tombstone acted on a delivery class the registry no longer held, while a fresh registry read already resolved the same entry to the default. A per-channel entry that does not decode now resolves to the space default, and a `=defaults` entry that does not decode leaves the built-in defaults in force, until a valid entry is written.
