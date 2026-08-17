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
DMs and anycasts. Only the channel rows are gone, and the same default-deny that already governed
`allowPublish` now governs reads. An empty list and an omitted one mean the same thing for both.

With no concrete channel there is no default broadcast target, so a send with no explicit channel is
refused with a message saying so, rather than resolving to `general`. Leaving your last channel is
allowed and always was; the `cotal_leave` description said otherwise and now says what actually
happens, including that the default send channel is gone until you join one.

Migration: **list `general` explicitly if you want it.** The personas `cotal setup` seeds already do,
so a fresh install is unchanged; a hand-written persona that relied on the old default needs
`subscribe: [general]` added.
