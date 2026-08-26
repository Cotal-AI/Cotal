# @cotal-ai/pi

## 0.33.1

## 0.33.0

### Minor Changes

- ba74c84: An agent now reads only the channels it lists. An omitted or empty read set means **no channels**,
  where it previously meant `general`: the agent-file loader, the provisioner, the credential mint and
  the endpoint each defaulted an absent read set to `["general"]`, so any persona that simply did not
  mention channels was subscribed to `general` by code and had the matching channel read row baked
  into its credential.

  An agent on no channel is still a full mesh peer: it appears on the roster and sends and receives
  DMs and anycasts, and the same default-deny that already governed `allowPublish` now governs reads.
  An empty list and an omitted one mean the same thing, for both read keys. That has one consequence
  worth stating plainly: when **both** are omitted, `allowSubscribe` falls back to the read set and so
  resolves empty too, which leaves the agent unable to `cotal_join` a channel at runtime. Give it an
  explicit `allowSubscribe` if it should be able to join one later.

  With no concrete channel there is no default broadcast target, so a send with no explicit channel is
  refused with a message saying so, rather than resolving to `general`. Leaving your last channel is
  allowed and always was; the `cotal_leave` description said otherwise and now says what actually
  happens, including that the default send channel is gone until you join one.

  Migration: **list `general` explicitly if you want it.** A hand-written persona that relied on the
  old default needs `subscribe: [general]` added.

  This changes the default `cotal setup` install as well. The seeded `default_agent` carries
  `subscribe: []`, which used to resolve to `general` and now resolves to no channel; it keeps
  `allowSubscribe: [">"]`, so it can still `cotal_join` anything, it just no longer arrives on a
  channel it never asked for — which is what its own seed comment already described.

  Already-running agents are not narrowed retroactively: a live seat keeps the read ACL its credential
  was minted with, across renewal, until it is respawned.

## 0.32.0

## 0.31.0

### Minor Changes

- 4ef59c3: A spawned seat now receives a constructed environment (PATH/HOME/locale, the machine-wide COTAL\_\* knobs, connector-declared provider keys) instead of the manager's ambient environment. Host-session markers such as CLAUDE_CODE_CHILD_SESSION no longer leak into seats and silently disable transcript saving. The Claude connector declares CLAUDE_CODE_OAUTH_TOKEN (and the rest of claude's documented credential set) so a container seat still authenticates; spawn.env remains the explicit opt-in for extra names, including a host marker a persona has chosen to receive.

## 0.30.2

## 0.30.1

## 0.30.0

### Minor Changes

- 569f4d3: An empty message id is never a dedup key, and an id-less delivery is individually addressable at the drain seam.

  Two distinct messages that each carry an empty id collapsed to one: the receiver-side id
  dedup read empty-equals-empty as a duplicate, silently dropped the second, and once the
  first was handled it dropped every later empty-id message on arrival. Measured live, two
  such messages arrived on the wire and only the first was ever delivered.

  An empty id is now treated as no id: the ingest coalescing (pending, handled, protected)
  is skipped for it in both directions, so distinct messages that carry an empty id are all
  delivered. At the drain seam a per-delivery receive key (the wire id when there is one, a
  per-session secret-namespaced minted key when the id is empty, never on any wire) is what
  hosts, adapters, and the exact-key drain select by: cotal_inbox, the Claude Code hooks,
  the OpenCode plugin, the Codex host, the Hermes bridge and its Python sidecar, and the pi
  driver. The drain API is renamed for what it takes (drainInboxDeliveries, missingKeys).
  Eviction classification, in-flight holds, scope routing, the focus-recall tie-break, and
  the scoped drain's selection no longer key on the empty id either. The Hermes bridge no
  longer wedges on an empty-id message. Delivery pumps in core now treat an absent or
  non-string id as a malformed envelope per SPEC section 5 (durable terminate, live drop,
  history and recall skip).

  What this restores: before the receive key, an id-less delivery was unaddressable: the
  raw id swept every pending empty-id item in one drain call, and once filtering closed
  that, the item could never be drained or acked, was re-shown on every windowed inbox
  read, and on a durable channel accumulated as an unretirable entry until the 200-entry
  overflow valve evicted it, roughly a model turn of churn per entry, while one hostile
  empty-id ambient publish self-drove back-to-back host turns on the pi adapter. This was
  a violation of the SPEC section 8 ack-only-after-surfaced obligation at the receiver,
  not only an adapter defect.

  The cost is stated rather than hidden: with no id there is no coalescing either, so a
  redelivered copy of an empty-id message can surface twice on a path that is already
  at-least-once (live remains at-most-once). Dedup for real ids is unchanged: their
  receive key is their wire id and their coalescing is untouched. SPEC section 4, section
  7 item 5, section 8, and section 12 item 12 now state the receiver-scoped rule, and the
  client-builder guidance mirrors it.

  One named follow-up stays open: Plane-3 durable fan-out derives its publish msgID from
  the message id, so distinct empty-id messages can still be collapsed inside the broker's
  duplicate window on a durable channel before this receiver sees them. That path is its
  own issue; this change's guarantee is the receiver.

## 0.29.2

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

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
