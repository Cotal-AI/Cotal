---
"@cotal-ai/web": patch
---

The dashboard's channel-delete route comment now names the cred it purges with: the `channel-purger` cred minted at startup, the connection creds on open and `--creds` meshes, or a per-delete `channel-purger` view in user mode. It used to name a `manager` cred that no longer exists. The observer's `tls` comment now states only why the client's own TLS requirement is the fence, without narrating the change that added it. No behavior changes.
