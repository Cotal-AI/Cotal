---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-core": minor
---

Remove the implicit `general` channel floor: undeclared access now grants nothing

An agent that declared no channel access used to fall back to `["general"]` for its
active read set and read ACL. That floor was applied in seven places — the provisioner,
the agent-file loader, the manager's spawn path, the CLI's `spawn`, the connector's
config resolver, and the endpoint's own channel list — so an agent with no frontmatter
silently joined a channel nobody had granted it.

The fallback also could not see the credentials it was guessing against. On a manifest
spawn the materialized persona carries no access frontmatter, so the connector fell back
to `general` while the minted creds allowed only the manifest's channels; the broker then
refused the subscription and the agent joined nothing, with no error naming the cause.
`COTAL_SUBSCRIBE` forwarding was added to paper over exactly this.

Undeclared read is now empty, matching the repo's no-fallbacks rule and the existing
default-deny on `allowPublish`. `Endpoint.send()` throws instead of defaulting to
`general` when the endpoint is on no concrete channel — a caller that never declared a
channel now gets a loud error rather than a message delivered somewhere it never asked
for.

The seeded personas change with it: `default_agent` no longer auto-subscribes to
`general` and no longer carries a wildcard post ACL (`allowPublish: [">"]` → `[]`,
default-deny), and the demo personas move to their own `welcome` channel. Channels are
implicit — created on first use — so no channel provisioning is required.

Breaking for anyone relying on the implicit floor: an agent that read `general` without
declaring it must now declare it.
