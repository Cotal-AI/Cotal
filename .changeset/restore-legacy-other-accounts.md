---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A restore made by an earlier release no longer has its cleanup delete another account's data without
consent. Such a restore recorded no other accounts, so its cleanup named none and deleted the store it
set aside, an open mesh's account included, with no `--discard-history`. `status`, the
`backup cleanup-fallback` preview and the cleanup now read that store while it is still the recorded
one and name the accounts the restore's auth mode rules out: every account but `$G` after an open
restore, and `$G` after a static or user one. The preview warns with `HISTORY_ONLY_IN_PREVIOUS_STORE`,
and `backup cleanup-fallback` and `clean restore-fallback` refuse and delete nothing unless
`--discard-history` is given. Which data account a static or user restore brought back is not
recorded, so another data account in that store is still not named.
