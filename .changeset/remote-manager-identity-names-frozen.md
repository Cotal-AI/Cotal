---
"@cotal-ai/core": patch
---

`REMOTE_MANAGER_IDENTITY_NAMES` is now frozen at its declaration, like the other collections core exports. It was a plain array, so an importer could push, pop or reorder it and change the identity set that `parseRemoteManagerIdentities` requires and that the registration projection digests, and `pnpm smoke:frozen-exports` failed on it.
