---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/cli": minor
"@cotal-ai/pi": minor
---

An agent now reads only the channels it lists. An omitted or empty read set means **no channels**,
where it previously meant `general`: the agent-file loader, the provisioner, the credential mint and
the endpoint each defaulted an absent read set to `["general"]`, so any persona that simply did not
mention channels was subscribed to `general` by code and had the matching channel read row baked
into its credential.

An agent on no channel is still a full mesh peer: it appears on the roster and sends and receives
DMs and anycasts, and the same default-deny that already governed `allowPublish` now governs reads.
An empty list and an omitted one mean the same thing, for both read keys. That has one consequence
worth stating plainly: when **both** are omitted, `allowSubscribe` falls back to the read set and so
resolves empty too, which leaves the agent unable to `cotal_join` a channel at runtime. Give it an
explicit `allowSubscribe` if it should be able to join one later.

With no concrete channel there is no default broadcast target, so a send with no explicit channel is
refused with a message saying so, rather than resolving to `general`. Leaving your last channel is
allowed and always was; the `cotal_leave` description said otherwise and now says what actually
happens, including that the default send channel is gone until you join one.

Migration: **list `general` explicitly if you want it.** A hand-written persona that relied on the
old default needs `subscribe: [general]` added.

This changes the default `cotal setup` install as well. The seeded `default_agent` carries
`subscribe: []`, which used to resolve to `general` and now resolves to no channel; it keeps
`allowSubscribe: [">"]`, so it can still `cotal_join` anything, it just no longer arrives on a
channel it never asked for — which is what its own seed comment already described.

Already-running agents are not narrowed retroactively: a live seat keeps the read ACL its credential
was minted with, across renewal, until it is respawned.
