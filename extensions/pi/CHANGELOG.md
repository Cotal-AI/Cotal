# @cotal-ai/pi

## 0.28.0

## 0.27.0

## 0.26.0

### Patch Changes

- 3866fdc: Let already-running managed Pi seats adopt crash recovery after an extension reload. Seats launched before the session-state environment variable existed derive the same lifecycle-keyed state path from their manager-owned persona file and lifecycle UID, then record the active Pi session atomically. Fresh managed seats also receive a Pi-native exact session ID before their first turn, so an idle seat is recoverable.

## 0.25.0

### Minor Changes

- a087c2b: A spawned agent now inherits the operator's environment. A harness you installed and configured
  should behave under `cotal spawn` the way it behaves when you run it yourself, and the alternative
  was Cotal maintaining a list of inference vendors: every new provider needed a change in Cotal
  before it would work through a managed spawn. `MODEL_PROVIDER_KEYS` and the per-connector lists
  that extended it are gone, and Cotal no longer names an inference vendor anywhere in its source.

  Cotal still resets its own `COTAL_*` namespace before the child starts, keeping the machine-wide
  knobs (`COTAL_HOME`, the feedback set, the default-agent pair, the `*_BIN` overrides, the timing
  knobs). That reset is not configurable, because it is identity and not preference: a connector
  supplies the per-session names for each child and does so conditionally, so an inherited value is
  never overwritten and would hand an agent another agent's credential path, ACL, or lifecycle uid.
  The whole prefix is stripped rather than a named list, because which names a connector sets varies
  between connectors and a deny-list only ever names what its author remembered.

  To confine a spawned agent instead, declare `spawn.env` in the cotal config file. The child then
  gets a fixed OS allow-list plus exactly the names you list. An empty array is a real policy meaning
  the OS allow-list alone. Note what this does and does not buy: `HOME` is forwarded either way, so
  an agent with a shell reads `~/.aws` and `~/.ssh` regardless, and this protects only secrets that
  live nowhere but the environment.

- 0b602e4: Managed Pi sessions can now fork an existing Pi transcript into the mesh and recover the exact active Pi session after an unexpected process crash. The Pi adapter reports session changes through its authenticated local control endpoint and an owner-only atomic state file; the manager preserves the Cotal identity, lifecycle UID, credentials, children, and durable inbox across up to three restarts in two minutes, then retires a crash loop loudly. Deliberate stops never restart.
- 34caaf4: Agent seats no longer export their connection material into the environment every descendant
  process inherits. The broker URL, the creds path, the auth token, the user-mode identity and the
  local control token now ride a private 0600 launch-material file whose path is the only thing in the
  seat's environment; pi, codex and OpenCode drop even that path once they have read it (for OpenCode
  that happens in the `opencode serve` process its seat shim starts, which is also what runs the
  session's tool calls), while claude and hermes keep the reference because their readers are
  short-lived children that start later. A session driven by hand still sets `COTAL_CREDS` / `COTAL_SERVERS` itself, and a
  launch that carries both carriers is refused rather than resolved by precedence.

### Patch Changes

- bf07e45: Wrap visible Cotal inbox and tool text by terminal columns instead of JavaScript string length. Emoji and CJK text can occupy two terminal cells per code point; a peer status line containing two check marks was emitted at 122 cells in a 120-column Pi TUI and terminated the process. The Pi adapter now uses the host's canonical ANSI/grapheme-aware wrapper, with a regression fixture from the live crash.

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

### Patch Changes

- 219d33c: `cotal spawn --agent pi --prompt <text>` now delivers the prompt as Pi's initial message (its first turn) instead of silently dropping it; an empty prompt, or one starting with `-` or `@`, refuses the launch. The connector contract no longer describes an initial prompt as something a connector may ignore: a connector delivers it or throws at launch. The other connectors follow the same rule: Claude Code and Codex refuse a prompt that is empty after trimming instead of dropping it, and Hermes refuses an initial prompt outright until its first turn is wired.

## 0.20.1

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
