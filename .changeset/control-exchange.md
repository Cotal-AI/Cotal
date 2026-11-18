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

A connector's local control endpoint no longer trusts whoever holds its name, and sessions launched before this release must be restarted. A hook used to send the endpoint key in its first frame and print whatever came back, so another local user who took the socket or pipe name after the connector's server exited received the key and could answer the hook. Each connection now runs the control exchange: the client and the server each prove with HMAC-SHA256 over fresh nonces that they hold the key, the reply carries a MAC, the hook's delivery receipt carries a MAC over that reply, and neither side sends the key. Every line is bounded in bytes before it is parsed. The lifecycle hooks, the Manager's cooperative stop and session calls, and the Hermes Python hooks all move to it. The Hermes bridge adapter now presents a token derived from the key (HMAC-SHA256 over `cotal-hermes-bridge/1`) in place of the key. A client waits at most 1 second for the server's proof, and a server drops a connection that proves nothing within 5 seconds.

The exchange has a version, `CONTROL_PROTOCOL_VERSION` (1), that travels with the key: `LaunchSpec.control` is now `{ path, token, version }`. The key moves to new carrier names: the launch material carries `controlKey` and `controlVersion`, and a hand-driven session sets `COTAL_CONTROL_KEY` and `COTAL_CONTROL_VERSION=1`. A hook or connector from an earlier release finds no key in a new launch and refuses it, and this release refuses the old `controlToken` and `COTAL_CONTROL_TOKEN`. A key without a version, a version a build does not speak, and a peer of another version are all refused, with no fallback. A Claude Code session that reloads its plugin after the upgrade re-reads launch material written before it, which has no version, so it refuses until the session is restarted. `materialEnv` takes `control` (the endpoint) in place of `controlToken`, and `controlEndpoint` takes the launch's artifact list as its third argument.

Off Windows each launch's control socket now sits in a directory of its own, `cotal-ctl-<id>` under the temp directory, named from the key so nobody can plant it first. The server creates it with mode 0700 when it binds and checks its owner and mode, every client checks it before it connects, and the launcher removes it with the launch's other artifacts. A directory that fails the check counts as no endpoint, so a hand-driven `COTAL_CONTROL_SOCKET` must point into a private directory. The Hermes bridge socket moves beside the control socket, and a Hermes adapter whose bridge directory is not private reports a permanent error instead of a connected platform that drops its replies. `@cotal-ai/core` exports the exchange (`clientExchange`, `serverExchange`, `controlCall`, `checkControlSocketDir`, `ensureControlSocketDir`, `assertControlEndpoint`); `tokenMatches`, `AUTH_DEADLINE_MS`, `MAX_FRAME_BYTES` and `HANDOFF_RECEIPT` are no longer exported by `@cotal-ai/connector-core`.
