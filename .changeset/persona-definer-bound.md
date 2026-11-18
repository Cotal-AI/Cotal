---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": patch
---

A persona saved over the wire now keeps no launch options and grants only channels its definer holds.

`define-persona` drops `launchOptions` from a frontmatter block in the prompt, and a redefine writes the file without the saved ones. Launch options in a persona now come only from agent files the operator writes on the manager host, and a spawner still passes its own with the spawn. The persona's read ACL and `allowPublish` are checked against the definer before the write, as capabilities and endpoint commands already were: against its issued credential on a static mesh, and its ledger row on a per-user auth mesh, where a row holding `admin` is exempt. A definition that asks for a channel the definer does not hold is refused with `permission-denied` and names the channel. A manager whose user authority is hosted refuses any channel in a definition. An operator's control instrument is not checked. Each spawn of the persona is still checked against its spawner. The auth provider contract adds `actorGrant`, a fresh read of a principal's scope and channel lists.
