---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

On a user-auth mesh, `cotal send`, `cotal endpoints`, `cotal personas list --running` and `cotal channels list` read the roster and the channel registry once on the user's bearer and leave no watch or scan consumer behind, as they already did on a static or open mesh. The agent profile, which the auth service mints for a user's connection, gains the batched Direct Get of the channel registry (it already carried the presence one), so an agent credential from `cotal auth mint` passed with `--creds` reads once too. A user connection an older auth service minted without that row is refused with `PERMISSION_DENIED` naming the update, never watched instead.
