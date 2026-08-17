# @cotal-ai/pi

## 0.20.0

## 0.19.0

### Minor Changes

- 4e8d776: The `cotal_*` tools now refuse an argument they do not model instead of silently
  dropping it. A call carrying an unmodelled key (`owner` or `actor` alongside the
  real arguments) previously succeeded with that key stripped before the tool ran,
  so the caller was told nothing and the tool did something other than what was
  asked. It is now refused by name, on every adapter and on every tool: the MCP
  renderers and pi publish a closed schema and the host rejects the call, while
  OpenCode and Hermes pass the caller's object through untouched and are closed at
  the connector's own dispatch. Tools that take no arguments are closed too: they
  were previously published with no schema at all, so a host had nothing to check
  against and forwarded the extras to be dropped, as is `cotal_inbox`, whose
  arguments four of the connectors replace with their own. Behaviourally breaking
  for any caller that was relying on extra keys being ignored. Every refusal names
  the rejected keys; where the connector is the one refusing it also lists the
  arguments the tool accepts, or says it takes none.

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

## 0.14.11

## 0.14.10

## 0.14.9

## 0.14.8

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.2

## 0.13.1

## 0.13.0

### Minor Changes

- 5491661: v0.4 endpoint control surface: a breaking wire revision (SPEC section 13).

  Adds the endpoint control surface: the `ep` request rails and grant grammar, the
  message envelope and error catalog, the callable-service verbs, and the session
  and virtual-endpoint composites. Deletes the v0.3 `ctl` rail (the hard cut).
  Requires nats-server 2.12 or newer, since the auth marker store uses native
  per-message TTL; clients read the server version from the pre-auth INFO and fail
  loud below the floor.

  Completes the agent lifecycle end to end: registration, admission, despawn,
  retirement, and safe name reuse, backed by a lifecycle registry, a credential
  ledger, and a retirement barrier. Durables are keyed by lifecycle uid, so a
  manager-resumed agent recovers its original incarnation rather than re-minting,
  and readiness is incarnation-exact. The connectors forward the lifecycle uid into
  spawned children so a child joins as its intended incarnation.

  From v0.4 an AgentCard MUST advertise `protocolVersion "0.4"`; a participant that
  omits it is treated as pre-0.4 and is not addressed on the endpoint rails.

## 0.12.0

## 0.11.6

## 0.11.5

## 0.11.4

### Patch Changes

- 1935221: Ship the built-in agent connectors (claude, opencode, hermes, pi) as removable `cotal ext` plugins. They are seeded on first run through the same `ext add` path a third party uses, resolved lazily per spawn, and deletable with `cotal ext remove`; they are no longer hardcoded imports or dependencies of `cotal-ai`.

## 0.11.3

### Patch Changes

- 1a954e8: Add the Pi host-native connector with confirmed custom-message delivery, cooperative shutdown, and a standalone extension artifact.
  - @cotal-ai/core@0.11.3
  - @cotal-ai/connector-core@0.11.3
