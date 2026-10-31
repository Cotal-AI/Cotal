---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

`clearChannel` no longer reports success when its channel-registry step is refused or fails. Only a missing registry bucket is still a no-op. Any other failure throws `ChannelRegistryRemovalFailed`, which carries the purge count, because the chat purge has already happened. Before, a credential that could purge history but not touch the registry (for example `purger`) resolved with `removed: false` while the channel stayed listed. The web dashboard and console now show that error instead of a successful delete. `cotal channel remove --purge` still reports the partial outcome with the purge count.
