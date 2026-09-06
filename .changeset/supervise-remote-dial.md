---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
"@cotal-ai/runtime": patch
---

`cotal supervise` on a registered remote mesh now dials the broker URL the registry actually
holds. A remote broker is commonly published over a `wss://` edge, and the manager-authority
registration the supervisor runs first handed that URL to the raw node transport, which refuses a
websocket URL outright, so supervision stopped before a manager was ever constructed. That
registration and every other control dial this audit found can be handed a registry server URL now
select the transport from the scheme, including the planes `cotal run --local` opens, which failed
on such a mesh for the same reason. The registration also carries the record's TLS requirement
instead of assuming a plaintext broker, so a participant no longer downgrades its prepare
credential exchange on a mesh the registry describes as TLS-required. On the same path, the cluster
artifacts the registration reads back are now looked up by the key form the content-addressed store
uses, which a remote registration reached with a prefixed digest reference and could not resolve.
