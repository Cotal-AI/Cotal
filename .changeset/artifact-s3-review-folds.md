---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
---

Scope the artifact fetch gate, collapse the attach refusals to the one the caller is entitled to,
and verify the artifact index buckets instead of only creating them.

The fetch gate no longer branches on a global blob probe. `FetchGateDeps.blobExists` is
still there but is now reachable only after a new scope-local `scopeRecord(digest, scope)`
says the digest is in scope, so `unknown digest` and `not yet attached` can no longer be
told apart on whether bytes exist somewhere in the space. `unknown digest` becomes the
collapsed, scope-scoped name and `expired` — previously declared and returned by no path —
becomes reachable from scope-local terminal state.

`confirmAttach` now returns a single refusal for every state a caller can reach. `ATTACH_REFUSAL`
loses `entryNotFound`, `channelMismatch`, `noArtifactPart` and `digestMismatch`. A separate "no such
stream entry" let any control-rail principal probe the chat stream's head position with no read
access to any channel; the other three were licensed by an entitlement that does not exist. The
check said to establish it compares an alias parsed out of a chat subject, and a chat subject
carries no lifecycle — so an agent that respawns under the same alias passes it and could read a
retired predecessor's channel, whether its entry carried an artifact, and whether a suspected digest
matched. Reordering the checks does not repair this: possession is content-addressed and global, so
a successor may hold the very digest its predecessor published and still be told its channel.
The accepted cost is that a legitimate caller now receives the collapsed refusal for all of these.

`confirmAttach` also matches any artifact part carrying the confirmed digest rather than the first
artifact part in the message, so a message carrying two artifacts can confirm both.

`ensureArtifactIndexStores` is called by both space setup and restore so the two lists cannot
diverge — restore previously recreated four of the five and threw at its own assertion — and it now
verifies an existing bucket rather than adopting whatever it finds. A bucket carrying a TTL silently
reaps the possession rows this index exists to outlive, so setup refuses to adopt one and names the
drift. New: `putAttachmentIfAbsent`, which makes attach lifetime-neutral in code rather than in a
comment, so a repeat confirm cannot refresh the timestamp retention is aged from.

BREAKING for anyone constructing `FetchGateDeps` by hand, matching on the four removed
`ATTACH_REFUSAL` members, or running an artifact index bucket whose config has drifted.
