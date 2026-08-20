---
"@cotal-ai/connector-core": minor
---

The advertised tool surface and the orientation card now gate on **authenticated**, not on "has static creds", so a user-auth agent is no longer told it can spawn.

`cotal_spawn` and `cotal_persona` ride the `spawn` capability, and the gate read `!config.creds` as
"open mode". That was true while there were two identity states. There is now a third — user-mode
auth — and it carries no static creds by construction: the pair is refused at parse, at launch, and
at connect, one launch carrying one identity plane. So `!config.creds` was always true on a user-auth
agent, and every agent on a user-auth mesh was advertised both manager-op tools whatever its
capabilities. The wire still refused the call, so nothing could be done with them; what broke is the
guarantee the gate exists to keep, that an agent sees these tools only when it can actually use them
rather than discovering the denial by trying.

The orientation card was wrong twice on such a mesh. It listed both tools, and its access line said
`open mode (grants advisory, host-trusted)` for a mesh whose grants are broker-enforced. The tool
list is corrected by the wire the moment an agent tries; a card that misstates the security posture
is corrected by nothing.

Both sites now call one exported predicate, `isAuthed(config)`, mirroring the endpoint's own
open-vs-auth gate, so a third identity plane is one expression to change rather than a search.
`token` / `user` / `pass` are deliberately excluded: shared-token auth carries no owner+actor grant
and no per-agent publish ACL, so the broker gates nothing per agent for it and hiding the tools there
would be the same untruth in the other direction.

Open mode is unchanged in both directions: no identity plane means everything stays visible, exactly
as before.

Migration: an agent on a user-auth mesh without the `spawn` capability no longer sees `cotal_spawn`
or `cotal_persona`, and its orientation card now reports auth mode. Granting the capability restores
both. Static-creds and open-mode agents are unaffected.
