---
"@cotal-ai/core": minor
---

A host can now add and retire a space account on a running broker without reloading it. `serverConfig` takes `accountResolver: { kind: "full", directory, limit, intervalMs }` to render nats-server's directory resolver, `pushAccountClaim` sends a signed account claim over a system-account connection and waits for every expected server to accept it, and `retireAccountClaim` re-signs an account so it serves nobody. The default stays the MEMORY resolver, and its rendered config is unchanged.
