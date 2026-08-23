---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/auth": minor
---

A remotely-registered user mesh now connects with stock cotal end to end, including over a websocket broker address.

`cotal meshes add <space> --from <url>` already landed a complete remote trust
position (IdP pins, public exchange URL, sentinel creds); the auth provider now
CONSUMES it at connect when no local user-auth material exists: login session →
fresh IdP JWT → the pinned exchange's capless public face → bearer + the
registration-landed sentinel. Nothing is discovered at connect time, the
transport rule (HTTPS, loopback-literal http only, names get no exception) is
checked before the IdP round trip, and every refusal names its exact remedy.

Brokers published through an HTTPS edge are dialable as `wss://host/path`:
core picks the websocket transport by scheme at every dial site (endpoint,
reachability, probe), `hostPort` defaults ws/wss to the web's ports, and
`join-target` classifies `wss://` as TLS-bearing (the handshake is the
transport's own) while `ws://` gets exactly the plaintext fences `nats://`
gets. The canonical server string keeps the URL path — behind an edge the
path is part of the broker's address.
