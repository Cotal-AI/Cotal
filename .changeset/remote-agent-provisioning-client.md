---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

`cotal spawn` works against a mesh registered from a remote bundle. A user-mode
agent's credentials must be granted where the space's signer lives, so a laptop
spawn previously refused with a message about missing local material. A mesh may
now advertise an agent-provisioning endpoint in its discovery bundle
(`cotal up --agent-provisioning-url <https://…>`, carried as
`userAuth.endpoints.agentProvisioningUrl`); spawn POSTs the operator's login
bearer there, lands the returned material 0600, and runs the same bearer
preflight before launch. A remote mesh that advertises none now refuses by
naming that fact and the operator's remedy, instead of blaming absent local
state. The endpoint is https-only (it receives the login bearer) and redirects
are refused, matching the registration fetch discipline.

The login proof itself never crosses the CLI package: the provisioning POST is
a new optional `AuthProvider.postAgentProvisioning` seam on core's provider
interface, implemented by `@cotal-ai/auth` — the CLI keeps its no-auth-import
boundary.

Also fixes `finalizeUserBundleEndpoint`, which replaced the bundle's endpoints
object and would have dropped any sibling field the composer set.
