---
"@cotal-ai/core": patch
---

Reachability probes give websocket brokers a transport-sized budget. The 1s
default was tuned for the loopback/LAN TCP brokers local probes dial; a ws(s)
broker is by definition published through an HTTPS edge, where TLS + upgrade +
INFO + the auth round-trip routinely exceeds 1s cold — measured as a majority
of spawns against a Cloudflare-fronted mesh refusing with "not reachable" while
the broker was up. `isReachable` and `probeConnect` now default to 5s when the
server list dials over ws/wss; explicit `timeoutMs` callers are untouched.
