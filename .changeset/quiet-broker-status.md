---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Report a broker that accepts connections without answering consistently, and avoid repeating its connection timeout in status.

Status shares one selected-space preflight between its connection, registry and delivery checks. Space listings and details preserve `slow-link` in JSON and show `not answering`, while refused connections remain `unreachable` and registrations are kept. TLS-required probes release pending sockets on timeout so read commands exit without weakening TLS intent. WebSocket probes also enforce their deadline when an upgraded peer never replies to the close handshake.
