---
"@cotal-ai/auth": minor
"cotal-ai": minor
---

The public exchange face's /.well-known/cotal-mesh bundle is now actually consumable by
`cotal meshes add --from`: the trust pins ride a `userAuth` arm (provider "cotal", idp pins,
pinned exchange endpoint) exactly as `checkUserBundle` records them, instead of the flat
idp/endpoints shape the consumer refused. New `--advertised-server <url>` on `cotal up` /
`auth-service` (with `--exchange-public-port`) sets the broker address the bundle advertises —
what participants dial through the reverse proxy (e.g. wss://…/mesh-ws) — instead of the
loopback/LAN address the callout itself dials.
