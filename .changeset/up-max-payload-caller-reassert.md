---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up --max-payload <bytes>` sets the broker's own message size limit, a positive integer up to 67108864. `up` renders it as `max_payload: <bytes>` in the broker config and records it in `.cotal/broker-policy.json`, which `readBrokerPolicy` reads back, so a later `cotal up` on the root renders it again without the flag, after `cotal down` or a preserved resume included. A running broker refuses a different value, and `--open`, `-f` and `--restore` refuse the flag. Service endpoint caller grants need at least 2098176 bytes, so a smaller value beside `--service-endpoints` refuses before anything starts. `SERVICE_CALLER_PAYLOAD_FLOOR` and `SERVICE_CALLER_PAYLOAD_OVERHEAD` now come from `@cotal-ai/core`, so the flag's validation and the auth host's assertion read one number. Before, `serverConfig` took a `maxPayload` that no `up` ever passed and no record kept, so a limit written into `server.conf` by hand was lost the next time `up` wrote the file.

Caller issuance now survives a broker configuration reload. A reload keeps the same incarnation serving and moves VARZ `config_digest`, and issuance was bound to the digest the bootstrap observed, so every reload refused every later caller issuance until the auth plane was reopened. On a multi-tenant broker that is every tenant sign-up. The verifier now treats a moved digest as a trigger to re-measure: when the fresh observation proves the same broker incarnation and auth store, and proves the standalone topology, the payload floor, the control line, the system account and an uncapped auth stream again, it re-asserts the payload record under the held plane claim by CAS on the exact prior row and continues. A reload that breaks any of those still refuses, a `max_payload` below the floor included, a restart is a new incarnation and still refuses, and a withdrawn record is never overwritten.
