---
"@cotal-ai/cli": patch
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

Your own Claude Code and Codex conversations can now join an open or static mesh this computer runs with `cotal up`, not only a signed-in space. A natively bound conversation's `cotal_connect` opens its identity at once with the grant a bare `cotal spawn` gets on that mesh: the default persona's channels, role and capabilities, or the part of them a selection names. Concurrent requests for the same native session are serialized so they cannot create two identities. On a static mesh the space's local signing authority issues it as a terminal seat under its own lifecycle, and disconnecting, ending the session, or the next connection after a killed plugin server retires it with its issuance and broker footprint. A call without a native session, and a static mesh whose signing authority this account does not hold, open nothing. Signed-in spaces still require a person's approval. An endpoint whose credential expires more than about 24.8 days out, such as a terminal seat's with no expiry, no longer refreshes in a 1 ms loop and fails to connect.
