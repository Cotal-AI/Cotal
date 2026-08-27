---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

An agent's DM send ACL can now be narrowed to named recipient owners. The agent mint hardcoded
`inst.*.*.<owner>.<actor>`, so every agent on a space could DM every other agent and a multi-tenant
deployment could not confine one tenant's agents to its own people. `allowDmOwners` emits one grant
per permitted recipient owner instead; the recipient actor slot stays a wildcard and the sender
slots stay forge-locked, so nothing about identity changes.

The default is unchanged behaviour, deliberately: omitting the option means `["*"]`, byte-identical
to the previous grant, so upgrading narrows nobody. An explicitly empty list is honoured as "no DM
send at all" and is not the same value as omitting it.

Settable by supported means, not only by hand-editing ledger JSON: `AuthProvider.grantAgent`
declares it, the auth provider carries it onto the row, and `cotal actor grant --allow-dm-owners`
sets it (omitted = anyone, `''` = none). `cotal actor list` shows the resulting set.

It attenuates like every other grant. A child may never hold a wider DM list than its spawner, and
because an absent list means `["*"]`, a child that merely OMITS the field under a scoped parent is
refused rather than silently granted everything. An unscoped parent constrains nothing, so existing
spawns are unaffected. In `@cotal-ai/auth` the three access fields now travel as one carry, so DM
cannot be the field a new resolver forgets.

This narrows DM SEND and nothing else. Anycast and history-at-rest are untouched, so it is a useful
containment of one lane, not a general tenant boundary, and should not be described as one.
