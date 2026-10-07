---
"@cotal-ai/workspace": minor
"@cotal-ai/manager": minor
---

The persisted identity records now share one reader and one first mint. The manager instance identity, the manager sibling identities, the auth plane instance identity and a participant manager's remote authority state each read through the same regular-file and nkey checks and publish a first mint by exclusive create through the new `claimIdentityRecord` and `identityOf`, adopting the winner when a concurrent start created the record first. Before, the manager start and the auth plane followed a symlinked record that retirement refused, and a participant manager published its first mint with a last-writer-wins rename, so concurrent first starts on one root each kept a different identity, and it accepted an empty nkey id or seed that the local loaders refused. A lost race now refuses with `identity-record-create-lost`. `saveManagerInstanceIdentity` and `saveAuthInstanceIdentity` are removed: nothing shipped overwrote a stored identity, and the exports let any caller bypass the exclusive create.
