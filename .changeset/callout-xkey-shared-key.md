---
"@cotal-ai/auth": patch
---

The auth callout derives its xkey shared key with a nats-server once per server key, instead of twice on every connect (once to open the request and once to seal the response). That X25519 step was most of the callout's crypto CPU. The sealed bytes are unchanged, and every request still passes every check: the mandatory xkey, the dropped unsealed request, and the signed `server_id.xkey` matching the sealing header. Each callout keeps at most 64 server keys and drops the least recently used. A key is kept only for a request that passed every check, so a forged `Nats-Server-Xkey` header never grows it. `@cotal-ai/auth` now depends on `tweetnacl` directly, the same version `@nats-io/nkeys` already installs.
