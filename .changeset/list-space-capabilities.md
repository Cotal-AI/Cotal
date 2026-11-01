---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/registry": minor
---

Agents can list what a space offers them. The new `cotal_endpoints` tool asks the space's registry,
a registered endpoint named `registry`, which endpoints the agent can call. The answer lists each
registered endpoint where the agent holds at least one command, with the commands and request forms
its recorded grants cover, and leaves out every other endpoint. On an open mesh it lists every
registered endpoint. The registry reads the grants recorded when the credential was issued, so the
broker or the endpoint can still refuse a listed command, and the answer says so. On a user-auth
mesh, `view: "manager"` lists what the agent's manager-call credential can call, asked over that
credential. A listing drops the agent's cached `describe` of each endpoint it lists.

To ask, a credential on the legacy rail now carries a listing generation: one `ep.v1` request row
that reaches only the registry's `endpoints` command, its reply row, and the read of its own
accepted row. The auth callout issues one for an agent connection and an unissued `manager-caller`
view. An agent a manager spawns on a static mesh, and an interactive `manager-caller` view, carry
the row on their own issued generation from their first issuance. A credential issued before this
release has no listing rows, and the tool says so until the agent connects again or is respawned.
An issued `manager-caller` view that reconnects under the same nonce keeps the ceiling it was issued
with.
The new `@cotal-ai/registry` package holds the registry's answer and reads.
