---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-jcode": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/pi": minor
"@cotal-ai/manager": minor
---

A connector's local control endpoint no longer trusts whoever holds its name. A hook used to send the endpoint key in its first frame and print whatever came back, so another local user who took the socket or pipe name after the connector's server exited received the key and could answer the hook. Each connection now runs the control exchange: the client and the server each prove with HMAC-SHA256 over fresh nonces that they hold the key, the reply carries a MAC, and neither side sends the key. The lifecycle hooks, the Manager's cooperative stop and session calls, and the Hermes Python hooks all move to it. The Hermes bridge adapter now presents a token derived from the key (HMAC-SHA256 over `cotal-hermes-bridge/1`) in place of the key. A client waits at most 1 second for the server's proof, and a server drops a connection that proves nothing within 5 seconds.

The exchange has a version, `CONTROL_PROTOCOL_VERSION` (1), that travels with the key: `LaunchSpec.control` is now `{ path, token, version }`, the launch material carries `controlVersion` beside `controlToken`, and a hand-driven session sets `COTAL_CONTROL_VERSION=1` beside `COTAL_CONTROL_TOKEN`. A key without a version, a version a build does not speak, and a peer of another version are all refused, with no fallback. `materialEnv` takes `control` (the endpoint) in place of `controlToken`.

Off Windows the control socket now sits in `cotal-ctl-<uid>` under the temp directory, made with mode 0700 and checked for owner and mode by the launcher, by the server before it binds, and by every client before it connects. A directory that fails the check counts as no endpoint, so a hand-driven `COTAL_CONTROL_SOCKET` must point into a private directory. The Hermes bridge socket moves beside the control socket. `@cotal-ai/core` exports the exchange (`clientExchange`, `serverExchange`, `controlCall`, `checkControlSocketDir`, `ensureControlSocketDir`); `tokenMatches`, `AUTH_DEADLINE_MS` and `MAX_FRAME_BYTES` are no longer exported by `@cotal-ai/connector-core`.
