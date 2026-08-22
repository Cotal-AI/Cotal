# Connect pi (alpha)

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

`@cotal-ai/pi` is Cotal's first host-native framework adapter. It loads into the operator's own
[Pi coding agent](https://github.com/earendil-works/pi), rather than bundling a runtime, and uses the
same Cotal subjects, presence, attention, and messaging tools as the app-bound connectors.
Because it runs *inside* the session's process, it is the one connector that can steer a live
turn mid-flight.

**Alpha** means the core path works today (spawn it, load it into your own interactive pi, or
embed it via pi's SDK). Pi session fork/resume and supervised crash recovery are wired; model
variants, MCP sharing, and raw launch options are not and **fail loud** rather than degrade.

## Surfaces

One standalone artifact supports three Pi-hosted surfaces:

1. `cotal spawn --agent pi` launches the installed `pi` binary in the manager's PTY. `--prompt` is
   delivered as Pi's initial message (its first turn); a prompt that is empty or starts with `-` or
   `@` refuses the launch, since Pi would read it as an option or a file reference.
2. Interactive Pi discovers a copied `~/.pi/agent/extensions/cotal.js`.
3. Pi SDK applications using the default resource loader discover that same copy. SDK applications
   must bind Pi's extension lifecycle when they expect an idle session to be driven proactively.

This release pins Pi `0.79.10`. The Cotal package requires Node 22; the separately
installed Pi host requires Node 22.19 or newer.

## Lifecycle

The adapter sends peer traffic as Pi custom messages with `triggerTurn: true` and
`deliverAs: "steer"`. This removes an idle/streaming race while preserving structured batch details.
Reliability uses three distinct points:

1. The matching custom `message_start` proves Pi dequeued the batch locally.
2. A `context` event containing that exact batch proves it entered one provider request.
3. A successful `after_provider_response` proves acceptance early when the transport exposes an HTTP
   response. Some transports, including the Codex subscription, omit that hook; their following clean
   terminal assistant boundary proves acceptance for the exact context instead.

Only provider-confirmed IDs become eligible for acknowledgement, and only at a terminal agent
boundary. The Pi-local ledger commits those IDs through `MeshAgent.drainInboxIds()`, which removes
only exact matches even when quiet ambient is physically interleaved or older IDs were overflow-
evicted. Missing confirmed IDs are marked handled and tombstoned so late copies cannot resurface.

Pi emits `agent_end` to extensions without exposing whether it will retry. Error, abort, unknown
reasons, and zero/missing-output `length` therefore
retain the delivery association in `waiting`; a later `agent_start` proves continuation. Non-aborted
`stop`, `toolUse`, and positive-output `length` are locally provable terminal boundaries and may
commit confirmed work.
`session_before_compact { reason: "overflow", willRetry: true }` identifies the overflow path but is
not itself a terminal decision. User abort is identified from the `AbortSignal` captured while the
turn is active. An abort or dispatch watchdog blocks automatic replay. In managed headless use,
restart is the safe recovery because it terminates any possibly-live provider call before durable
redelivery.

`reload`, `new`, `resume`, and `fork` tear down Pi's extension runtime. The adapter keeps its mesh,
control listener, delivery association, and ordered presence chain in a process-global identity map,
then binds the replacement runtime on its next `session_start`. It also atomically records the new
Pi session id. Only `session_shutdown { reason: "quit" }` stops the mesh.

## Event plane

A seat launched with `cotal spawn --events --agent pi` publishes structured turn events on
`events.<owner>.<actor>`, named from the seat principal. The launcher sets `COTAL_EVENTS` only for
that spawn and supplies its managed workspace root for the write-ahead log; a normal Pi session
publishes no events. The session's durable JSONL records are the event source, so a restarted seat
continues the same ordered stream rather than reopening it. Frames expose their writer `epoch` and
`seq`; assistant messages and tool results carry `messageId`, and tool events carry Pi's native
`toolCallId`. See [Connect Claude Code](connect-claude.md#event-plane) for the shared channel and
access rules.

For managed PTY seats, `cotal spawn --agent pi --resume <pi-session-id>` forks that transcript into
a new meshed Pi session (`pi --fork`; the source is untouched). After readiness, the manager binds
the exact current Pi session through the token-authenticated local control socket. An unexpected Pi
process exit reopens that session with the same Cotal identity, lifecycle UID, credentials and durable
inbox. Three restarts are allowed in a rolling two-minute window; a fourth is a crash loop and retires
the seat loud. A deliberate stop/despawn/maintenance cut never restarts it.

## Host boundaries

- With no mesh identity the extension is inert, even if `COTAL_HOME` or `COTAL_DEFAULT_AGENT` exists.
- A partial managed control endpoint fails loudly; cooperative stop uses connector-core's existing
  authenticated control server and Pi's active `ctx.shutdown()`.
- Peer traffic bypasses Pi's human `input` transformations, but provider, tool, permission, and
  sandbox hooks remain on the normal agent path.
- `cotal_inbox` destructively pulls quiet ambient while the driver retains ownership of automatic
  traffic; normal focus recall shown alongside it remains read-only.
- Pi model variants, MCP sharing, and raw launch options fail loudly until implemented.

## Install

```bash
npm install -g cotal-ai @earendil-works/pi-coding-agent@0.79.10
cotal up
cotal spawn default --detach --agent pi
```

For interactive/default-loader discovery:

```bash
npm install @cotal-ai/pi
mkdir -p ~/.pi/agent/extensions
cp node_modules/@cotal-ai/pi/dist/standalone.js ~/.pi/agent/extensions/cotal.js
```

See [`extensions/pi/README.md`](../extensions/pi/README.md) for the exact delivery policy and
contributor credits.

## See also

- [Connectors](connectors.md): the feature matrix across all connectors
- [Run a mesh](run-a-mesh.md) · [Define a team](define-a-team.md) · [Watch a mesh](watch-a-mesh.md)
- [MCP tools](mcp-tools.md) · [Connect Claude Code](connect-claude.md) · [Connect OpenCode](connect-opencode.md)
