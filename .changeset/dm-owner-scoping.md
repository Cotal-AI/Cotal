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
send at all" and is not the same value as omitting it. `@cotal-ai/auth` carries the field from a
stored actor row through the ACL resolver so a row written before this existed keeps the DM plane
it had.
