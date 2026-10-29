---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A restore no longer leaves another account's data in the store it sets aside without saying so. When
open and static meshes ran in one folder, their store holds both accounts, and a backup holds one, so
a restore leaves the other account's streams only in the store it moves aside. The restore now
journals those accounts. Its receipt names that store in `previousStore` and warns with
`OTHER_ACCOUNTS_NOT_RESTORED`, or names the accounts in `otherAccounts` on the left-out warning it
already gives. `status` and every next step that names the cleanup include `--discard-history`. The
`backup cleanup-fallback` preview warns with `HISTORY_ONLY_IN_PREVIOUS_STORE` and names the accounts,
and `backup cleanup-fallback` and `clean restore-fallback` refuse and delete nothing unless
`--discard-history` is given. A restore made by an earlier release recorded no other accounts, so its
cleanup does not name them.
